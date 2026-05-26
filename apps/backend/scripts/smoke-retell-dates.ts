/**
 * Smoke test for the Retell agent's date-phrasing handling.
 *
 * Exercises tricky relative-date phrases against the backend's
 * /retell/inbound + check_availability path. Goal: catch the next "AI books
 * the past" bug (Andrew Wood 2024-06-12) before it reaches production.
 *
 * This script doesn't drive the LLM directly — that would cost real
 * Retell tokens. Instead it simulates the function-call payload Retell
 * sends to /retell/tools/check-availability with the resolved date the LLM
 * SHOULD have computed, and asserts the backend's date sanity guard
 * (Sweep B) correctly rejects past/too-far dates.
 *
 * For LLM-side regression coverage (does Aria correctly resolve "the 12th"?)
 * the only reliable approach is a real test call — placed by hand per the
 * pre-prod gate. This smoke covers the BACKEND defence-in-depth.
 *
 * Run:  npm run smoke:retell-dates
 */

const baseUrl = process.env.PUBLIC_API_BASE_URL ?? "http://localhost:3050";

interface SmokeCase {
  name: string;
  date: string;             // YYYY-MM-DD that Aria would send
  expect: "ok" | "past" | "too-far";
  why: string;
}

function todayIso(): string {
  // Note: this uses the local clock — for staging tests where the server is
  // in UTC and the test runner is in AEST, this could be off by a day.
  // Use ISO from server's expected POV.
  return new Date().toISOString().slice(0, 10);
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function buildCases(): SmokeCase[] {
  const today = todayIso();
  return [
    {
      name: "today (boundary)",
      date: today,
      expect: "ok",
      why: "Same-day bookings should pass; the guard rejects strictly-past only."
    },
    {
      name: "tomorrow",
      date: addDays(today, 1),
      expect: "ok",
      why: "Always valid."
    },
    {
      name: "one year out exact (boundary)",
      date: addDays(today, 365),
      expect: "ok",
      why: "Backend allows ≤ today+365."
    },
    {
      name: "one year + 1 day (too far)",
      date: addDays(today, 366),
      expect: "too-far",
      why: "Beyond the 365-day window — guard should reject."
    },
    {
      name: "yesterday (past — the canary bug)",
      date: addDays(today, -1),
      expect: "past",
      why: "Strictly past date — guard must reject."
    },
    {
      name: "two years ago (Andrew Wood 2024 case)",
      date: addDays(today, -730),
      expect: "past",
      why: "The 'AI hallucinated 2024 instead of 2026' scenario."
    }
  ];
}

async function makeBooking(date: string): Promise<{ status: number; body: string }> {
  // Use create_booking — that's where Sweep B added the date sanity guard.
  // check_availability is the upstream tool but date validation lives at
  // the booking layer (where the DB write would happen).
  const body = JSON.stringify({
    name: "create_booking",
    args: {
      customer_name: "Smoke Test",
      customer_phone: "+61400000099",
      date,
      time: "19:00",
      party_size: 2,
      source: "voice"
    },
    call: { call_id: `smoke-dates-${Date.now()}` }
  });
  const response = await fetch(`${baseUrl}/retell/tools/create-booking`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body
  });
  return { status: response.status, body: await response.text() };
}

async function main(): Promise<void> {
  console.log(`Smoke target: ${baseUrl}`);
  const cases = buildCases();
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    const { status, body } = await makeBooking(c.date);
    const isPast = /BOOKING_DATE_IN_PAST/.test(body);
    const isTooFar = /BOOKING_DATE_TOO_FAR/.test(body);
    const isOk = status < 400 || /TABLE_JUST_TAKEN|FULL|no slot/i.test(body);
    let ok = false;
    if (c.expect === "ok") ok = isOk && !isPast && !isTooFar;
    else if (c.expect === "past") ok = isPast;
    else if (c.expect === "too-far") ok = isTooFar;

    if (ok) {
      passed++;
      console.log(`✓ ${c.name}  (date=${c.date}, status=${status})`);
    } else {
      failed++;
      console.error(`✗ ${c.name}  (date=${c.date}, status=${status}, expect=${c.expect})`);
      console.error(`  reason: ${c.why}`);
      console.error(`  body:   ${body.slice(0, 200)}`);
    }
  }
  console.log(`\n${passed}/${cases.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
