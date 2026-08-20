/**
 * Agent-routing smoke test for the Retell inbound path.
 *
 * The bug this exists to prevent (found on a live call, 18 Aug 2026): the
 * staging venue's row carried `agent_b9087333…` — "Natalia's Bistro (STAGING)".
 * The dialled number resolved to the RIGHT restaurant and /retell/inbound
 * returned the right `restaurant_name`, timezone and dates, and then handed the
 * call to another venue's agent. The caller was greeted by the wrong
 * restaurant, confidently, while their booking landed against the right one.
 *
 * `smoke-tenant-attribution` already proves number -> restaurant. Nothing
 * proved restaurant -> agent, which is the hop that actually broke. This does.
 *
 * Needs only a migrated database — no HTTP server, no Retell credentials — so
 * it runs in CI against the Postgres service container.
 *
 *   npm run smoke:agent-routing
 */
import { pool } from "../src/db/pool";
import {
  getRestaurantIdByDialedNumber,
  invalidateRestaurantCache
} from "../src/repositories/restaurants";
import { handleRetellInbound } from "../src/services/retellService";
import { assert, reportAndExit, SMOKE_SUFFIX as SUFFIX } from "./lib/smoke-harness";

// Distinct, clearly-fake AU numbers so they cannot collide with real rows.
const NUMBER_A = "+61255500011";
const NUMBER_B = "+61255500012";
const NUMBER_UNBOUND = "+61255500013";
const AGENT_A = `agent_smoke_a_${SUFFIX}`;
const AGENT_B = `agent_smoke_b_${SUFFIX}`;

interface InboundResult {
  call_inbound: {
    override_agent_id?: string;
    dynamic_variables?: Record<string, string>;
    metadata?: Record<string, string>;
  };
}

async function createVenue(label: string, phone: string, agentId: string | null): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO restaurants (name, timezone, phone_number, twilio_phone_number, retell_agent_id, owner_name)
     VALUES ($1, 'Australia/Sydney', $2, $2, $3, $4)
     RETURNING id`,
    [`smoke-agent-${label}-${SUFFIX}`, phone, agentId, `Owner ${label.toUpperCase()}`]
  );
  return result.rows[0]!.id;
}

async function inbound(toNumber: string, callId: string): Promise<InboundResult> {
  return (await handleRetellInbound({
    event: "call_inbound",
    call_inbound: { to_number: toNumber, from_number: "+61400000009", call_id: callId }
  })) as InboundResult;
}

async function main(): Promise<void> {
  const venueA = await createVenue("a", NUMBER_A, AGENT_A);
  const venueB = await createVenue("b", NUMBER_B, AGENT_B);
  const venueUnbound = await createVenue("unbound", NUMBER_UNBOUND, null);
  const callIds = [
    `smokeAgentA${SUFFIX}`,
    `smokeAgentB${SUFFIX}`,
    `smokeAgentU${SUFFIX}`,
    `smokeAgentA${SUFFIX}faq`
  ];

  try {
    const resA = await inbound(NUMBER_A, callIds[0]!);
    const resB = await inbound(NUMBER_B, callIds[1]!);

    // THE missing assertion: each number must return its OWN venue's agent.
    // Before the fix nothing checked this anywhere in the suite.
    assert(
      "A's number returns A's agent",
      resA.call_inbound.override_agent_id === AGENT_A,
      { expected: AGENT_A, actual: resA.call_inbound.override_agent_id }
    );
    assert(
      "B's number returns B's agent",
      resB.call_inbound.override_agent_id === AGENT_B,
      { expected: AGENT_B, actual: resB.call_inbound.override_agent_id }
    );
    assert(
      "the two numbers do NOT collapse onto one agent",
      resA.call_inbound.override_agent_id !== resB.call_inbound.override_agent_id
    );

    // The voice and the data must agree about which venue this is. The 18 Aug
    // failure had these disagreeing: right name in the variables, wrong agent.
    assert(
      "A's dynamic variables name A",
      resA.call_inbound.dynamic_variables?.restaurant_name === `smoke-agent-a-${SUFFIX}`,
      { actual: resA.call_inbound.dynamic_variables?.restaurant_name }
    );
    assert(
      "owner_name is supplied so prompts need not hard-code an owner",
      resA.call_inbound.dynamic_variables?.owner_name === "Owner A",
      { actual: resA.call_inbound.dynamic_variables?.owner_name }
    );

    // venue_faq: the venue's own answers to parking / access / dietary
    // questions. A venue with no FAQ must yield "" — not undefined, and never a
    // literal placeholder, because the prompt reads it out.
    assert(
      "a venue with no FAQ yields an empty venue_faq, not a placeholder",
      resA.call_inbound.dynamic_variables?.venue_faq === "",
      { actual: resA.call_inbound.dynamic_variables?.venue_faq }
    );

    // createVenue() above inserts only into `restaurants`, so this venue has no
    // settings row yet — hence upsert, not update. (That absence is itself worth
    // knowing: getRestaurantVoiceContext LEFT JOINs, so a venue with no settings
    // still answers the phone with an empty FAQ rather than failing the call,
    // which is what the assertion just above proves.)
    await pool.query(
      `INSERT INTO restaurant_settings (restaurant_id, faq_json)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (restaurant_id) DO UPDATE SET faq_json = EXCLUDED.faq_json`,
      [venueA, JSON.stringify({ parking: "Street parking on the corner." })]
    );
    // THE assertion that matters: the FAQ lives behind a 60s process-local
    // cache, so without invalidation this next call would still say "". That is
    // the same class of bug as the dialled-number cache — an edit that appears
    // to do nothing.
    invalidateRestaurantCache(venueA);
    const resFaq = await inbound(NUMBER_A, `${callIds[0]}faq`);
    assert(
      "after writing faq_json, the very next call carries it",
      resFaq.call_inbound.dynamic_variables?.venue_faq === "Parking: Street parking on the corner.",
      { actual: resFaq.call_inbound.dynamic_variables?.venue_faq }
    );

    // A venue with no agent must not borrow another venue's. The deployment-wide
    // RETELL_AGENT_ID is a single-tenant relic: in production posture it is not
    // emitted at all, and where it IS still allowed (local dev only) it must at
    // least never be one of the venues we just created.
    //
    // `env` is parsed once at import, so APP_ENV cannot be flipped here; the
    // production-posture branch is covered by retellService.test.ts instead.
    const resUnbound = await inbound(NUMBER_UNBOUND, callIds[2]!);
    const override = resUnbound.call_inbound.override_agent_id;
    assert(
      "a venue with NULL retell_agent_id never borrows another venue's agent",
      override !== AGENT_A && override !== AGENT_B,
      { actual: override }
    );
    assert(
      "with no env agent configured, no override_agent_id is emitted at all",
      process.env.RETELL_AGENT_ID ? true : override === undefined,
      { envAgent: process.env.RETELL_AGENT_ID ?? null, actual: override }
    );

    // Rebinding a number from one venue to another must take effect on the very
    // next call. The cache is keyed by number and held the OLD venue's id, so a
    // purge scoped to the new venue used to delete nothing and every subsequent
    // call kept reaching the old venue until the process restarted.
    await pool.query(`UPDATE restaurants SET twilio_phone_number = NULL WHERE id = $1`, [venueA]);
    await pool.query(`UPDATE restaurants SET twilio_phone_number = $2 WHERE id = $1`, [
      venueB,
      NUMBER_A
    ]);
    invalidateRestaurantCache(venueB, [NUMBER_A]);
    assert(
      "after moving a number from A to B, the next lookup returns B",
      (await getRestaurantIdByDialedNumber(NUMBER_A)) === venueB,
      { expected: venueB, actual: await getRestaurantIdByDialedNumber(NUMBER_A) }
    );
  } finally {
    await pool.query(`DELETE FROM call_logs WHERE provider_call_id = ANY($1::text[])`, [callIds]);
    await pool.query(`DELETE FROM restaurants WHERE id = ANY($1::uuid[])`, [
      [venueA, venueB, venueUnbound]
    ]);
    await pool.end();
  }

  reportAndExit("agent-routing");
}

main().catch(async (error) => {
  console.error("smoke-agent-routing crashed:", error);
  process.exit(1);
});
