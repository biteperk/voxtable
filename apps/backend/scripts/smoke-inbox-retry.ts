/**
 * Inbox retry smoke — the gap that made an inbound booking loss permanent.
 *
 * `/cal/webhook` persists every event, processes it inline, and answers 200 on
 * failure (a 5xx would make Cal.com retry forever). The repository function
 * meant to pick those failures back up — claimUnprocessedInbox — had ZERO
 * callers from migration 004 until this worker was built, and cleanupWorker
 * carried a comment saying exactly that. So a booking lost to a lock wait or a
 * pool timeout was lost: we did not retry it, and neither did Cal.com.
 *
 * Drives the REAL processBatch against a live Postgres with an injected
 * processor, the way the outbox dead-letter smoke drives the real batch with an
 * injected executor — the retry policy is the part that goes wrong, and every
 * failure mode of the real handler cannot be reached without a network.
 *
 *   npm run smoke:inbox-retry
 */
import { env } from "../src/config/env";
import { pool } from "../src/db/pool";
import { PermanentInboxError } from "../src/domain/errors";
import { processInboxBatchOnce, setInboxProcessor } from "../src/workers/calcomInboxWorker";
import { assert, reportAndExit, SMOKE_SUFFIX as SUFFIX } from "./lib/smoke-harness";

interface InboxState {
  attempts: number;
  processed_at: string | null;
  failed_at: string | null;
  next_attempt_at: string;
  process_error: string | null;
}

async function stateOf(eventId: string): Promise<InboxState> {
  const r = await pool.query<InboxState>(
    `SELECT attempts, processed_at::text, failed_at::text,
            next_attempt_at::text, process_error
       FROM inbox_calcom_events WHERE event_id = $1`,
    [eventId]
  );
  return r.rows[0]!;
}

async function insertEvent(key: string, attempts: number): Promise<string> {
  const eventId = `smoke-inbox-${key}-${SUFFIX}`;
  const envelope = {
    triggerEvent: "BOOKING_RESCHEDULED",
    createdAt: new Date().toISOString(),
    payload: { uid: `smoke-uid-${key}-${SUFFIX}`, startTime: "2027-06-01T09:00:00.000Z" }
  };
  await pool.query(
    `INSERT INTO inbox_calcom_events
       (event_id, trigger_event, raw_payload, attempts, next_attempt_at)
     VALUES ($1, $2, $3::jsonb, $4, now() - INTERVAL '1 minute')`,
    [eventId, envelope.triggerEvent, JSON.stringify(envelope), attempts]
  );
  return eventId;
}

async function main(): Promise<void> {
  if (process.env.CALCOM_SYNC_ENABLED !== "true") {
    console.error("CALCOM_SYNC_ENABLED=true is required (the npm script sets it).");
    process.exit(1);
  }

  const ids: string[] = [];
  const original = setInboxProcessor(async () => {});
  try {
    // ---- a transient failure below the ceiling is retried, with backoff ----
    // A lock wait or an exhausted pool: it says nothing about the booking and
    // will very likely succeed next time.
    setInboxProcessor(async () => {
      throw new Error("simulated lock wait");
    });

    const retrying = await insertEvent("retry", 0);
    ids.push(retrying);
    await processInboxBatchOnce();
    const afterOne = await stateOf(retrying);
    assert(
      "a transient failure records an attempt instead of being stranded",
      afterOne.attempts === 1 && afterOne.failed_at === null,
      afterOne
    );
    assert(
      "the retry is scheduled with backoff, not immediately",
      new Date(afterOne.next_attempt_at).getTime() > Date.now() + 30_000,
      afterOne.next_attempt_at
    );
    assert("the failure reason is kept for ops", Boolean(afterOne.process_error));

    // Backoff must actually hold the row back — otherwise a repeatedly failing
    // event spins on every tick.
    await processInboxBatchOnce();
    assert(
      "a row inside its backoff is NOT re-claimed on the next tick",
      (await stateOf(retrying)).attempts === 1
    );

    // ---- at the ceiling, a transient failure dead-letters ------------------
    const doomed = await insertEvent("doomed", env.CALCOM_INBOX_MAX_ATTEMPTS - 1);
    ids.push(doomed);
    await processInboxBatchOnce();
    const dead = await stateOf(doomed);
    assert(
      "at the attempts ceiling the event dead-letters",
      dead.failed_at !== null && dead.attempts === env.CALCOM_INBOX_MAX_ATTEMPTS,
      dead
    );

    // A dead letter is evidence, not work. If it stayed claimable it would burn
    // a batch slot every tick forever.
    await processInboxBatchOnce();
    assert(
      "a dead-lettered event is never claimed again",
      (await stateOf(doomed)).attempts === env.CALCOM_INBOX_MAX_ATTEMPTS
    );

    // ---- a permanent failure dead-letters on the FIRST attempt -------------
    // This is the one that matters most. A refusal has already cancelled the
    // booking back on Cal.com, so retrying it would create a reservation for a
    // booking the guest has been told is off — and each retry would re-issue
    // the cancel-back call.
    setInboxProcessor(async () => {
      throw new PermanentInboxError("no table available");
    });

    const refused = await insertEvent("refused", 0);
    ids.push(refused);
    await processInboxBatchOnce();
    const refusedState = await stateOf(refused);
    assert(
      "a permanent failure dead-letters immediately, without burning the ceiling",
      refusedState.failed_at !== null && refusedState.attempts === 1,
      refusedState
    );
    assert(
      "the dead-letter reason says it was not retryable, not that attempts ran out",
      (refusedState.process_error ?? "").startsWith("Not retryable:"),
      refusedState.process_error
    );

    // ---- a retry that succeeds settles the row ------------------------------
    setInboxProcessor(async () => {});
    const recovering = await insertEvent("recovers", 2);
    ids.push(recovering);
    await processInboxBatchOnce();
    const settled = await stateOf(recovering);
    assert(
      "a later attempt that succeeds marks the event processed",
      settled.processed_at !== null && settled.failed_at === null,
      settled
    );
    assert("a successful retry clears the stale error", settled.process_error === null);
  } finally {
    setInboxProcessor(original);
    if (ids.length > 0) {
      await pool.query("DELETE FROM inbox_calcom_events WHERE event_id = ANY($1)", [ids]);
    }
    await pool.end();
  }

  reportAndExit("Cal.com inbox retry");
}

void main();
