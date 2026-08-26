import { DbClient, pool, readPool } from "../db/pool";

export interface MenuCategoryRow {
  id: string;
  restaurant_id: string;
  name: string;
  display_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface MenuItemRow {
  id: string;
  restaurant_id: string;
  category_id: string;
  name: string;
  description: string | null;
  base_price_cents: number;
  is_available: boolean;
  image_url: string | null;
  image_blurhash: string | null;
  display_order: number;
  // Daily availability window, wall-clock in the restaurant TZ. Postgres TIME
  // arrives as "HH:MM:SS" — compare via toMinutes/isWithinDailyWindow, never
  // string-equality against "HH:MM". NULL = unbounded side.
  available_from: string | null;
  available_until: string | null;
  // Licensed items (alcohol): visible + staff-orderable, refused on the voice
  // path (responsible-service posture).
  is_restricted: boolean;
  created_at: string;
  updated_at: string;
}

export interface MenuItemVariantRow {
  id: string;
  menu_item_id: string;
  name: string;
  price_delta_cents: number;
  display_order: number;
}

export interface MenuItemModifierRow {
  id: string;
  menu_item_id: string;
  group_name: string;
  name: string;
  price_delta_cents: number;
  group_min_select: number;
  group_max_select: number;
  is_default: boolean;
  display_order: number;
}

/**
 * Full menu tree for a restaurant. Used by dashboard CRUD list, KDS reads,
 * and the Retell `menu_lookup` tool. Reads from the read pool — never blocks
 * the booking path.
 */
export async function getFullMenu(restaurantId: string) {
  const [categories, items, variants, modifiers] = await Promise.all([
    readPool.query<MenuCategoryRow>(
      `SELECT * FROM menu_categories WHERE restaurant_id = $1 ORDER BY display_order, name`,
      [restaurantId]
    ),
    readPool.query<MenuItemRow>(
      `SELECT * FROM menu_items WHERE restaurant_id = $1 ORDER BY display_order, name`,
      [restaurantId]
    ),
    readPool.query<MenuItemVariantRow>(
      `SELECT v.*
         FROM menu_item_variants v
         JOIN menu_items i ON i.id = v.menu_item_id
        WHERE i.restaurant_id = $1
        ORDER BY v.display_order, v.name`,
      [restaurantId]
    ),
    readPool.query<MenuItemModifierRow>(
      `SELECT m.*
         FROM menu_item_modifiers m
         JOIN menu_items i ON i.id = m.menu_item_id
        WHERE i.restaurant_id = $1
        ORDER BY m.group_name, m.display_order, m.name`,
      [restaurantId]
    )
  ]);

  return {
    categories: categories.rows,
    items: items.rows,
    variants: variants.rows,
    modifiers: modifiers.rows
  };
}

export async function createCategory(input: {
  restaurantId: string;
  name: string;
  displayOrder?: number;
}, db: DbClient = pool): Promise<MenuCategoryRow> {
  const result = await db.query<MenuCategoryRow>(
    `
    INSERT INTO menu_categories (restaurant_id, name, display_order, is_active)
    VALUES ($1, $2, $3, true)
    RETURNING *
    `,
    [input.restaurantId, input.name, input.displayOrder ?? 0]
  );
  return result.rows[0]!;
}

/**
 * Fetch a restaurant's category by name, or create it — never conflicting.
 *
 * `menu_categories` carries UNIQUE (restaurant_id, LOWER(name)), and importing a
 * menu used to plain INSERT every heading it found. A real multi-page menu
 * repeats headings ("Desserts" on page 4 and page 11), varies their case, and
 * often collides with a category the owner already typed in by hand. Any of
 * those raised 23505, rolled back the whole import, and surfaced as
 * "Something went wrong." — permanently, because every retry did the same thing.
 *
 * Matching is on LOWER(name) so it lines up exactly with the index that would
 * otherwise reject us. Scoped by restaurant_id, so tenant isolation is unchanged.
 */
export async function getOrCreateCategory(input: {
  restaurantId: string;
  name: string;
  displayOrder?: number;
}, db: DbClient = pool): Promise<MenuCategoryRow> {
  const inserted = await db.query<MenuCategoryRow>(
    `
    INSERT INTO menu_categories (restaurant_id, name, display_order, is_active)
    VALUES ($1, $2, $3, true)
    ON CONFLICT DO NOTHING
    RETURNING *
    `,
    [input.restaurantId, input.name, input.displayOrder ?? 0]
  );
  if (inserted.rows[0]) return inserted.rows[0];

  // Lost the insert — either to an existing row or to a concurrent commit.
  const existing = await db.query<MenuCategoryRow>(
    "SELECT * FROM menu_categories WHERE restaurant_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1",
    [input.restaurantId, input.name]
  );
  const row = existing.rows[0];
  if (!row) {
    // ON CONFLICT DO NOTHING covers every constraint on the table, so landing
    // here means we tripped one we can't resolve by name. Say so plainly rather
    // than returning undefined and failing further down.
    throw new Error(`Could not create or find menu category "${input.name}"`);
  }
  return row;
}

export async function updateCategory(input: {
  id: string;
  restaurantId: string;
  name?: string;
  displayOrder?: number;
  isActive?: boolean;
}, db: DbClient = pool): Promise<MenuCategoryRow | null> {
  const result = await db.query<MenuCategoryRow>(
    `
    UPDATE menu_categories
       SET name          = COALESCE($3, name),
           display_order = COALESCE($4, display_order),
           is_active     = COALESCE($5, is_active)
     WHERE id = $1 AND restaurant_id = $2
     RETURNING *
    `,
    [input.id, input.restaurantId, input.name ?? null, input.displayOrder ?? null, input.isActive ?? null]
  );
  return result.rows[0] ?? null;
}

export async function deleteCategory(id: string, restaurantId: string, db: DbClient = pool): Promise<boolean> {
  const result = await db.query(
    `DELETE FROM menu_categories WHERE id = $1 AND restaurant_id = $2`,
    [id, restaurantId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function createMenuItem(input: {
  restaurantId: string;
  categoryId: string;
  name: string;
  description?: string;
  basePriceCents: number;
  imageUrl?: string;
  imageBlurhash?: string;
  displayOrder?: number;
  availableFrom?: string | null;
  availableUntil?: string | null;
  isRestricted?: boolean;
}, db: DbClient = pool): Promise<MenuItemRow> {
  const result = await db.query<MenuItemRow>(
    `
    INSERT INTO menu_items (
      restaurant_id, category_id, name, description,
      base_price_cents, image_url, image_blurhash, display_order, is_available,
      available_from, available_until, is_restricted
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $10, $11)
    RETURNING *
    `,
    [
      input.restaurantId,
      input.categoryId,
      input.name,
      input.description ?? null,
      input.basePriceCents,
      input.imageUrl ?? null,
      input.imageBlurhash ?? null,
      input.displayOrder ?? 0,
      input.availableFrom ?? null,
      input.availableUntil ?? null,
      input.isRestricted ?? false
    ]
  );
  return result.rows[0]!;
}

export async function updateMenuItem(input: {
  id: string;
  restaurantId: string;
  categoryId?: string;
  name?: string;
  description?: string | null;
  basePriceCents?: number;
  imageUrl?: string | null;
  imageBlurhash?: string | null;
  displayOrder?: number;
  isAvailable?: boolean;
  availableFrom?: string | null;
  availableUntil?: string | null;
  isRestricted?: boolean;
}, db: DbClient = pool): Promise<MenuItemRow | null> {
  // The window columns distinguish "field omitted" (keep the current value)
  // from "explicit null" (clear back to all-day): a provided flag drives a
  // CASE instead of COALESCE, because COALESCE cannot express clearing.
  // description keeps the COALESCE limitation (set-or-change but not clear) —
  // an accepted launch trade, unchanged here.
  const result = await db.query<MenuItemRow>(
    `
    UPDATE menu_items
       SET category_id      = COALESCE($3, category_id),
           name             = COALESCE($4, name),
           description      = COALESCE($5, description),
           base_price_cents = COALESCE($6, base_price_cents),
           image_url        = COALESCE($7, image_url),
           image_blurhash   = COALESCE($8, image_blurhash),
           display_order    = COALESCE($9, display_order),
           is_available     = COALESCE($10, is_available),
           available_from   = CASE WHEN $14::boolean THEN $11::time ELSE available_from END,
           available_until  = CASE WHEN $15::boolean THEN $12::time ELSE available_until END,
           is_restricted    = COALESCE($13, is_restricted)
     WHERE id = $1 AND restaurant_id = $2
     RETURNING *
    `,
    [
      input.id,
      input.restaurantId,
      input.categoryId ?? null,
      input.name ?? null,
      input.description ?? null,
      input.basePriceCents ?? null,
      input.imageUrl ?? null,
      input.imageBlurhash ?? null,
      input.displayOrder ?? null,
      input.isAvailable ?? null,
      input.availableFrom ?? null,
      input.availableUntil ?? null,
      input.isRestricted ?? null,
      input.availableFrom !== undefined,
      input.availableUntil !== undefined
    ]
  );
  return result.rows[0] ?? null;
}

export async function deleteMenuItem(id: string, restaurantId: string, db: DbClient = pool): Promise<boolean> {
  const result = await db.query(
    `DELETE FROM menu_items WHERE id = $1 AND restaurant_id = $2`,
    [id, restaurantId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function replaceVariants(
  menuItemId: string,
  variants: Array<{ name: string; priceDeltaCents: number; displayOrder: number }>,
  db: DbClient = pool
): Promise<void> {
  await db.query(`DELETE FROM menu_item_variants WHERE menu_item_id = $1`, [menuItemId]);
  for (const v of variants) {
    await db.query(
      `INSERT INTO menu_item_variants (menu_item_id, name, price_delta_cents, display_order)
       VALUES ($1, $2, $3, $4)`,
      [menuItemId, v.name, v.priceDeltaCents, v.displayOrder]
    );
  }
}

export async function replaceModifiers(
  menuItemId: string,
  modifiers: Array<{
    groupName: string;
    name: string;
    priceDeltaCents: number;
    groupMinSelect: number;
    groupMaxSelect: number;
    isDefault: boolean;
    displayOrder: number;
  }>,
  db: DbClient = pool
): Promise<void> {
  await db.query(`DELETE FROM menu_item_modifiers WHERE menu_item_id = $1`, [menuItemId]);
  for (const m of modifiers) {
    await db.query(
      `INSERT INTO menu_item_modifiers (
         menu_item_id, group_name, name, price_delta_cents,
         group_min_select, group_max_select, is_default, display_order
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        menuItemId,
        m.groupName,
        m.name,
        m.priceDeltaCents,
        m.groupMinSelect,
        m.groupMaxSelect,
        m.isDefault,
        m.displayOrder
      ]
    );
  }
}

/**
 * Resolve a list of menu_item_ids to their priceable rows (item + optional
 * variant + zero or more modifiers) INSIDE the caller's txn. Returns enough
 * to compute snapshotted prices. Locks rows FOR SHARE so a concurrent
 * UPDATE on `is_available` or price can't race us.
 */
export async function loadMenuItemsForOrder(
  itemIds: string[],
  restaurantId: string,
  db: DbClient
): Promise<MenuItemRow[]> {
  if (itemIds.length === 0) return [];
  const result = await db.query<MenuItemRow>(
    `SELECT * FROM menu_items WHERE restaurant_id = $1 AND id = ANY($2::uuid[]) FOR SHARE`,
    [restaurantId, itemIds]
  );
  return result.rows;
}

export async function loadVariantsForItems(
  itemIds: string[],
  db: DbClient
): Promise<MenuItemVariantRow[]> {
  if (itemIds.length === 0) return [];
  const result = await db.query<MenuItemVariantRow>(
    `SELECT * FROM menu_item_variants WHERE menu_item_id = ANY($1::uuid[])`,
    [itemIds]
  );
  return result.rows;
}

export async function loadModifiersForItems(
  itemIds: string[],
  db: DbClient
): Promise<MenuItemModifierRow[]> {
  if (itemIds.length === 0) return [];
  const result = await db.query<MenuItemModifierRow>(
    `SELECT * FROM menu_item_modifiers WHERE menu_item_id = ANY($1::uuid[])`,
    [itemIds]
  );
  return result.rows;
}

/**
 * Fuzzy search for the Retell `menu_lookup` tool. pg_trgm similarity against
 * LOWER(name) using the GIN index from migration 006. Returns top N matches,
 * available items only.
 */
export async function searchMenuItemsByName(
  restaurantId: string,
  query: string,
  limit = 6,
  // Ordering deliberately looks at unavailable items too. Filtering them out in
  // SQL is what let a caller order "Fish & Chips" (unavailable) and silently
  // receive "Chips": the exact match vanished from the result set and the next
  // best remaining row was taken as if it were what they asked for. The caller
  // must be TOLD the dish is off, never handed a different one — so the search
  // can see them and the caller decides. See resolveOrderItem in retellService.
  options: { includeUnavailable?: boolean } = {}
): Promise<Array<MenuItemRow & { similarity: number }>> {
  const result = await readPool.query<MenuItemRow & { similarity: number }>(
    `SELECT *, similarity(LOWER(name), LOWER($2)) AS similarity
       FROM menu_items
      WHERE restaurant_id = $1
        AND ($4::boolean OR is_available = true)
        -- A caller who asks for a burger must be told there is no burger, not
        -- offered a ginger beer. That happened on a real call: trigram
        -- similarity scored "Ginger Beer" against "burger" at exactly 0.200 —
        -- they share "ger" — and squeaked past a > 0.2 filter on floating point.
        --
        -- A higher bare threshold would also drop honest near-misses ("frappe"
        -- against "Mango & Passionfruit Frappe" is only 0.269), so the rule is
        -- containment OR a real similarity: a query the caller actually said
        -- that appears inside the dish name is a match at any score, and
        -- anything else must clear 0.3. Measured against this venue's menu,
        -- that keeps every genuine hit and drops the nonsense one.
        AND (
          strpos(LOWER(name), LOWER($2)) > 0
          OR similarity(LOWER(name), LOWER($2)) >= 0.3
        )
      ORDER BY similarity DESC
      LIMIT $3`,
    [restaurantId, query, limit, options.includeUnavailable === true]
  );
  return result.rows;
}
