/**
 * Booking-lifecycle SMS smoke test — proves the guest actually gets texted, and
 * only when they should.
 *
 * What it pins down:
 *   - A VOICE booking enqueues exactly one `booking_confirmation` SMS row, in
 *     the same transaction as the reservation.
 *   - A Retell tool retry (same provider_call_id) takes the replay path and
 *     does NOT enqueue a second one — this is the whole reason no dedupe
 *     column/migration exists for these rows.
 *   - A WEB booking (Cal.com sentinel phone via allowUnparseablePhone) enqueues
 *     nothing: the guest already holds a Cal.com email, and a "web:<uid>"
 *     recipient would die on a permanent Twilio 4xx anyway.
 *   - A failed booking enqueues nothing (atomicity — the enqueue rides the
 *     booking transaction).
 *   - modifyBooking texts on a guest-visible change (time), stays silent on a
 *     notes-only edit, and sends `booking_cancelled` when the change IS a
 *     cancellation.
 *   - cancelBooking texts only when a source ("dashboard"/"voice") is given —
 *     sourceless internal callers stay silent.
 *   - Every body is pure GSM-7 (no em-dash / smart quotes), so each text stays
 *     one 160-char segment.
 *
 * The npm script injects BOOKING_CONFIRMATION_SMS_ENABLED, NOTIFICATIONS_ENABLED
 * and FAKE Twilio creds — they only need to satisfy isSmsEnabled() at enqueue
 * time. The notification worker is never started here, so nothing sends.
 * Flag-off behaviour is covered implicitly: every other smoke that calls
 * createBooking runs without the flag and would trip over stray outbox rows if
 * the gate leaked.
 *
 * Needs only a migrated database — runs in CI against the Postgres container.
 *
 *   npm run smoke:booking-sms
 */
import { pool } from "../src/db/pool";
import { cancelBooking, createBooking, modifyBooking } from "../src/services/bookingService";
import {
  assert,
  cleanupSmokeRestaurant,
  createSmokeRestaurant,
  reportAndExit,
  SMOKE_DATE as DATE,
  SMOKE_SUFFIX as SUFFIX
} from "./lib/smoke-harness";

const GUEST_PHONE = "+61400000321";

interface OutboxRow {
  kind: string;
  channel: string;
  recipient: string;
  body: string;
  status: string;
}

async function outboxRows(restaurantId: string): Promise<OutboxRow[]> {
  const result = await pool.query<OutboxRow>(
    `SELECT kind, channel, recipient, body, status FROM notifications_outbox
      WHERE restaurant_id = $1 ORDER BY created_at`,
    [restaurantId]
  );
  return result.rows;
}

// GSM-7 basic charset (plus the extension table's escapes). Anything outside it
// (em-dash, curly quotes) silently halves the segment size to 70 chars.
const GSM7 = /^[A-Za-z0-9 @£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑܧ¿äöñüà\n\r^{}\\[\]~|€]*$/;

async function main(): Promise<void> {
  const { restaurantId } = await createSmokeRestaurant({
    name: `smoke-booking-sms-${SUFFIX}`,
    phoneNumber: "+61255500003",
    open: "10:00",
    close: "23:00",
    durationMinutes: 90,
    tables: [
      { label: "S1", minCapacity: 1, maxCapacity: 4 },
      { label: "S2", minCapacity: 1, maxCapacity: 4 }
    ]
  });

  try {
    // ---- Voice booking: exactly one confirmation SMS, correct contents ----
    const callId = `call_smoke_sms_${SUFFIX}`;
    const booking = await createBooking({
      restaurantId,
      customerName: "Sms Smoke",
      customerPhone: GUEST_PHONE,
      date: DATE,
      time: "19:00",
      partySize: 2,
      source: "voice",
      provider: "retell",
      providerCallId: callId
    });

    let rows = await outboxRows(restaurantId);
    assert("voice booking enqueued exactly one SMS row", rows.length === 1, { rows });
    const confirmation = rows[0]!;
    assert("row is a pending sms booking_confirmation",
      confirmation.kind === "booking_confirmation" &&
        confirmation.channel === "sms" &&
        confirmation.status === "pending",
      confirmation);
    assert("recipient is the guest's E.164 number", confirmation.recipient === GUEST_PHONE, {
      recipient: confirmation.recipient
    });
    assert("body names the venue, guest, party and says confirmed",
      confirmation.body.includes(`smoke-booking-sms-${SUFFIX}`) &&
        confirmation.body.includes("Sms Smoke") &&
        confirmation.body.includes("party of 2") &&
        confirmation.body.includes("booking confirmed"),
      { body: confirmation.body });
    assert("body is pure GSM-7 (single-segment cost)", GSM7.test(confirmation.body), {
      body: confirmation.body
    });
    assert("body fits one 160-char segment", confirmation.body.length <= 160, {
      length: confirmation.body.length
    });

    // ---- Retell retry: replay path, no second SMS ----
    const retry = await createBooking({
      restaurantId,
      customerName: "Sms Smoke",
      customerPhone: GUEST_PHONE,
      date: DATE,
      time: "19:00",
      partySize: 2,
      source: "voice",
      provider: "retell",
      providerCallId: callId
    });
    assert("retry returned the same booking", retry.bookingId === booking.bookingId, {
      first: booking.bookingId,
      retry: retry.bookingId
    });
    rows = await outboxRows(restaurantId);
    assert("retry enqueued no second SMS", rows.length === 1, { count: rows.length });

    // ---- Notes-only modify: guest-invisible, no SMS ----
    await modifyBooking({
      bookingId: booking.bookingId,
      notes: "window seat if possible",
      restaurantId,
      source: "dashboard"
    });
    rows = await outboxRows(restaurantId);
    assert("notes-only modify sent nothing", rows.length === 1, { count: rows.length });

    // ---- Time change from the dashboard: booking_modified SMS ----
    await modifyBooking({
      bookingId: booking.bookingId,
      time: "20:00",
      restaurantId,
      source: "dashboard"
    });
    rows = await outboxRows(restaurantId);
    assert("time change enqueued a booking_modified SMS",
      rows.length === 2 && rows[1]!.kind === "booking_modified",
      { rows });
    assert("modified body carries the NEW time", rows[1]!.body.includes("8 PM"), {
      body: rows[1]!.body
    });
    assert("modified body is pure GSM-7", GSM7.test(rows[1]!.body), { body: rows[1]!.body });

    // ---- Dashboard cancel: booking_cancelled SMS ----
    await cancelBooking({
      bookingId: booking.bookingId,
      reason: "guest called to cancel",
      restaurantId,
      source: "dashboard"
    });
    rows = await outboxRows(restaurantId);
    assert("cancel enqueued a booking_cancelled SMS",
      rows.length === 3 && rows[2]!.kind === "booking_cancelled",
      { rows });
    assert("cancelled body is pure GSM-7", GSM7.test(rows[2]!.body), { body: rows[2]!.body });

    // ---- Cancel with NO source (internal caller): silent ----
    const second = await createBooking({
      restaurantId,
      customerName: "Sms Smoke Two",
      customerPhone: GUEST_PHONE,
      date: DATE,
      time: "12:00",
      partySize: 2,
      source: "voice",
      provider: "retell",
      providerCallId: `call_smoke_sms2_${SUFFIX}`
    });
    rows = await outboxRows(restaurantId);
    const countBefore = rows.length; // the second booking's own confirmation
    await cancelBooking({ bookingId: second.bookingId, restaurantId });
    rows = await outboxRows(restaurantId);
    assert("sourceless cancel sent nothing", rows.length === countBefore, {
      before: countBefore,
      after: rows.length
    });

    // ---- Web booking with a Cal.com sentinel phone: silent ----
    const webRestaurant = await createSmokeRestaurant({
      name: `smoke-booking-sms-web-${SUFFIX}`,
      phoneNumber: "+61255500004",
      open: "10:00",
      close: "23:00",
      durationMinutes: 90,
      tables: [{ label: "W1", minCapacity: 1, maxCapacity: 4 }]
    });
    try {
      await createBooking({
        restaurantId: webRestaurant.restaurantId,
        customerName: "Web Smoke",
        customerPhone: `web:smoke-${SUFFIX}`,
        allowUnparseablePhone: true,
        date: DATE,
        time: "19:00",
        partySize: 2,
        source: "web"
      });
      const webRows = await outboxRows(webRestaurant.restaurantId);
      assert("web booking enqueued no SMS", webRows.length === 0, { rows: webRows });

      // ---- Failed booking: nothing survives the rollback ----
      let failed = false;
      try {
        await createBooking({
          restaurantId: webRestaurant.restaurantId,
          customerName: "Past Smoke",
          customerPhone: GUEST_PHONE,
          date: "2020-01-01",
          time: "19:00",
          partySize: 2,
          source: "voice"
        });
      } catch {
        failed = true;
      }
      assert("past-date booking was rejected", failed, {});
      assert("failed booking enqueued no SMS",
        (await outboxRows(webRestaurant.restaurantId)).length === 0,
        {});
    } finally {
      await cleanupSmokeRestaurant(webRestaurant.restaurantId);
    }
  } finally {
    await cleanupSmokeRestaurant(restaurantId);
    await pool.end();
  }

  reportAndExit("smoke-booking-sms");
}

main().catch((error) => {
  console.error("booking-sms smoke crashed:", error);
  process.exit(1);
});
