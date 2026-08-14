// Bulk menu import for onboarding a real venue. Reads a venue-menu JSON
// (shape: { restaurant, categories, items } with a FLAT items array keyed by
// category name — the shape our menu-capture tooling emits) and writes the
// menu_categories / menu_items / menu_item_variants / menu_item_modifiers
// tree for ONE restaurant.
//
//   APP_ENV=migration DATABASE_URL=postgres://… tsx scripts/import-menu.ts \
//     --restaurant-id <uuid> --file <menu.json> [--dry-run] [--emit-sql out.sql]
//
// APP_ENV=migration skips the production env gates (same trick migrate.js
// uses). --restaurant-id is REQUIRED — the JSON carries no UUID and resolving
// a tenant by name against a shared database is how cross-tenant accidents
// happen.
//
// Idempotent by UPSERT, not delete-and-recreate: re-running updates prices /
// windows / flags in place. The repo's replaceVariants/replaceModifiers are
// deliberately NOT used — they DELETE-then-INSERT, which violates the
// RESTRICT FKs from order_items the moment a live venue has taken an order.
//
// Data hygiene applied while importing (all reported):
//   - duplicate (group_name, option) rows within an item are dropped (the
//     source data contains exact dupes that would 23505-abort the insert);
//   - group_min/max_select clamped to the API's 0..20 so future dashboard
//     edits of these groups don't 400;
//   - an item name appearing under MORE THAN ONE category is qualified with
//     its category ("Pancake (Kids Menu)") — identical names make the voice
//     agent's disambiguation question unanswerable;
//   - menu_window "07:00–12:00" (en-dash OR hyphen) → available_from/until.
//
// --dry-run runs the whole import inside one transaction and rolls it back.
// --emit-sql writes a fresh-install SQL file instead of touching a database
// (for hosts where only psql reaches the DB, e.g. the production VM); the
// SQL is insert-if-absent, so re-applying skips rather than duplicates, but
// it does not UPDATE existing rows — use the direct mode for that.

import { readFileSync, writeFileSync } from "node:fs";

interface SourceItem {
  category: string;
  name: string;
  description?: string | null;
  base_price_cents: number;
  menu_window?: string | null;
  restricted?: boolean;
  pos_item_id?: string | number | null;
  source_menu?: string | null;
  variants?: Array<{ name: string; price_delta_cents?: number }>;
  modifiers?: Array<{
    group_name: string;
    name: string;
    price_delta_cents?: number;
    group_min_select?: number;
    group_max_select?: number;
  }>;
}

interface CleanItem {
  category: string;
  name: string;
  description: string | null;
  basePriceCents: number;
  availableFrom: string | null;
  availableUntil: string | null;
  isRestricted: boolean;
  variants: Array<{ name: string; priceDeltaCents: number; displayOrder: number }>;
  modifiers: Array<{
    groupName: string;
    name: string;
    priceDeltaCents: number;
    groupMinSelect: number;
    groupMaxSelect: number;
    isDefault: boolean;
    displayOrder: number;
  }>;
}

interface Report {
  categories: number;
  items: number;
  created: number;
  updated: number;
  windowed: number;
  restricted: number;
  renamedDuplicates: string[];
  droppedDuplicateModifiers: string[];
  clampedGroups: number;
}

function parseArgs(): {
  restaurantId: string;
  file: string;
  dryRun: boolean;
  emitSql: string | null;
} {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  const restaurantId = get("--restaurant-id");
  const file = get("--file");
  if (!restaurantId || !file) {
    console.error(
      "Usage: tsx scripts/import-menu.ts --restaurant-id <uuid> --file <menu.json> [--dry-run] [--emit-sql out.sql]"
    );
    process.exit(2);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(restaurantId)) {
    console.error(`--restaurant-id must be a UUID, got: ${restaurantId}`);
    process.exit(2);
  }
  return {
    restaurantId,
    file,
    dryRun: argv.includes("--dry-run"),
    emitSql: get("--emit-sql")
  };
}

/** "07:00–12:00" (en-dash or hyphen) → ["07:00","12:00"]; empty/absent → nulls. */
function parseWindow(raw: string | null | undefined): [string | null, string | null] {
  const value = (raw ?? "").trim();
  if (!value) return [null, null];
  const parts = value.split(/[–-]/).map((p) => p.trim());
  const hm = /^\d{2}:\d{2}$/;
  if (parts.length !== 2 || !hm.test(parts[0]!) || !hm.test(parts[1]!)) {
    throw new Error(`unparseable menu_window: "${value}"`);
  }
  return [parts[0]!, parts[1]!];
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function cleanse(items: SourceItem[], report: Report): CleanItem[] {
  // Names appearing under more than one category get a category qualifier —
  // otherwise the voice agent's "did you mean X or X?" is unanswerable.
  const categoriesByName = new Map<string, Set<string>>();
  for (const item of items) {
    const key = item.name.trim().toLowerCase();
    const set = categoriesByName.get(key) ?? new Set();
    set.add(item.category);
    categoriesByName.set(key, set);
  }

  return items.map((item) => {
    const baseName = item.name.trim();
    const needsQualifier = (categoriesByName.get(baseName.toLowerCase())?.size ?? 0) > 1;
    const name = needsQualifier ? `${baseName} (${item.category.trim()})` : baseName;
    if (needsQualifier) report.renamedDuplicates.push(`${baseName} → ${name}`);

    const [availableFrom, availableUntil] = parseWindow(item.menu_window);
    if (availableFrom || availableUntil) report.windowed += 1;
    if (item.restricted) report.restricted += 1;

    const seen = new Set<string>();
    const modifiers: CleanItem["modifiers"] = [];
    for (const m of item.modifiers ?? []) {
      const key = `${m.group_name.trim().toLowerCase()}|${m.name.trim().toLowerCase()}`;
      if (seen.has(key)) {
        report.droppedDuplicateModifiers.push(`${name}: ${m.group_name} / ${m.name}`);
        continue;
      }
      seen.add(key);
      const min = clamp(m.group_min_select ?? 0, 0, 20);
      const max = clamp(m.group_max_select ?? 1, 1, 20);
      if ((m.group_max_select ?? 1) > 20 || (m.group_min_select ?? 0) > 20) {
        report.clampedGroups += 1;
      }
      modifiers.push({
        groupName: m.group_name.trim().slice(0, 60),
        name: m.name.trim().slice(0, 80),
        priceDeltaCents: m.price_delta_cents ?? 0,
        groupMinSelect: min,
        groupMaxSelect: Math.max(min || 1, max),
        isDefault: false,
        displayOrder: modifiers.length
      });
    }

    return {
      category: item.category.trim(),
      name: name.slice(0, 120),
      description: item.description ? item.description.trim().slice(0, 500) : null,
      basePriceCents: item.base_price_cents,
      availableFrom,
      availableUntil,
      isRestricted: Boolean(item.restricted),
      variants: (item.variants ?? []).map((v, idx) => ({
        name: v.name.trim().slice(0, 80),
        priceDeltaCents: v.price_delta_cents ?? 0,
        displayOrder: idx
      })),
      modifiers
    };
  });
}

function esc(value: string): string {
  return value.replace(/'/g, "''");
}

function sqlLiteral(value: string | number | boolean | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return `'${esc(value)}'`;
}

/**
 * Fresh-install SQL: insert-if-absent everywhere so re-applying skips instead
 * of duplicating. Variants/modifiers upsert on their real unique indexes.
 */
function emitSql(restaurantId: string, items: CleanItem[], categories: string[]): string {
  const lines: string[] = [
    "-- Generated by scripts/import-menu.ts — venue menu import.",
    "-- Idempotent: safe to re-apply (existing rows are skipped, not updated).",
    "-- Literals are quote-doubled; force conforming strings so a backslash in",
    "-- a menu item name can never re-open a string literal.",
    "SET standard_conforming_strings = on;",
    "BEGIN;",
    ""
  ];
  const rid = sqlLiteral(restaurantId);

  categories.forEach((category, idx) => {
    lines.push(
      `INSERT INTO menu_categories (restaurant_id, name, display_order)`,
      `SELECT ${rid}, ${sqlLiteral(category)}, ${idx + 1}`,
      `WHERE NOT EXISTS (SELECT 1 FROM menu_categories WHERE restaurant_id = ${rid} AND LOWER(name) = LOWER(${sqlLiteral(category)}));`,
      ""
    );
  });

  items.forEach((item, idx) => {
    const cat = `(SELECT id FROM menu_categories WHERE restaurant_id = ${rid} AND LOWER(name) = LOWER(${sqlLiteral(item.category)}) LIMIT 1)`;
    const itemRef = `(SELECT id FROM menu_items WHERE restaurant_id = ${rid} AND category_id = ${cat} AND LOWER(name) = LOWER(${sqlLiteral(item.name)}) LIMIT 1)`;
    lines.push(
      `INSERT INTO menu_items (restaurant_id, category_id, name, description, base_price_cents, display_order, is_available, available_from, available_until, is_restricted)`,
      `SELECT ${rid}, ${cat}, ${sqlLiteral(item.name)}, ${sqlLiteral(item.description)}, ${item.basePriceCents}, ${idx + 1}, true, ${sqlLiteral(item.availableFrom)}, ${sqlLiteral(item.availableUntil)}, ${sqlLiteral(item.isRestricted)}`,
      `WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE restaurant_id = ${rid} AND category_id = ${cat} AND LOWER(name) = LOWER(${sqlLiteral(item.name)}));`
    );
    for (const v of item.variants) {
      lines.push(
        `INSERT INTO menu_item_variants (menu_item_id, name, price_delta_cents, display_order)`,
        `SELECT ${itemRef}, ${sqlLiteral(v.name)}, ${v.priceDeltaCents}, ${v.displayOrder}`,
        `ON CONFLICT (menu_item_id, name) DO UPDATE SET price_delta_cents = EXCLUDED.price_delta_cents;`
      );
    }
    for (const m of item.modifiers) {
      lines.push(
        `INSERT INTO menu_item_modifiers (menu_item_id, group_name, name, price_delta_cents, group_min_select, group_max_select, is_default, display_order)`,
        `SELECT ${itemRef}, ${sqlLiteral(m.groupName)}, ${sqlLiteral(m.name)}, ${m.priceDeltaCents}, ${m.groupMinSelect}, ${m.groupMaxSelect}, ${sqlLiteral(m.isDefault)}, ${m.displayOrder}`,
        `ON CONFLICT (menu_item_id, group_name, name) DO UPDATE SET price_delta_cents = EXCLUDED.price_delta_cents, group_min_select = EXCLUDED.group_min_select, group_max_select = EXCLUDED.group_max_select;`
      );
    }
    lines.push("");
  });

  lines.push("COMMIT;", "");
  return lines.join("\n");
}

class DryRunRollback extends Error {}

async function runDirect(
  restaurantId: string,
  items: CleanItem[],
  categories: string[],
  dryRun: boolean,
  report: Report
): Promise<void> {
  // Deferred imports: --emit-sql mode must work without a reachable database.
  const { pool, withTransaction } = await import("../src/db/pool");
  const { getOrCreateCategory } = await import("../src/repositories/menu");

  const exists = await pool.query("SELECT id, name FROM restaurants WHERE id = $1", [restaurantId]);
  if (exists.rows.length === 0) {
    throw new Error(`restaurant ${restaurantId} not found in this database — wrong DATABASE_URL?`);
  }
  console.log(`Importing into: ${exists.rows[0].name} (${restaurantId})`);

  try {
    await withTransaction(async (db) => {
      const categoryIds = new Map<string, string>();
      for (const [idx, category] of categories.entries()) {
        const row = await getOrCreateCategory(
          { restaurantId, name: category, displayOrder: idx + 1 },
          db
        );
        categoryIds.set(category.toLowerCase(), row.id);
      }

      for (const [idx, item] of items.entries()) {
        const categoryId = categoryIds.get(item.category.toLowerCase())!;
        const existing = await db.query<{ id: string }>(
          `SELECT id FROM menu_items
            WHERE restaurant_id = $1 AND category_id = $2 AND LOWER(name) = LOWER($3)
            ORDER BY created_at LIMIT 1`,
          [restaurantId, categoryId, item.name]
        );
        let itemId: string;
        if (existing.rows[0]) {
          itemId = existing.rows[0].id;
          await db.query(
            `UPDATE menu_items
                SET description = $3, base_price_cents = $4, display_order = $5,
                    available_from = $6, available_until = $7, is_restricted = $8
              WHERE id = $1 AND restaurant_id = $2`,
            [
              itemId,
              restaurantId,
              item.description,
              item.basePriceCents,
              idx + 1,
              item.availableFrom,
              item.availableUntil,
              item.isRestricted
            ]
          );
          report.updated += 1;
        } else {
          const inserted = await db.query<{ id: string }>(
            `INSERT INTO menu_items (restaurant_id, category_id, name, description, base_price_cents,
                                     display_order, is_available, available_from, available_until, is_restricted)
             VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, $9)
             RETURNING id`,
            [
              restaurantId,
              categoryId,
              item.name,
              item.description,
              item.basePriceCents,
              idx + 1,
              item.availableFrom,
              item.availableUntil,
              item.isRestricted
            ]
          );
          itemId = inserted.rows[0]!.id;
          report.created += 1;
        }

        // Upserts, never delete-and-recreate: RESTRICT FKs from order_items
        // make replace impossible once the venue has taken a real order.
        for (const v of item.variants) {
          await db.query(
            `INSERT INTO menu_item_variants (menu_item_id, name, price_delta_cents, display_order)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (menu_item_id, name) DO UPDATE SET price_delta_cents = EXCLUDED.price_delta_cents`,
            [itemId, v.name, v.priceDeltaCents, v.displayOrder]
          );
        }
        for (const m of item.modifiers) {
          await db.query(
            `INSERT INTO menu_item_modifiers (menu_item_id, group_name, name, price_delta_cents,
                                              group_min_select, group_max_select, is_default, display_order)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (menu_item_id, group_name, name)
             DO UPDATE SET price_delta_cents = EXCLUDED.price_delta_cents,
                           group_min_select = EXCLUDED.group_min_select,
                           group_max_select = EXCLUDED.group_max_select`,
            [itemId, m.groupName, m.name, m.priceDeltaCents, m.groupMinSelect, m.groupMaxSelect, m.isDefault, m.displayOrder]
          );
        }
      }

      if (dryRun) throw new DryRunRollback("dry run — rolling back");
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
    console.log("DRY RUN: transaction rolled back, database untouched.");
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const raw = JSON.parse(readFileSync(args.file, "utf8"));
  const sourceItems: SourceItem[] = raw.items;
  if (!Array.isArray(sourceItems) || sourceItems.length === 0) {
    throw new Error("no items[] in the input file");
  }
  console.log(`Venue in file: ${raw.restaurant?.name ?? "(unnamed)"} — ${sourceItems.length} items`);

  const report: Report = {
    categories: 0,
    items: sourceItems.length,
    created: 0,
    updated: 0,
    windowed: 0,
    restricted: 0,
    renamedDuplicates: [],
    droppedDuplicateModifiers: [],
    clampedGroups: 0
  };
  const items = cleanse(sourceItems, report);
  // Category order = first appearance in the flat item list.
  const categories = Array.from(new Set(items.map((i) => i.category)));
  report.categories = categories.length;

  if (args.emitSql) {
    writeFileSync(args.emitSql, emitSql(args.restaurantId, items, categories));
    console.log(`SQL written to ${args.emitSql}`);
  } else {
    await runDirect(args.restaurantId, items, categories, args.dryRun, report);
  }

  console.log("\n=== Import report ===");
  console.log(`categories: ${report.categories}, items: ${report.items} (created ${report.created}, updated ${report.updated})`);
  console.log(`windowed items: ${report.windowed}, restricted items: ${report.restricted}`);
  console.log(`renamed cross-category duplicates: ${report.renamedDuplicates.length}`);
  for (const r of Array.from(new Set(report.renamedDuplicates)).slice(0, 40)) console.log(`  - ${r}`);
  console.log(`dropped duplicate modifier rows: ${report.droppedDuplicateModifiers.length}`);
  for (const d of report.droppedDuplicateModifiers) console.log(`  - ${d}`);
  console.log(`modifier groups clamped to max_select 20: ${report.clampedGroups}`);
}

main().catch((error) => {
  console.error("import-menu FAILED:", error);
  process.exit(1);
});
