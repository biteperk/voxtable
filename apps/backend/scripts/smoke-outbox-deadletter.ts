/**
 * Outbox dead-letter smoke — the retry policy's throw path (audit B11).
 *
 * The transient-RETURN path always had a CALCOM_OUTBOX_MAX_ATTEMPTS ceiling;
 * the THROW path had none, so a row whose executor threw retried forever.
 * Worse: a thrown Postgres error aborted the batch transaction, which made
 * the catch's own markOutboxRetry fail, rolled back the attempts bump, and
 * re-claimed the identical row every 2-second tick — no backoff, no counter,
 * no dead-letter, invisible to the failed_at alert.
 *
 * Drives the REAL processBatch against a live Postgres with injected
 * executors. No Cal.com credentials touched.
 *
 *   npm run smoke:outbox-deadletter
 */
import { env } from "../src/config/env";
import { pool } from "../src/db/pool";
import {
  processOutboxBatchOnce,
  setOutboxExecutor
} from "../src/workers/calcomOutboxWorker";
import {
  assert,
  cleanupSmokeRestaurant,
  reportAndExit,
  SMOKE_SUFFIX as SUFFIX
} from "./lib/smoke-harness";

interface OutboxState {
  attempts: number;
  failed_at: string | null;
  next_attempt_at: string;
  last_error: string | null;
}

async function outboxState(id: string): Promise<OutboxState> {
  const r = await pool.query<OutboxState>(
    "SELECT attempts, failed_at::text, next_attempt_at::text, last_error FROM outbox_calcom WHERE id = $1",
    [id]
  );
  return r.rows[0]!;
}

async function insertRow(reservationId: string, attempts: number): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO outbox_calcom (reservation_id, op, payload, attempts)
     VALUES ($1, 'create', '{}'::jsonb, $2) RETURNING id`,
    [reservationId, attempts]
  );
  return r.rows[0]!.id;
}

async function setup(): Promise<{ restaurantId: string; reservationId: string }> {
  const restaurant = await pool.query<{ id: string }>(
    `INSERT INTO restaurants (name, timezone, phone_number)
     VALUES ($1, 'Australia/Sydney', '+61255500098') RETURNING id`,
    [`smoke-deadletter-${SUFFIX}`]
  );
  const restaurantId = restaurant.rows[0]!.id;
  const customer = await pool.query<{ id: string }>(
    `INSERT INTO customers (restaurant_id, name, phone)
     VALUES ($1, 'Dead Letter', '+61255511098') RETURNING id`,
    [restaurantId]
  );
  const reservation = await pool.query<{ id: string }>(
    `INSERT INTO reservations (restaurant_id, customer_id, reservation_date, start_time, party_size, status, source)
     VALUES ($1, $2, (now() + interval '30 days')::date, '18:00', 2, 'confirmed', 'voice') RETURNING id`,
    [restaurantId, customer.rows[0]!.id]
  );
  return { restaurantId, reservationId: reservation.rows[0]!.id };
}

async function main(): Promise<void> {
  const { restaurantId, reservationId } = await setup();
  try {
    // ---- 1: a throwing executor still hits the attempts ceiling ----------
    const atCeiling = await insertRow(reservationId, env.CALCOM_OUTBOX_MAX_ATTEMPTS - 1);
    setOutboxExecutor({
      async execute() {
        throw new Error("permanent-by-nature failure (e.g. malformed date)");
      }
    });
    await processOutboxBatchOnce();
    const s1 = await outboxState(atCeiling);
    assert(
      "a throwing row dead-letters at the ceiling (old code: retried hourly forever)",
      s1.failed_at !== null,
      { attempts: s1.attempts, failed_at: s1.failed_at }
    );

    // ---- 2: below the ceiling, a throw is a counted, backed-off retry ----
    const belowCeiling = await insertRow(reservationId, 0);
    await processOutboxBatchOnce();
    const s2 = await outboxState(belowCeiling);
    assert("below the ceiling, the throw is recorded as a retry", s2.failed_at === null && s2.attempts === 1, s2);
    assert(
      "the retry is scheduled with backoff, not immediately",
      new Date(s2.next_attempt_at).getTime() > Date.now() + 30_000
    );

    // ---- 3: a Postgres error inside the executor no longer wedges the row -
    // The executor aborts the batch transaction itself. Old code: the catch's
    // markOutboxRetry failed on the aborted txn, the outer ROLLBACK undid the
    // attempts bump, and the row was re-claimed unchanged every tick forever.
    // The per-row SAVEPOINT restores a usable txn so the retry is recorded.
    const pgAbort = await insertRow(reservationId, 0);
    setOutboxExecutor({
      async execute(_row, db) {
        await db.query("SELECT * FROM this_table_does_not_exist_xyz");
        return { outcome: "succeeded" as const };
      }
    });
    await processOutboxBatchOnce();
    const s3 = await outboxState(pgAbort);
    assert(
      "a txn-aborting throw still increments attempts (old code: rolled back to 0, infinite 2s loop)",
      s3.attempts === 1 && s3.failed_at === null,
      s3
    );
  } finally {
    await cleanupSmokeRestaurant(restaurantId);
    await pool.end();
  }

  reportAndExit("outbox dead-letter");
}

void main().catch((error) => {
  console.error("smoke-outbox-deadletter crashed:", error);
  process.exit(1);
});
