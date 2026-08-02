import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

import { env } from "../config/env";
import { DEFAULT_OPENING_HOURS } from "../domain/types";
import { normalizePhone } from "../utils/phone";
import { closePool, pool } from "./pool";

const faq = {
  address: "Natalia's Bistro is in Sydney. Confirm the exact street address with staff before production launch.",
  parking: "Street parking is available nearby.",
  dietary: "The restaurant can note dietary requests on the booking, but staff will confirm details.",
  groups: "Groups above 10 should be transferred to staff."
};

const voiceConfig = {
  language: "en-AU",
  voiceProvider: "retellai",
  telephonyProvider: "twilio",
  modelCandidates: ["claude-sonnet-4.6", "gpt-4o"],
  humanTransferEnabled: true
};

async function seed(): Promise<void> {
  if (env.APP_ENV === "production") {
    throw new Error("Refusing to run seed data in production. Seeding is local-only and must be requested with SEED_DATA=true in deploy/scripts/run-local.sh.");
  }

  const restaurantId = env.DEFAULT_RESTAURANT_ID;

  // Voice-routing numbers (migration 007) are stored normalized to E.164 so the
  // dialed-number → restaurant lookup matches regardless of input format.
  const twilioNumber = normalizePhone(env.TWILIO_PHONE_NUMBER) ?? env.TWILIO_PHONE_NUMBER ?? null;
  const retellNumber = normalizePhone(env.RETELL_PHONE_NUMBER) ?? env.RETELL_PHONE_NUMBER ?? null;

  await pool.query(
    `
    INSERT INTO restaurants (
      id, name, timezone, phone_number, transfer_phone_number,
      twilio_phone_number, retell_phone_number
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      timezone = EXCLUDED.timezone,
      phone_number = EXCLUDED.phone_number,
      transfer_phone_number = EXCLUDED.transfer_phone_number,
      twilio_phone_number = EXCLUDED.twilio_phone_number,
      retell_phone_number = EXCLUDED.retell_phone_number;
    `,
    [
      restaurantId,
      "Natalia's Bistro",
      "Australia/Sydney",
      twilioNumber ?? retellNumber,
      null,
      twilioNumber,
      retellNumber
    ]
  );

  await pool.query(
    `
    INSERT INTO restaurant_settings (
      restaurant_id,
      booking_duration_minutes,
      opening_hours_json,
      faq_json,
      voice_config_json
    )
    VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb)
    ON CONFLICT (restaurant_id) DO UPDATE SET
      booking_duration_minutes = EXCLUDED.booking_duration_minutes,
      opening_hours_json = EXCLUDED.opening_hours_json,
      faq_json = EXCLUDED.faq_json,
      voice_config_json = EXCLUDED.voice_config_json;
    `,
    [
      restaurantId,
      90,
      JSON.stringify(DEFAULT_OPENING_HOURS),
      JSON.stringify(faq),
      JSON.stringify(voiceConfig)
    ]
  );

  // [label, minCapacity, maxCapacity, zone, description]
  // zone is the coarse area used for booking-log/floor-view badges (migration
  // 013); description is the free-text "what kind of table" shown next to the
  // mapping. Display-only — the voice path still assigns by capacity alone.
  const tables: Array<[string, number, number, string, string]> = [
    ["T1", 1, 2, "window", "Window two-top overlooking the street"],
    ["T2", 1, 2, "window", "Quiet window two-top"],
    ["T3", 2, 4, "main", "Main-floor table for four"],
    ["T4", 2, 4, "patio", "Outdoor patio table (weather permitting)"],
    ["T5", 4, 6, "main", "Central round table, seats up to six"],
    ["T6", 6, 8, "booth", "Large corner booth"],
    ["T7", 8, 10, "private", "Private back room for large parties"]
  ];

  for (const [label, minCapacity, maxCapacity, zone, description] of tables) {
    await pool.query(
      `
      INSERT INTO tables (restaurant_id, label, min_capacity, max_capacity, zone, description, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, true)
      ON CONFLICT (restaurant_id, label) DO UPDATE SET
        min_capacity = EXCLUDED.min_capacity,
        max_capacity = EXCLUDED.max_capacity,
        zone = EXCLUDED.zone,
        description = EXCLUDED.description,
        is_active = true;
      `,
      [restaurantId, label, minCapacity, maxCapacity, zone, description]
    );
  }

  await seedMenu(restaurantId);
  await backfillMultitenancy(restaurantId);

  console.log(`Seeded Natalia restaurant ${restaurantId}`);
}

/**
 * Translate the legacy email allowlist into the new tenancy tables: create a
 * `users` row + an owner/manager/staff `restaurant_members` row for each
 * allowlisted email, mapped to the default restaurant. Idempotent.
 *
 * Degrades gracefully:
 *   - skips silently if tenancy tables are absent,
 *   - skips if no allowlist is configured (dev = any verified account),
 *   - skips an email if Firebase Admin can't resolve its uid (no service
 *     account locally, or the user hasn't signed in yet). Since the
 *     MULTITENANCY_LEGACY_FALLBACK bridge was removed (migration 027) there is
 *     nothing behind this: such a user gets 403 NO_RESTAURANT_MEMBERSHIP until
 *     they sign in once and the seed is re-run, or a row is inserted by hand.
 */
async function backfillMultitenancy(restaurantId: string): Promise<void> {
  const tablesExist = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass('restaurant_members') IS NOT NULL AS exists`
  );
  if (!tablesExist.rows[0]?.exists) {
    console.log("Skipping multitenancy backfill — tenancy tables not yet applied");
    return;
  }

  const allowed = (env.DASHBOARD_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const managers = new Set(
    (env.DASHBOARD_MANAGER_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  const kitchen = new Set(
    (env.DASHBOARD_KITCHEN_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );

  if (allowed.length === 0) {
    console.log("Skipping multitenancy backfill — no DASHBOARD_ALLOWED_EMAILS configured");
    return;
  }

  if (!env.FIREBASE_PROJECT_ID) {
    console.log("Skipping multitenancy backfill — FIREBASE_PROJECT_ID not set (legacy fallback covers access)");
    return;
  }

  try {
    if (getApps().length === 0) {
      initializeApp({
        credential: applicationDefault(),
        projectId: env.FIREBASE_PROJECT_ID
      });
    }
  } catch (error) {
    console.log("Skipping multitenancy backfill — Firebase Admin init failed:", (error as Error).message);
    return;
  }

  let created = 0;
  for (const email of allowed) {
    try {
      const fbUser = await getAuth().getUserByEmail(email);
      const role = managers.has(email)
        ? "manager"
        : kitchen.has(email)
          ? "kitchen"
          : "staff";
      await pool.query(
        `INSERT INTO users (id, email, name, email_verified)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, updated_at = now()`,
        [fbUser.uid, email, fbUser.displayName ?? null, fbUser.emailVerified === true]
      );
      await pool.query(
        `INSERT INTO restaurant_members (user_id, restaurant_id, role)
         VALUES ($1, $2, $3::member_role)
         ON CONFLICT (user_id, restaurant_id) DO UPDATE SET role = EXCLUDED.role, updated_at = now()`,
        [fbUser.uid, restaurantId, role]
      );
      created += 1;
    } catch (error) {
      console.log(`  · skipped ${email}: ${(error as Error).message}`);
    }
  }
  console.log(`Multitenancy backfill: linked ${created}/${allowed.length} allowlisted user(s) to ${restaurantId}`);
}

// Idempotent KDS menu seed. Skipped silently if menu tables are absent.
async function seedMenu(restaurantId: string): Promise<void> {
  const menuTablesExist = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass('menu_items') IS NOT NULL AS exists`
  );
  if (!menuTablesExist.rows[0]?.exists) {
    console.log("Skipping menu seed — menu tables not yet applied");
    return;
  }

  type CategorySeed = {
    name: string;
    display_order: number;
    items: ItemSeed[];
  };

  type ItemSeed = {
    name: string;
    description?: string;
    base_price_cents: number;
    display_order: number;
    variants?: Array<{ name: string; price_delta_cents: number; display_order: number }>;
    modifiers?: Array<{
      group_name: string;
      group_min_select: number;
      group_max_select: number;
      options: Array<{ name: string; price_delta_cents: number; is_default?: boolean }>;
    }>;
  };

  const menu: CategorySeed[] = [
    {
      name: "Mains",
      display_order: 1,
      items: [
        {
          name: "Fish & Chips",
          description: "Beer-battered flathead with hand-cut chips and tartare.",
          base_price_cents: 2200,
          display_order: 1,
          variants: [
            { name: "Small", price_delta_cents: -800, display_order: 1 },
            { name: "Medium", price_delta_cents: 0, display_order: 2 },
            { name: "Large", price_delta_cents: 400, display_order: 3 }
          ],
          modifiers: [
            {
              group_name: "Drink",
              group_min_select: 1,
              group_max_select: 1,
              options: [
                { name: "Coke", price_delta_cents: 0, is_default: true },
                { name: "Lemonade", price_delta_cents: 0 },
                { name: "Fanta", price_delta_cents: 0 },
                { name: "Sparkling Water", price_delta_cents: 0 }
              ]
            },
            {
              group_name: "Extras",
              group_min_select: 0,
              group_max_select: 3,
              options: [
                { name: "Extra Tartare", price_delta_cents: 150 },
                { name: "Lemon Wedges", price_delta_cents: 0 },
                { name: "Aioli", price_delta_cents: 150 }
              ]
            }
          ]
        },
        {
          name: "Spaghetti Bolognese",
          description: "Slow-cooked beef ragu, parmesan, fresh basil.",
          base_price_cents: 2400,
          display_order: 2,
          modifiers: [
            {
              group_name: "Extras",
              group_min_select: 0,
              group_max_select: 2,
              options: [
                { name: "Extra Parmesan", price_delta_cents: 200 },
                { name: "Chilli Flakes", price_delta_cents: 0 }
              ]
            }
          ]
        },
        {
          name: "Margherita Pizza",
          description: "San Marzano, fior di latte, basil.",
          base_price_cents: 2200,
          display_order: 3
        }
      ]
    },
    {
      name: "Salads & Sides",
      display_order: 2,
      items: [
        {
          name: "Caesar Salad",
          description: "Cos lettuce, anchovies, parmesan, soft-poached egg.",
          base_price_cents: 1900,
          display_order: 1,
          modifiers: [
            {
              group_name: "Add",
              group_min_select: 0,
              group_max_select: 2,
              options: [
                { name: "Grilled Chicken", price_delta_cents: 500 },
                { name: "Smoked Bacon", price_delta_cents: 300 }
              ]
            }
          ]
        },
        {
          name: "Garden Salad",
          base_price_cents: 1400,
          display_order: 2
        },
        {
          name: "Hand-Cut Chips",
          base_price_cents: 900,
          display_order: 3
        }
      ]
    },
    {
      name: "Kids",
      display_order: 3,
      items: [
        {
          name: "Kids Fish & Chips",
          base_price_cents: 1200,
          display_order: 1
        }
      ]
    },
    {
      name: "Drinks",
      display_order: 4,
      items: [
        { name: "Coke", base_price_cents: 500, display_order: 1 },
        { name: "Lemonade", base_price_cents: 500, display_order: 2 },
        { name: "Sparkling Water 750ml", base_price_cents: 700, display_order: 3 }
      ]
    }
  ];

  for (const category of menu) {
    const categoryRow = await pool.query<{ id: string }>(
      `
      INSERT INTO menu_categories (restaurant_id, name, display_order, is_active)
      VALUES ($1, $2, $3, true)
      ON CONFLICT (restaurant_id, LOWER(name)) DO UPDATE SET
        display_order = EXCLUDED.display_order,
        is_active = true
      RETURNING id
      `,
      [restaurantId, category.name, category.display_order]
    );
    const categoryId = categoryRow.rows[0]!.id;

    for (const item of category.items) {
      // No UNIQUE on (restaurant_id, name) for menu_items so we manually
      // upsert: find-or-update-or-insert. Keeps the seed idempotent.
      const existing = await pool.query<{ id: string }>(
        `SELECT id FROM menu_items WHERE restaurant_id = $1 AND category_id = $2 AND LOWER(name) = LOWER($3)`,
        [restaurantId, categoryId, item.name]
      );
      let itemId: string;
      if (existing.rows[0]) {
        itemId = existing.rows[0].id;
        await pool.query(
          `
          UPDATE menu_items
             SET description = $1,
                 base_price_cents = $2,
                 display_order = $3,
                 is_available = true
           WHERE id = $4
          `,
          [item.description ?? null, item.base_price_cents, item.display_order, itemId]
        );
      } else {
        const inserted = await pool.query<{ id: string }>(
          `
          INSERT INTO menu_items (
            restaurant_id, category_id, name, description, base_price_cents, display_order, is_available
          )
          VALUES ($1, $2, $3, $4, $5, $6, true)
          RETURNING id
          `,
          [restaurantId, categoryId, item.name, item.description ?? null, item.base_price_cents, item.display_order]
        );
        itemId = inserted.rows[0]!.id;
      }

      for (const variant of item.variants ?? []) {
        await pool.query(
          `
          INSERT INTO menu_item_variants (menu_item_id, name, price_delta_cents, display_order)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (menu_item_id, name) DO UPDATE SET
            price_delta_cents = EXCLUDED.price_delta_cents,
            display_order = EXCLUDED.display_order
          `,
          [itemId, variant.name, variant.price_delta_cents, variant.display_order]
        );
      }

      let modifierIndex = 0;
      for (const group of item.modifiers ?? []) {
        for (const option of group.options) {
          modifierIndex += 1;
          await pool.query(
            `
            INSERT INTO menu_item_modifiers (
              menu_item_id, group_name, name, price_delta_cents,
              group_min_select, group_max_select, is_default, display_order
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (menu_item_id, group_name, name) DO UPDATE SET
              price_delta_cents = EXCLUDED.price_delta_cents,
              group_min_select = EXCLUDED.group_min_select,
              group_max_select = EXCLUDED.group_max_select,
              is_default = EXCLUDED.is_default,
              display_order = EXCLUDED.display_order
            `,
            [
              itemId,
              group.group_name,
              option.name,
              option.price_delta_cents,
              group.group_min_select,
              group.group_max_select,
              option.is_default ?? false,
              modifierIndex
            ]
          );
        }
      }
    }
  }
  console.log("Seeded KDS menu (categories, items, variants, modifiers)");
}

seed()
  .then(async () => {
    await closePool();
  })
  .catch(async (error) => {
    console.error(error);
    await closePool();
    process.exit(1);
  });
