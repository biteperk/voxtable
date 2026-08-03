/**
 * Tenant-attribution smoke test for the Twilio call path.
 *
 * The bug this exists to prevent (found 2 Aug 2026): both Twilio handlers wrote
 * `restaurantId: env.DEFAULT_RESTAURANT_ID` unconditionally, in production. With
 * one restaurant that is invisible. The moment a second venue has a number,
 * EVERY call log from EVERY venue is filed against restaurant #1 — the
 * dashboard shows another restaurant's callers, and the real owner sees nothing.
 *
 * Two restaurants, two numbers, and we check each call lands where it belongs.
 * Needs only a migrated database — no HTTP server, no Twilio credentials — so
 * it runs in CI against the Postgres service container.
 *
 *   npm run smoke:tenant-attribution
 */
import { pool } from "../src/db/pool";
import { handleTwilioIncomingCall, handleTwilioStatusCallback } from "../src/services/twilioService";
import { assert, reportAndExit, SMOKE_SUFFIX as SUFFIX } from "./lib/smoke-harness";
// Distinct, clearly-fake AU numbers so they cannot collide with real rows.
const NUMBER_A = "+61255500001";
const NUMBER_B = "+61255500002";

async function createRestaurant(label: string, phone: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO restaurants (name, timezone, phone_number, twilio_phone_number)
     VALUES ($1, 'Australia/Sydney', $2, $2)
     RETURNING id`,
    [`smoke-attribution-${label}-${SUFFIX}`, phone]
  );
  return result.rows[0]!.id;
}

async function restaurantForCall(callSid: string): Promise<string | null> {
  const result = await pool.query<{ restaurant_id: string }>(
    `SELECT restaurant_id FROM call_logs WHERE provider = 'twilio' AND provider_call_id = $1`,
    [callSid]
  );
  return result.rows[0]?.restaurant_id ?? null;
}

async function main(): Promise<void> {
  const restaurantA = await createRestaurant("a", NUMBER_A);
  const restaurantB = await createRestaurant("b", NUMBER_B);
  const sidA = `CAsmokeA${SUFFIX}`;
  const sidB = `CAsmokeB${SUFFIX}`;

  try {
    // A caller dials restaurant A's number.
    await handleTwilioIncomingCall({ CallSid: sidA, From: "+61400000001", To: NUMBER_A });
    assert("call to A's number is filed against A", (await restaurantForCall(sidA)) === restaurantA, {
      expected: restaurantA,
      actual: await restaurantForCall(sidA)
    });

    // A different caller dials restaurant B's number.
    await handleTwilioIncomingCall({ CallSid: sidB, From: "+61400000002", To: NUMBER_B });
    assert("call to B's number is filed against B", (await restaurantForCall(sidB)) === restaurantB, {
      expected: restaurantB,
      actual: await restaurantForCall(sidB)
    });

    // The two calls must not have collapsed onto one tenant — this is the
    // precise shape of the bug.
    assert(
      "the two calls are attributed to DIFFERENT restaurants",
      (await restaurantForCall(sidA)) !== (await restaurantForCall(sidB))
    );

    // The status callback arrives later and must not re-file the call. It
    // carries `Called` rather than `To` on some Twilio events, and by then the
    // call_log already exists, so resolution should come from the log.
    await handleTwilioStatusCallback({
      CallSid: sidB,
      Called: NUMBER_B,
      CallStatus: "completed"
    });
    assert("status callback keeps B's call on B", (await restaurantForCall(sidB)) === restaurantB, {
      expected: restaurantB,
      actual: await restaurantForCall(sidB)
    });
  } finally {
    await pool.query(`DELETE FROM call_logs WHERE provider_call_id IN ($1, $2)`, [sidA, sidB]);
    await pool.query(`DELETE FROM restaurants WHERE id = ANY($1::uuid[])`, [[restaurantA, restaurantB]]);
    await pool.end();
  }

  reportAndExit("tenant-attribution");
}

main().catch(async (error) => {
  console.error("smoke-tenant-attribution crashed:", error);
  process.exit(1);
});
