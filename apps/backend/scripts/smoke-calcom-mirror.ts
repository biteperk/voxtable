/**
 * Cal.com mirror smoke test — the three ways the calendar mirror silently
 * diverged from the database (audit findings B4, B5, B15, fixed 3 Aug 2026):
 *
 *   B4  — modifyBooking never enqueued ANY outbox work, so a moved booking
 *         never propagated, and a dashboard cancel via PATCH status skipped
 *         the mirror entirely.
 *   B5  — a cancel within one worker tick of the create snapshotted a NULL
 *         uid, declared "nothing to cancel — succeeded", and the create then
 *         pushed anyway: a permanent ghost booking on Cal.com.
 *   B15 — the inbound reconciler matched on nothing but "exactly one pending
 *         create row", so a stranger's web booking could be stamped onto a
 *         voice reservation — and the stranger's later cancellation cancelled
 *         the voice caller's table.
 *
 * Exercises the REAL bookingService + the REAL outbox executor against a
 * migrated Postgres. Every asserted path short-circuits before any network
 * call, so no Cal.com credentials are needed and nothing external is touched.
 * Run with CALCOM_SYNC_ENABLED=true (the npm script sets it).
 *
 *   npm run smoke:calcom-mirror
 */
import { pool } from "../src/db/pool";
import { markOutboxSucceeded } from "../src/repositories/outbox";
import { cancelBooking, createBooking, modifyBooking } from "../src/services/bookingService";
import { calcomOutboxExecutor, reconcileMirroredBooking } from "../src/services/calcomService";
import {
  assert,
  cleanupSmokeRestaurant,
  createSmokeRestaurant,
  reportAndExit,
  SMOKE_DATE,
  SMOKE_SUFFIX
} from "./lib/smoke-harness";

interface OutboxRowLite {
  id: string;
  op: string;
  payload: Record<string, unknown>;
  attempts: number;
  succeeded_at: string | null;
  failed_at: string | null;
}

async function outboxRows(reservationId: string): Promise<OutboxRowLite[]> {
  const result = await pool.query<OutboxRowLite>(
    `SELECT id, op, payload, attempts, succeeded_at, failed_at
       FROM outbox_calcom WHERE reservation_id = $1 ORDER BY created_at`,
    [reservationId]
  );
  return result.rows;
}

async function reservationUid(reservationId: string): Promise<string | null> {
  const result = await pool.query<{ calcom_booking_uid: string | null }>(
    "SELECT calcom_booking_uid FROM reservations WHERE id = $1",
    [reservationId]
  );
  return result.rows[0]?.calcom_booking_uid ?? null;
}

function executorRow(row: OutboxRowLite, reservationId: string) {
  return {
    id: row.id,
    reservation_id: reservationId,
    op: row.op as "create" | "cancel" | "reschedule",
    payload: row.payload,
    attempts: row.attempts
  };
}

function book(restaurantId: string, time: string, phone: string) {
  return createBooking({
    restaurantId,
    customerName: `Mirror ${time}`,
    customerPhone: phone,
    date: SMOKE_DATE,
    time,
    partySize: 2,
    source: "voice"
  });
}

async function main(): Promise<void> {
  if (process.env.CALCOM_SYNC_ENABLED !== "true") {
    console.error("CALCOM_SYNC_ENABLED=true is required (the npm script sets it).");
    process.exit(1);
  }

  // Several tables so the scenarios don't contend for capacity.
  const { restaurantId } = await createSmokeRestaurant({
    name: `smoke-calcom-mirror-${SMOKE_SUFFIX}`,
    phoneNumber: "+61255500099",
    tables: [
      { label: "T1", minCapacity: 1, maxCapacity: 4 },
      { label: "T2", minCapacity: 1, maxCapacity: 4 },
      { label: "T3", minCapacity: 1, maxCapacity: 4 },
      { label: "T4", minCapacity: 1, maxCapacity: 4 }
    ]
  });

  try {
    // ---- B4a: a moved booking enqueues a reschedule op --------------------
    const moved = await book(restaurantId, "12:00", "+61255511001");
    await modifyBooking({ bookingId: moved.bookingId, time: "13:00", restaurantId });
    const movedRows = await outboxRows(moved.bookingId);
    assert(
      "B4: time change enqueues a reschedule op",
      movedRows.some((r) => r.op === "reschedule"),
      movedRows.map((r) => r.op)
    );

    // Second move must de-dup onto the same pending row, not stack a second.
    await modifyBooking({ bookingId: moved.bookingId, time: "14:00", restaurantId });
    const movedAgain = (await outboxRows(moved.bookingId)).filter((r) => r.op === "reschedule");
    assert("B4: a second move de-dups onto the pending reschedule row", movedAgain.length === 1);

    // ---- B4b: dashboard cancel via PATCH status enqueues a cancel op ------
    const patched = await book(restaurantId, "15:00", "+61255511002");
    await modifyBooking({ bookingId: patched.bookingId, status: "cancelled", restaurantId });
    const patchedRows = await outboxRows(patched.bookingId);
    assert(
      "B4: PATCH status=cancelled enqueues a cancel op",
      patchedRows.some((r) => r.op === "cancel"),
      patchedRows.map((r) => r.op)
    );

    // ---- B5: cancel racing create no longer succeeds into a ghost ---------
    const ghost = await book(restaurantId, "17:00", "+61255511003");
    await cancelBooking({ bookingId: ghost.bookingId, restaurantId });
    const ghostRows = await outboxRows(ghost.bookingId);
    const createRow = ghostRows.find((r) => r.op === "create")!;
    const cancelRow = ghostRows.find((r) => r.op === "cancel")!;
    assert("B5: create + cancel rows coexist before any worker tick", Boolean(createRow && cancelRow));

    // Cancel processed FIRST (the losing order on old code): must be
    // transient, never "succeeded" — the create is still pending.
    const cancelFirst = await calcomOutboxExecutor.execute(executorRow(cancelRow, ghost.bookingId), pool);
    assert(
      "B5: cancel before create resolves → transient (old code: succeeded, ghost born)",
      cancelFirst.outcome === "transient",
      cancelFirst
    );

    // Create processed next: reservation is cancelled → must NOT push.
    // Success here proves the short-circuit fired (a real push attempt would
    // have failed loudly with no Cal.com credentials configured).
    const createAfterCancel = await calcomOutboxExecutor.execute(executorRow(createRow, ghost.bookingId), pool);
    assert(
      "B5: create for a cancelled reservation → no-op success, nothing pushed",
      createAfterCancel.outcome === "succeeded",
      createAfterCancel
    );
    assert("B5: no uid was ever attached", (await reservationUid(ghost.bookingId)) === null);

    // Once the create row is terminal, the retried cancel resolves clean.
    await markOutboxSucceeded(createRow.id);
    const cancelRetry = await calcomOutboxExecutor.execute(executorRow(cancelRow, ghost.bookingId), pool);
    assert(
      "B5: cancel retry after create resolves → succeeded (converged, no ghost)",
      cancelRetry.outcome === "succeeded",
      cancelRetry
    );

    // ---- B15: reconciliation is by our stamped metadata, nothing else -----
    const voice = await book(restaurantId, "19:00", "+61255511004");
    // A stranger's web booking (no vocotable metadata) arrives while the
    // voice create is still pending — the exact old-bug window.
    const strangers = await reconcileMirroredBooking(undefined, `uid-stranger-${SMOKE_SUFFIX}`);
    assert("B15: webhook without our metadata is NOT reconciled (old code: stamped it)", strangers === false);
    assert("B15: the voice reservation was not stamped with the stranger's uid",
      (await reservationUid(voice.bookingId)) === null);

    // Our own echo (metadata carries the reservation id) reconciles precisely.
    const ours = await reconcileMirroredBooking(
      { vocotable_reservation_id: voice.bookingId },
      `uid-ours-${SMOKE_SUFFIX}`
    );
    assert("B15: our own echo reconciles by reservation id", ours === true);
    assert("B15: the uid landed on exactly the intended reservation",
      (await reservationUid(voice.bookingId)) === `uid-ours-${SMOKE_SUFFIX}`);

    // Replay of the same echo is an idempotent skip, still claimed as ours.
    const replay = await reconcileMirroredBooking(
      { vocotable_reservation_id: voice.bookingId },
      `uid-ours-${SMOKE_SUFFIX}`
    );
    assert("B15: replayed echo is claimed (idempotent), never a web booking", replay === true);
  } finally {
    await cleanupSmokeRestaurant(restaurantId);
    await pool.end();
  }

  reportAndExit("Cal.com mirror");
}

void main().catch((error) => {
  console.error("smoke-calcom-mirror crashed:", error);
  process.exit(1);
});
