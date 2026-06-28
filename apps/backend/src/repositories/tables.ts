import { DbClient, pool } from "../db/pool";

export interface TableRow {
  id: string;
  label: string;
  zone: string | null;
  description: string | null;
  min_capacity: number;
  max_capacity: number;
  reservation_id: string | null;
  reservation_start_time: string | null;
  reservation_party_size: number | null;
  reservation_seated_at: string | null;
  customer_name: string | null;
}

// LEFT JOIN LATERAL picks the soonest still-active reservation for `today`
// per table — that naturally prefers the currently-seated party over later
// arrivals because start_time orders ascending. Status filter mirrors the
// partial unique index from migration 005 so what blocks a re-book here is
// the same set that blocks the index.
export async function listTables(
  restaurantId: string,
  today: string,
  db: DbClient = pool
): Promise<TableRow[]> {
  const result = await db.query<TableRow>(
    `
    SELECT
      t.id,
      t.label,
      t.zone,
      t.description,
      t.min_capacity,
      t.max_capacity,
      r.id          AS reservation_id,
      r.start_time  AS reservation_start_time,
      r.party_size  AS reservation_party_size,
      r.seated_at   AS reservation_seated_at,
      c.name        AS customer_name
    FROM tables t
    LEFT JOIN LATERAL (
      SELECT r2.id, r2.customer_id, r2.start_time, r2.party_size, r2.seated_at
      FROM reservations r2
      WHERE r2.table_id = t.id
        AND r2.reservation_date = $2::date
        AND r2.status NOT IN ('cancelled', 'no_show', 'completed')
      ORDER BY r2.start_time ASC
      LIMIT 1
    ) r ON true
    LEFT JOIN customers c ON c.id = r.customer_id
    WHERE t.restaurant_id = $1
      AND t.is_active = true
    ORDER BY t.label ASC
    `,
    [restaurantId, today]
  );

  return result.rows;
}

export interface TableMetaRow {
  id: string;
  label: string;
  zone: string | null;
  description: string | null;
}

/**
 * Manager edit of a table's display-only metadata (zone + description, migration
 * 013). Tenant-scoped: the UPDATE is keyed on (id, restaurant_id) so a
 * cross-tenant id touches nothing and resolves to null (→ 404 at the route).
 *
 * Only the fields present on `patch` are written — a present `null` clears the
 * column, an absent key leaves it unchanged — so the same endpoint can set or
 * clear either field independently. Returns the updated row, or null if no
 * active table matched.
 */
export async function updateTableMetadata(
  restaurantId: string,
  tableId: string,
  patch: { zone?: string | null; description?: string | null },
  db: DbClient = pool
): Promise<TableMetaRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [tableId, restaurantId];

  if ("zone" in patch) {
    params.push(patch.zone ?? null);
    sets.push(`zone = $${params.length}`);
  }
  if ("description" in patch) {
    params.push(patch.description ?? null);
    sets.push(`description = $${params.length}`);
  }
  if (sets.length === 0) {
    return null;
  }

  const result = await db.query<TableMetaRow>(
    `
    UPDATE tables
    SET ${sets.join(", ")}
    WHERE id = $1 AND restaurant_id = $2 AND is_active = true
    RETURNING id, label, zone, description
    `,
    params
  );

  return result.rows[0] ?? null;
}
