/**
 * Menu guard smoke: the two ways Bella must refuse an item a caller asks for.
 *
 * Both guards exist in `handleRetellFunction`, and until now NEITHER had any
 * automated cover. They were exercised only by leg 4 of the human call battery,
 * against props planted in the staging venue's menu ("House Lager" for licensed,
 * "Big Breakfast 09:00-11:30" for the window).
 *
 * That coupling is the problem this file removes. Staging is becoming a real
 * venue (Mazcina), and a real customer's menu should not have to carry test
 * fixtures — nor should our regression cover disappear the moment it doesn't.
 * So the venue and menu here are built and torn down by the test itself.
 *
 * `isWithinDailyWindow` is already unit-tested in utils/time.test.ts, including
 * the overnight wrap. What is NOT covered anywhere else is that the voice path
 * actually CONSULTS it and refuses — the wiring, not the arithmetic.
 *
 * Needs only a migrated database — no HTTP server, no Retell credentials.
 *
 *   npm run smoke:menu-guards
 */
import { pool } from "../src/db/pool";
import { handleRetellFunction } from "../src/services/retellService";
import { isAppError } from "../src/domain/errors";
import { nowTimeInTz } from "../src/utils/time";
import {
  assert,
  cleanupSmokeRestaurant,
  createSmokeRestaurant,
  reportAndExit,
  SMOKE_SUFFIX as SUFFIX
} from "./lib/smoke-harness";

const CALLER = "+61400000021";
// createSmokeRestaurant always builds the venue in this zone.
const VENUE_TZ = "Australia/Sydney";

async function one<T>(sql: string, params: unknown[]): Promise<T> {
  const result = await pool.query<T>(sql, params);
  return result.rows[0]!;
}

/** Order one item by name through the Retell tool path; return the error code. */
async function orderAndCatchCode(
  restaurantId: string,
  itemName: string,
  callId: string
): Promise<{ code: string | null; message: string }> {
  try {
    await handleRetellFunction({
      name: "create_order",
      call: {
        call_id: callId,
        from_number: CALLER,
        metadata: { restaurant_id: restaurantId }
      },
      args: {
        // pickup_name is what turns this into the phone-takeaway path; without
        // it the handler stops at ORDER_NEEDS_NAME before it ever looks at the
        // item, and the guards under test are never reached.
        pickup_name: "Smoke Caller",
        pickup_time: "6:30pm",
        items: [{ name: itemName, quantity: 1 }]
      }
    });
    return { code: null, message: "(no error — the order was accepted)" };
  } catch (error) {
    if (isAppError(error)) return { code: error.code, message: error.message };
    throw error;
  }
}

async function main(): Promise<void> {
  const { restaurantId } = await createSmokeRestaurant({
    name: `Menu Guards Smoke ${SUFFIX}`,
    phoneNumber: `+6129008${String(process.pid % 10000).padStart(4, "0")}`,
    tables: [{ label: "G1", minCapacity: 1, maxCapacity: 4 }]
  });

  try {
    const category = await one<{ id: string }>(
      `INSERT INTO menu_categories (restaurant_id, name) VALUES ($1, 'Guard Menu') RETURNING id`,
      [restaurantId]
    );

    // An always-available control, so a refusal below can never be mistaken for
    // "ordering is broken in this fixture".
    await pool.query(
      `INSERT INTO menu_items (restaurant_id, category_id, name, base_price_cents, is_available)
       VALUES ($1, $2, 'Guard Control Burger', 1500, true)`,
      [restaurantId, category.id]
    );
    // Licensed: stays visible and staff-orderable, refused on the voice path.
    await pool.query(
      `INSERT INTO menu_items (restaurant_id, category_id, name, base_price_cents, is_available, is_restricted)
       VALUES ($1, $2, 'Guard Pale Ale', 900, true, true)`,
      [restaurantId, category.id]
    );
    // A window that is closed right now, whatever "now" is: it opens one minute
    // from now and shuts two. Anchoring to the clock rather than a fixed
    // 09:00-11:30 is what stops this passing or failing by time of day.
    //
    // The times MUST be computed in the venue's zone, not the machine's. The
    // handler compares against the restaurant's wall clock (Australia/Sydney
    // here), so a UTC CI runner would otherwise plant a window ~10 hours away
    // and the assertion would pass for the wrong reason — the least useful kind
    // of green.
    const hm = (d: Date): string => nowTimeInTz(VENUE_TZ, d);
    const soon = new Date(Date.now() + 60_000);
    const later = new Date(Date.now() + 120_000);
    await pool.query(
      `INSERT INTO menu_items (restaurant_id, category_id, name, base_price_cents, is_available,
                               available_from, available_until)
       VALUES ($1, $2, 'Guard Dawn Special', 1200, true, $3, $4)`,
      [restaurantId, category.id, hm(soon), hm(later)]
    );

    const control = await orderAndCatchCode(restaurantId, "Guard Control Burger", `guardCtl${SUFFIX}`);
    assert("an ordinary item is accepted (control)", control.code === null, control);

    const licensed = await orderAndCatchCode(restaurantId, "Guard Pale Ale", `guardAle${SUFFIX}`);
    assert("a licensed item is refused on the voice path", licensed.code === "RESTRICTED_ITEM", licensed);
    assert(
      "...and the refusal explains why, so the caller isn't just told no",
      /licens/i.test(licensed.message),
      { message: licensed.message }
    );

    const outOfWindow = await orderAndCatchCode(restaurantId, "Guard Dawn Special", `guardWin${SUFFIX}`);
    assert(
      "an item outside its serving window is refused",
      outOfWindow.code === "ITEM_NOT_AVAILABLE_NOW",
      outOfWindow
    );
    assert(
      "...and the refusal names the window, so the caller can call back",
      /only served/i.test(outOfWindow.message),
      { message: outOfWindow.message }
    );
  } finally {
    await pool.query(`DELETE FROM call_logs WHERE restaurant_id = $1`, [restaurantId]);
    // Orders MUST go before menu items: order_items references menu_items with
    // ON DELETE RESTRICT, so the control order pins the very item it ordered.
    // (order_items and order_events cascade from orders; the restaurant cascade
    // does not save us, because it would try to drop menu_items first and hit
    // the same RESTRICT.) This is the same trap that governs retiring the old
    // staging fixture menu — see deploy/runbooks/staging-venue.md.
    await pool.query(`DELETE FROM orders WHERE restaurant_id = $1`, [restaurantId]);
    await pool.query(`DELETE FROM menu_items WHERE restaurant_id = $1`, [restaurantId]);
    await pool.query(`DELETE FROM menu_categories WHERE restaurant_id = $1`, [restaurantId]);
    await cleanupSmokeRestaurant(restaurantId);
    await pool.end();
  }

  reportAndExit("menu-guards");
}

main().catch(async (error) => {
  console.error("smoke-menu-guards crashed:", error);
  process.exit(1);
});
