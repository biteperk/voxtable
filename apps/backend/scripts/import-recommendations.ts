// Apply an owner's ranked dish list to an existing menu.
//
//   APP_ENV=migration DATABASE_URL=postgres://… tsx scripts/import-recommendations.ts \
//     --restaurant-id <uuid> --file <prioritised-dishes.json> [--dry-run]
//
// Input shape is the owner's own, NOT the menu-import shape:
//   { restaurant, categories: [ { category, items: [ { priority, name, tags } ] } ] }
//
// This is deliberately a separate script from import-menu.ts. That script's
// existing-row path does a blind `UPDATE ... SET description=…, price=…, …`, so
// teaching it these columns would mean the next ordinary menu re-import — from
// a file that carries no rankings — silently NULLs every ranking the owner
// gave. Keeping the two apart makes that impossible rather than merely
// unlikely.
//
// The whole apply runs in ONE transaction that CLEARS every ranking for the
// venue first. Without the clear, a dish the owner drops from his list keeps
// its rank forever and the agent keeps pushing it; with it, the file is the
// complete statement of what gets recommended.
//
// An unmatched dish name is a HARD FAILURE, never a skip. A silent miss means
// the agent never recommends that dish and nobody finds out — the failure has
// no symptom at the venue, so it must have one here.

import { readFileSync } from "node:fs";

interface SourceItem {
  priority: number;
  name: string;
  tags?: string[];
}
interface SourceCategory {
  category: string;
  items: SourceItem[];
}

/** Dishes the owner calls quick to make — offered while mains cook. */
const QUICK_BITE_NAMES = ["cocktail empanadas", "sopaipillas"];

function parseArgs(): { restaurantId: string; file: string; dryRun: boolean } {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  const restaurantId = get("--restaurant-id");
  const file = get("--file");
  if (!restaurantId || !file) {
    console.error(
      "Usage: tsx scripts/import-recommendations.ts --restaurant-id <uuid> --file <ranked.json> [--dry-run]"
    );
    process.exit(2);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(restaurantId)) {
    console.error(`--restaurant-id must be a UUID, got: ${restaurantId}`);
    process.exit(2);
  }
  return { restaurantId, file, dryRun: argv.includes("--dry-run") };
}

class DryRunRollback extends Error {}

async function run(): Promise<void> {
  const { restaurantId, file, dryRun } = parseArgs();
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const categories: SourceCategory[] = raw.categories;
  if (!Array.isArray(categories) || categories.length === 0) {
    throw new Error("no categories[] in the input file");
  }

  const { pool, withTransaction } = await import("../src/db/pool");
  const venue = await pool.query("SELECT id, name FROM restaurants WHERE id = $1", [restaurantId]);
  if (venue.rowCount === 0) {
    console.error(`No restaurant ${restaurantId} in this database.`);
    process.exit(1);
  }
  console.log(`Venue: ${venue.rows[0].name}`);
  console.log(`File:  ${raw.restaurant?.name ?? "(unnamed)"} — ${categories.length} sections\n`);

  const unmatched: string[] = [];
  const applied: string[] = [];

  try {
    await withTransaction(async (db) => {
      // The file is the complete statement of what gets recommended. Anything
      // it no longer lists stops being recommended in the same breath.
      const cleared = await db.query(
        `UPDATE menu_items
            SET recommend_rank = NULL, is_signature = false, is_quick_bite = false
          WHERE restaurant_id = $1
            AND (recommend_rank IS NOT NULL OR is_signature OR is_quick_bite)`,
        [restaurantId]
      );
      console.log(`Cleared ${cleared.rowCount} previously-ranked item(s).`);

      for (const section of categories) {
        // Match the section case-insensitively, the same key the menu importer
        // and the DB's unique index use.
        const cat = await db.query<{ id: string; name: string }>(
          `SELECT id, name FROM menu_categories
            WHERE restaurant_id = $1 AND LOWER(name) = LOWER($2)`,
          [restaurantId, section.category]
        );
        if (cat.rowCount === 0) {
          unmatched.push(`section "${section.category}" — no such category`);
          continue;
        }
        const categoryId = cat.rows[0]!.id;

        for (const item of section.items) {
          const isQuick = QUICK_BITE_NAMES.some((q) => item.name.toLowerCase().includes(q));
          const isSignature = (item.tags ?? []).some((t) => /signature|chef/i.test(t));

          // Exact name first; then the qualified form import-menu.ts writes for
          // a name appearing under two sections ("Pancake (Kids Menu)"); then a
          // containment fallback, because the owner writes the dish the way he
          // says it out loud and the menu stores it shorter — his list says
          // "Chilean Cocktail Empanadas" where the row is "Cocktail Empanadas".
          const updated = await db.query<{ name: string }>(
            `UPDATE menu_items
                SET recommend_rank = $3, is_signature = $4, is_quick_bite = $5
              WHERE id = (
                SELECT id FROM menu_items
                 WHERE restaurant_id = $1 AND category_id = $2
                   AND (
                     LOWER(name) = LOWER($6)
                     OR LOWER(name) = LOWER($7)
                     OR LOWER($6) LIKE '%' || LOWER(name) || '%'
                   )
                 ORDER BY
                   CASE WHEN LOWER(name) = LOWER($6) THEN 0
                        WHEN LOWER(name) = LOWER($7) THEN 1
                        ELSE 2 END,
                   LENGTH(name) DESC
                 LIMIT 1
              )
            RETURNING name`,
            [
              restaurantId,
              categoryId,
              item.priority,
              isSignature,
              isQuick,
              item.name,
              `${item.name} (${cat.rows[0]!.name})`
            ]
          );
          if (updated.rowCount === 0) {
            unmatched.push(`"${item.name}" in ${section.category}`);
            continue;
          }
          const stored = updated.rows[0]!.name;
          const note = [
            isSignature ? "signature" : null,
            isQuick ? "quick bite" : null,
            stored.toLowerCase() !== item.name.toLowerCase() ? `matched "${stored}"` : null
          ]
            .filter(Boolean)
            .join(", ");
          applied.push(
            `  ${section.category} #${item.priority}: ${item.name}${note ? ` — ${note}` : ""}`
          );
        }
      }

      console.log(applied.join("\n"));

      if (unmatched.length > 0) {
        // Refuse the whole file. A partial apply is the worst outcome: the
        // ranking silently disagrees with what the owner handed over.
        console.error(`\n${unmatched.length} entr${unmatched.length === 1 ? "y" : "ies"} did not match:`);
        for (const u of unmatched) console.error(`  - ${u}`);
        console.error("\nNothing was written. Fix the names (or the menu) and re-run.");
        throw new DryRunRollback("unmatched entries");
      }
      if (dryRun) throw new DryRunRollback("dry run — rolling back");
      console.log(`\nApplied ${applied.length} ranking(s).`);
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
    if (unmatched.length > 0) process.exitCode = 1;
    else console.log(`\nDry run: ${applied.length} ranking(s) would be applied. Rolled back.`);
  } finally {
    await pool.end();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
