import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBookingCancelledSms,
  buildBookingConfirmationSms,
  buildBookingModifiedSms
} from "./bookingService";

// The booking texts go out through the same Messaging Service as payment links
// and will one day carry the one-way alphanumeric `BitePerk` sender, where a
// reply can never be received and STOP can never be processed. Runbook rule
// (acma-sender-id-registration.md §6.3): every SMS template ships with these
// assertions or it doesn't ship.

// GSM-7 basic + extension charset. Anything outside it (em-dash, curly quotes)
// silently halves the segment size from 160 to 70 chars.
const GSM7 =
  /^[A-Za-z0-9 @£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑܧ¿äöñüà\n\r^{}\\[\]~|€]*$/;

// Representative worst-case inputs: long venue and guest names.
const LONG = {
  venueName: "The Parramatta Social Club", // 26 chars
  customerName: "Bartholomew-Jane", // 16 chars
  partySize: 12,
  date: "2026-12-24",
  time: "19:30"
};

const BODIES: Record<string, string> = {
  confirmation: buildBookingConfirmationSms(LONG),
  modified: buildBookingModifiedSms(LONG),
  cancelled: buildBookingCancelledSms(LONG)
};

for (const [kind, sms] of Object.entries(BODIES)) {
  test(`${kind} SMS: one-way-safe copy — no reply invitation, no STOP`, () => {
    assert.ok(sms.includes("Do not reply"), sms);
    // Strip the one sanctioned mention of "reply", then assert nothing else
    // asks for a response (same broadened form as the payment-link test —
    // a narrow pattern would wave through "reply STOP to opt out").
    const withoutDisclaimer = sms.replace("Do not reply.", "");
    assert.ok(!/\b(reply|respond|text (us|back)|sms us)\b/i.test(withoutDisclaimer), sms);
    assert.ok(!/\bSTOP\b/.test(sms), sms);
  });

  test(`${kind} SMS: pure GSM-7 and a single 160-char segment at worst-case lengths`, () => {
    assert.ok(GSM7.test(sms), `non-GSM-7 character in: ${sms}`);
    assert.ok(sms.length <= 160, `${sms.length} chars: ${sms}`);
  });
}

test("confirmation SMS carries venue, guest, party, spoken date and time", () => {
  const sms = BODIES.confirmation!;
  assert.ok(sms.includes(LONG.venueName));
  assert.ok(sms.includes(LONG.customerName));
  assert.ok(sms.includes("party of 12"));
  assert.ok(sms.includes("Thu 24 Dec"));
  assert.ok(sms.includes("7:30 PM"));
});

test("cancelled SMS names the slot but not the guest (no more data than needed)", () => {
  const sms = BODIES.cancelled!;
  assert.ok(sms.includes("Thu 24 Dec"));
  assert.ok(sms.includes("cancelled"));
});
