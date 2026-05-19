import { DbClient, pool } from "../db/pool";
import { AvailableTable } from "../domain/types";

interface AvailableTableRow {
  id: string;
  label: string;
  min_capacity: number;
  max_capacity: number;
}

export async function findAvailableTable(params: {
  restaurantId: string;
  date: string;
  time: string;
  partySize: number;
  durationMinutes: number;
  excludeReservationId?: string;
}, db: DbClient = pool): Promise<AvailableTable | null> {
  const result = await db.query<AvailableTableRow>(
    `
    SELECT
      t.id,
      t.label,
      t.min_capacity,
      t.max_capacity
    FROM tables t
    WHERE t.restaurant_id = $1
      AND t.is_active = true
      AND t.min_capacity <= $2
      AND t.max_capacity >= $2
      AND NOT EXISTS (
        SELECT 1
        FROM reservations r
        WHERE r.restaurant_id = $1
          AND r.table_id = t.id
          AND r.reservation_date = $3::date
          AND r.status IN ('pending', 'confirmed')
          AND ($6::uuid IS NULL OR r.id <> $6::uuid)
          AND r.start_time < ($4::time + ($5::text || ' minutes')::interval)
          AND (r.start_time + ($5::text || ' minutes')::interval) > $4::time
      )
    ORDER BY t.max_capacity ASC, t.label ASC
    LIMIT 1
    `,
    [
      params.restaurantId,
      params.partySize,
      params.date,
      params.time,
      params.durationMinutes,
      params.excludeReservationId ?? null
    ]
  );

  const row = result.rows[0];

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    label: row.label,
    minCapacity: row.min_capacity,
    maxCapacity: row.max_capacity
  };
}
