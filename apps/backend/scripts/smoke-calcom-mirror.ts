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

async function reservationCount(restaurantId: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM reservations WHERE restaurant_id = $1",
    [restaurantId]
  );
  return Number(r.rows[0]!.n);
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

  // Migration 035: a venue is mirrored to Cal.com only while it holds an event
  // type. Derived from the pid so concurrent smoke runs can't collide on the
  // partial unique index.
  const eventTypeId = 900_000 + (process.pid % 90_000);
  await pool.query("UPDATE restaurants SET calcom_event_type_id = $2 WHERE id = $1", [
    restaurantId,
    eventTypeId
  ]);

  // A second venue that is deliberately NOT bound to Cal.com — most venues are
  // voice-only, and that must be free.
  const { restaurantId: unboundId } = await createSmokeRestaurant({
    name: `smoke-calcom-unbound-${SMOKE_SUFFIX}`,
    phoneNumber: "+61255500098",
    tables: [
      { label: "U1", minCapacity: 1, maxCapacity: 4 },
      { label: "U2", minCapacity: 1, maxCapacity: 4 }
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
      { voxtable_reservation_id: voice.bookingId },
      `uid-ours-${SMOKE_SUFFIX}`
    );
    assert("B15: our own echo reconciles by reservation id", ours === true);
    assert("B15: the uid landed on exactly the intended reservation",
      (await reservationUid(voice.bookingId)) === `uid-ours-${SMOKE_SUFFIX}`);

    // Replay of the same echo is an idempotent skip, still claimed as ours.
    const replay = await reconcileMirroredBooking(
      { voxtable_reservation_id: voice.bookingId },
      `uid-ours-${SMOKE_SUFFIX}`
    );
    assert("B15: replayed echo is claimed (idempotent), never a web booking", replay === true);

    // A booking pushed BEFORE the vocotable -> voxtable rename carries the legacy
    // key. It must still be recognised as ours: those bookings live in Cal.com and
    // can be cancelled or rescheduled at any future date. Reading only the new key
    // would send them down the genuine-web-booking path and phantom a reservation.
    const legacyEcho = await reconcileMirroredBooking(
      { vocotable_reservation_id: voice.bookingId },
      `uid-legacy-${SMOKE_SUFFIX}`
    );
    assert("rename: an echo carrying the LEGACY metadata key is still ours", legacyEcho === true);

    // ---- 035: a venue with no Cal.com event type is not mirrored ----------
    //
    // The gate has to be at ENQUEUE, not at push. An outbox row written for an
    // unbound venue can only ever dead-letter, healthAlerter pages Slack at a
    // dead-letter threshold of zero, and those failed rows are never swept — so
    // "this venue is voice-only" would present as a permanent, growing incident.
    const unbound = await book(unboundId, "18:00", "+61255511009");
    assert(
      "035: an unbound venue enqueues NO outbox row",
      (await outboxRows(unbound.bookingId)).length === 0,
      await outboxRows(unbound.bookingId)
    );

    // The asymmetry that keeps unbinding safe: cancelling a booking that is
    // already live on Cal.com must still push, or the per-venue kill switch
    // would strand it as an uncancellable ghost holding public availability.
    // Bind, book, unbind, then cancel — the cancel gates on the reservation's
    // uid, never on the venue's current binding.
    await pool.query("UPDATE restaurants SET calcom_event_type_id = $2 WHERE id = $1", [
      unboundId,
      eventTypeId + 1
    ]);
    const stranded = await book(unboundId, "19:00", "+61255511010");
    await pool.query("UPDATE reservations SET calcom_booking_uid = $2 WHERE id = $1", [
      stranded.bookingId,
      `uid-stranded-${SMOKE_SUFFIX}`
    ]);
    await pool.query("UPDATE restaurants SET calcom_event_type_id = NULL WHERE id = $1", [
      unboundId
    ]);
    await cancelBooking({ bookingId: stranded.bookingId, restaurantId: unboundId });
    assert(
      "035: unbinding a venue still lets its live bookings be cancelled",
      (await outboxRows(stranded.bookingId)).some((r) => r.op === "cancel"),
      (await outboxRows(stranded.bookingId)).map((r) => r.op)
    );

    // ---- 035: a tenant mismatch must never create a booking ---------------
    //
    // An event type rebound from venue A to venue B while a push for an A
    // booking was in flight. The echo carries A's reservation id; the event type
    // now resolves to B. This used to `return false`, which fell through to the
    // web-booking path and created a PHANTOM reservation at B — the voice
    // caller's name and party size, occupying one of B's tables — while A's
    // reservation never got its uid, so its cancel never mirrored.
    const beforeMismatch = await reservationCount(unboundId);
    let mismatchThrew = false;
    try {
      await reconcileMirroredBooking(
        { voxtable_reservation_id: voice.bookingId },
        `uid-mismatch-${SMOKE_SUFFIX}`,
        unboundId // resolved venue differs from the reservation's venue
      );
    } catch {
      mismatchThrew = true;
    }
    assert("035: a tenant mismatch is terminal, not a fall-through", mismatchThrew);
    assert(
      "035: a tenant mismatch creates NO reservation at the resolved venue",
      (await reservationCount(unboundId)) === beforeMismatch
    );
  } finally {
    await cleanupSmokeRestaurant(restaurantId);
    await cleanupSmokeRestaurant(unboundId);
    await pool.end();
  }

  reportAndExit("Cal.com mirror");
}

void main().catch((error) => {
  console.error("smoke-calcom-mirror crashed:", error);
  process.exit(1);
});
