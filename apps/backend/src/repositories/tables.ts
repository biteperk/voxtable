import { DbClient, pool } from "../db/pool";

export interface TableRow {
  id: string;
  label: string;
  min_capacity: number;
  max_capacity: number;
}

export async function listTables(
  restaurantId: string,
  db: DbClient = pool
): Promise<TableRow[]> {
  const result = await db.query<TableRow>(
    `
    SELECT
      t.id,
      t.label,
      t.min_capacity,
      t.max_capacity
    FROM tables t
    WHERE t.restaurant_id = $1
      AND t.is_active = true
    ORDER BY t.label ASC
    `,
    [restaurantId]
  );

  return result.rows;
}
