/**
 * Wrong-item substitution smoke test — proves an unavailable dish is refused,
 * never silently swapped for a different one.
 *
 * The bug this exists for (found on a real call, 26 Aug 2026): the staging menu
 * carried "Fish & Chips" ($22, is_available=false — retired with the fixture
 * menu) alongside "Chips" ($9, available).
 *
 *   - the menu browse did NOT filter is_available, so Bella read "fish and
 *     chips" out to the caller as an option;
 *   - the caller ordered it;
 *   - create_order's search DID filter is_available, so the exact match vanished
 *     and the best REMAINING row was "Chips" at 0.545 similarity;
 *   - the gap to third place was wide enough that nothing flagged it ambiguous,
 *     so it was accepted silently;
 *   - Bella said "fish and chips" for the rest of the call, the kitchen got a
 *     side of chips, and the guest paid $9 for a $22 dish.
 *
 * A substitution nobody agreed to is worse than a refusal: the refusal can be
 * corrected on the call, the substitution is discovered at the counter.
 *
 * Needs only a migrated database — no HTTP server, no vendor credentials.
 *
 *   npm run smoke:menu-substitution
 */
import { pool } from "../src/db/pool";
import { lookupMenu } from "../src/services/menuService";
import { searchMenuItemsByName } from "../src/repositories/menu";
import {
  assert,
  cleanupSmokeRestaurant,
  createSmokeRestaurant,
  reportAndExit,
  SMOKE_SUFFIX as SUFFIX
} from "./lib/smoke-harness";

async function seedMenu(restaurantId: string): Promise<void> {
  const category = await pool.query<{ id: string }>(
    `INSERT INTO menu_categories (restaurant_id, name, display_order)
     VALUES ($1, 'Mains', 1) RETURNING id`,
    [restaurantId]
  );
  const categoryId = category.rows[0]!.id;
  // The exact shape that caused the incident: a premium dish switched OFF, and a
  // cheap side whose name is a substring of it left ON.
  await pool.query(
    `INSERT INTO menu_items (restaurant_id, category_id, name, base_price_cents, is_available, display_order)
     VALUES ($1, $2, 'Fish & Chips', 2200, false, 1),
            ($1, $2, 'Chips', 900, true, 2),
            ($1, $2, 'Chicken Schnitzel', 1900, true, 3)`,
    [restaurantId, categoryId]
  );
}

async function main(): Promise<void> {
  const { restaurantId } = await createSmokeRestaurant({
    name: `smoke-menu-substitution-${SUFFIX}`,
    phoneNumber: "+61255500009",
    tables: [{ label: "M1", minCapacity: 1, maxCapacity: 4 }]
  });

  try {
    await seedMenu(restaurantId);

    // ---- The search still RANKS the unavailable item, so the caller can be
    // ---- told about it rather than silently handed something else.
    const withUnavailable = await searchMenuItemsByName(restaurantId, "Fish & Chips", 6, {
      includeUnavailable: true
    });
    assert(
      "the unavailable dish is still the best match when included",
      withUnavailable[0]?.name === "Fish & Chips" && withUnavailable[0]?.is_available === false,
      { top: withUnavailable[0]?.name, available: withUnavailable[0]?.is_available }
    );

    // ---- Without it, the next-best row is a DIFFERENT, cheaper dish. This is
    // ---- the substitution the caller never agreed to.
    const availableOnly = await searchMenuItemsByName(restaurantId, "Fish & Chips", 6);
    assert(
      "available-only search would have substituted a different item",
      availableOnly[0]?.name === "Chips",
      { top: availableOnly[0]?.name, price: availableOnly[0]?.base_price_cents }
    );
    assert(
      "and at a materially different price — why this matters",
      availableOnly[0]?.base_price_cents === 900 && withUnavailable[0]?.base_price_cents === 2200,
      { substitute: availableOnly[0]?.base_price_cents, requested: withUnavailable[0]?.base_price_cents }
    );

    // ---- The browse must never OFFER what cannot be sold ----
    // The no-query overview speaks CATEGORY names; the items Bella reads out
    // come from the category browse, which is the surface that offered the
    // retired dish on the real call.
    const section = await lookupMenu({ restaurantId, category: "Mains" });
    assert(
      "the spoken section does not offer the unavailable dish",
      !/fish/i.test(section.speakable_summary),
      { summary: section.speakable_summary }
    );
    assert(
      "the section still offers what IS available",
      /chips|schnitzel/i.test(section.speakable_summary),
      { summary: section.speakable_summary }
    );
    assert(
      "no unavailable item appears in the machine-readable matches either",
      !section.matches.some((m) => /fish/i.test(m.name)),
      { matches: section.matches.map((m) => m.name) }
    );

    // ---- A genuine available item still resolves normally ----
    const schnitzel = await searchMenuItemsByName(restaurantId, "chicken schnitzel", 6, {
      includeUnavailable: true
    });
    assert(
      "an available dish is unaffected",
      schnitzel[0]?.name === "Chicken Schnitzel" && schnitzel[0]?.is_available === true,
      { top: schnitzel[0]?.name }
    );
  } finally {
    await cleanupSmokeRestaurant(restaurantId);
    await pool.end();
  }

  reportAndExit("smoke-menu-substitution");
}

main().catch((error) => {
  console.error("menu-substitution smoke crashed:", error);
  process.exit(1);
});
