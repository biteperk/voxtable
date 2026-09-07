/**
 * Per-venue kill-switch smoke — a venue with voice_paused_at set must refuse
 * every Retell tool AND route its inbound calls to the paused agent, while a
 * second live venue in the same process still works. This is what proves the
 * switch is per-venue and not the global VOICE_BOOKING_ENABLED gate.
 *
 * Two venues, A paused and B live:
 *   - every tool call for A returns the same spoken refusal as the global gate,
 *     and A's reservations/orders tables end byte-identical;
 *   - B's check_availability is NOT refused (the pause did not leak across
 *     tenants — a real booking is exercised by the other smokes);
 *   - handleRetellInbound resolves A to metadata.voice_paused="true" and B
 *     without it.
 *
 * Needs only a migrated database — no HTTP server, no vendor credentials.
 *
 *   npm run smoke:voice-pause
 */

import { pool } from "../src/db/pool";
import { setVoicePaused } from "../src/repositories/restaurants";
import {
  handleRetellFunction,
  handleRetellInbound,
  voiceBookingDisabledResponse
} from "../src/services/retellService";
import {
  assert,
  cleanupSmokeRestaurant,
  createSmokeRestaurant,
  reportAndExit,
  SMOKE_DATE,
  SMOKE_SUFFIX
} from "./lib/smoke-harness";

async function main(): Promise<void> {
  const numberA = `+6155500${(1000 + (process.pid % 900)).toString().slice(-4)}`;
  const numberB = `+6155501${(1000 + (process.pid % 900)).toString().slice(-4)}`;

  const A = await createSmokeRestaurant({
    name: `Paused Venue ${SMOKE_SUFFIX}`,
    phoneNumber: numberA,
    tables: [{ label: "T1", minCapacity: 1, maxCapacity: 4 }]
  });
  const B = await createSmokeRestaurant({
    name: `Live Venue ${SMOKE_SUFFIX}`,
    phoneNumber: numberB,
    tables: [{ label: "T1", minCapacity: 1, maxCapacity: 4 }]
  });

  // The dialed-number resolver matches twilio_phone_number; the harness sets
  // phone_number, so stamp the twilio column for the inbound path to resolve.
  await pool.query("UPDATE restaurants SET twilio_phone_number = $2 WHERE id = $1", [
    A.restaurantId,
    numberA
  ]);
  await pool.query("UPDATE restaurants SET twilio_phone_number = $2 WHERE id = $1", [
    B.restaurantId,
    numberB
  ]);

  const count = async (
    table: "reservations" | "orders",
    restaurantId: string
  ): Promise<number> => {
    const result = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table} WHERE restaurant_id = $1`,
      [restaurantId]
    );
    return Number(result.rows[0]!.n);
  };

  try {
    await setVoicePaused(A.restaurantId, true);

    const beforeA = {
      reservations: await count("reservations", A.restaurantId),
      orders: await count("orders", A.restaurantId)
    };
    const refusal = JSON.stringify(voiceBookingDisabledResponse());

    // A is paused: every tool refuses. Tenant is resolved from server-set
    // metadata.restaurant_id (never LLM-influenced).
    const tools = ["check_availability", "create_booking", "modify_booking", "menu_lookup", "create_order"];
    for (const tool of tools) {
      const response = await handleRetellFunction({
        name: tool,
        args: {
          date: SMOKE_DATE,
          time: "19:00",
          party_size: 2,
          customer_name: "Pause Smoke",
          customer_phone: "+61255550100"
        },
        call: { metadata: { restaurant_id: A.restaurantId } }
      });
      assert(`paused venue refuses ${tool}`, JSON.stringify(response) === refusal, response);
    }

    const afterA = {
      reservations: await count("reservations", A.restaurantId),
      orders: await count("orders", A.restaurantId)
    };
    assert(
      "paused venue wrote no reservation",
      afterA.reservations === beforeA.reservations,
      afterA
    );
    assert("paused venue wrote no order", afterA.orders === beforeA.orders, afterA);

    // B is live: the pause did not leak. check_availability must NOT be the
    // refusal (a real booking flow is covered by the other smokes).
    const liveResponse = await handleRetellFunction({
      name: "check_availability",
      args: { date: SMOKE_DATE, time: "19:00", party_size: 2 },
      call: { metadata: { restaurant_id: B.restaurantId } }
    });
    assert(
      "live venue is not refused while the other is paused",
      JSON.stringify(liveResponse) !== refusal,
      liveResponse
    );

    // Inbound routing: paused → metadata.voice_paused; live → not.
    const inboundA = (await handleRetellInbound({
      event: "call_inbound",
      call_inbound: { to_number: numberA }
    })) as { call_inbound?: { metadata?: Record<string, unknown> } };
    assert(
      "paused venue inbound carries voice_paused metadata",
      inboundA.call_inbound?.metadata?.voice_paused === "true",
      inboundA
    );

    const inboundB = (await handleRetellInbound({
      event: "call_inbound",
      call_inbound: { to_number: numberB }
    })) as { call_inbound?: { metadata?: Record<string, unknown> } };
    assert(
      "live venue inbound does not carry voice_paused metadata",
      inboundB.call_inbound?.metadata?.voice_paused === undefined,
      inboundB
    );

    // Resume clears it — a paused venue is not paused forever.
    await setVoicePaused(A.restaurantId, false);
    const afterResume = await handleRetellFunction({
      name: "check_availability",
      args: { date: SMOKE_DATE, time: "19:00", party_size: 2 },
      call: { metadata: { restaurant_id: A.restaurantId } }
    });
    assert(
      "resumed venue is no longer refused",
      JSON.stringify(afterResume) !== refusal,
      afterResume
    );
  } finally {
    await cleanupSmokeRestaurant(A.restaurantId);
    await cleanupSmokeRestaurant(B.restaurantId);
    await pool.end();
  }

  reportAndExit("voice pause (per-venue)");
}

main().catch((error) => {
  console.error("smoke-voice-pause crashed:", error);
  process.exit(1);
});
