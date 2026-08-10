/**
 * Voice-booking kill-switch smoke — VOICE_BOOKING_ENABLED=false must refuse
 * every Retell tool with a spoken message and write NOTHING.
 *
 * The core product had no kill switch (audit S2): a misbehaving agent or a
 * corrupted booking flow could only be stopped by pulling the phone number at
 * Retell. The switch is only trustworthy if the refusal path provably cannot
 * reach booking state, which is what this smoke pins: every tool returns the
 * refusal, and the reservations/orders tables end the run byte-identical.
 *
 * The ON path needs no twin here — every other CI smoke (double-booking,
 * solo-diner, tenant-attribution) runs with the default and books for real.
 *
 * Needs only a migrated database — no HTTP server, no vendor credentials.
 *
 *   npm run smoke:voice-kill-switch
 */

// Must be set before env.ts is first imported, which is why every import
// below is dynamic: a static import would hoist above this line and parse
// the environment with the switch still on.
process.env.VOICE_BOOKING_ENABLED = "false";

async function main(): Promise<void> {
  const { handleRetellFunction, voiceBookingDisabledResponse } = await import(
    "../src/services/retellService"
  );
  const { pool } = await import("../src/db/pool");
  const { assert, reportAndExit } = await import("./lib/smoke-harness");

  const count = async (table: "reservations" | "orders"): Promise<number> => {
    const result = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
    return Number(result.rows[0]!.n);
  };

  try {
    const before = { reservations: await count("reservations"), orders: await count("orders") };
    const expected = JSON.stringify(voiceBookingDisabledResponse());

    const tools = [
      "check_availability",
      "create_booking",
      "modify_booking",
      "menu_lookup",
      "create_order"
    ];
    for (const tool of tools) {
      const response = await handleRetellFunction({
        name: tool,
        args: {
          date: "2026-12-01",
          time: "19:00",
          party_size: 2,
          customer_name: "Kill Switch Smoke",
          customer_phone: "+61255550100"
        }
      });
      assert(`${tool} returns the spoken refusal`, JSON.stringify(response) === expected, response);
    }

    const after = { reservations: await count("reservations"), orders: await count("orders") };
    assert(
      "no reservation was written while the switch was off",
      after.reservations === before.reservations,
      { before: before.reservations, after: after.reservations }
    );
    assert("no order was written while the switch was off", after.orders === before.orders, {
      before: before.orders,
      after: after.orders
    });
  } finally {
    await pool.end();
  }

  reportAndExit("voice kill switch");
}

main().catch((error) => {
  console.error("smoke-voice-kill-switch crashed:", error);
  process.exit(1);
});
