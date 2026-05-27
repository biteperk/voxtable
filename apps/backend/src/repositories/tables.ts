import { DbClient, pool } from "../db/pool";

export interface TableRow {
  id: string;
  label: string;
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
