import { DbClient, pool } from "../db/pool";
import { AvailableTable } from "../domain/types";

interface AvailableTableRow {
  id: string;
  label: string;
  min_capacity: number;
  max_capacity: number;
  zone: string | null;
  description: string | null;
  attributes: string[];
}

export async function findAvailableTable(params: {
  restaurantId: string;
  date: string;
  time: string;
  partySize: number;
  durationMinutes: number;
  seatingPreference?: string | null;
  excludeReservationId?: string;
}, db: DbClient = pool): Promise<AvailableTable | null> {
  const preference = params.seatingPreference?.trim() || null;
  const result = await db.query<AvailableTableRow>(
    `
    SELECT
      t.id,
      t.label,
      t.min_capacity,
      t.max_capacity,
      t.zone,
      t.description,
      t.attributes
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
          -- Overlap is computed on full timestamps, not bare TIME values.
          -- '23:00'::time + interval '90 minutes' wraps to 00:30 the SAME day,
          -- so a late booking looked like it ended before it started and every
          -- overlap test returned false. Anchoring both intervals to the date
          -- makes 23:00 + 90 minutes land on 00:30 the NEXT day, as it should.
          -- The existing reservation uses its own snapshotted duration rather
          -- than the restaurant's current setting, so changing that setting can
          -- no longer retroactively shorten bookings that were already sold.
          AND (
            ($3::date + r.start_time,
             $3::date + r.start_time + make_interval(mins => r.duration_minutes))
            OVERLAPS
            ($3::date + $4::time,
             $3::date + $4::time + make_interval(mins => $5::int))
          )
      )
    ORDER BY
      CASE
        WHEN $7::text IS NULL THEN 0
        WHEN t.zone ILIKE '%' || $7::text || '%' THEN 0
        WHEN t.description ILIKE '%' || $7::text || '%' THEN 0
        WHEN EXISTS (
          SELECT 1 FROM unnest(t.attributes) attr
          WHERE attr ILIKE '%' || $7::text || '%'
        ) THEN 0
        ELSE 1
      END,
      t.max_capacity ASC,
      t.label ASC
    LIMIT 1
    `,
    [
      params.restaurantId,
      params.partySize,
      params.date,
      params.time,
      params.durationMinutes,
      params.excludeReservationId ?? null,
      preference
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
    maxCapacity: row.max_capacity,
    zone: row.zone,
    description: row.description,
    attributes: row.attributes
  };
}

export async function listAvailableTables(params: {
  restaurantId: string;
  date: string;
  time: string;
  partySize: number;
  durationMinutes: number;
  excludeReservationId?: string;
}, db: DbClient = pool): Promise<AvailableTable[]> {
  const result = await db.query<AvailableTableRow>(
    `
    SELECT
      t.id,
      t.label,
      t.min_capacity,
      t.max_capacity,
      t.zone,
      t.description,
      t.attributes
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
          -- Overlap is computed on full timestamps, not bare TIME values.
          -- '23:00'::time + interval '90 minutes' wraps to 00:30 the SAME day,
          -- so a late booking looked like it ended before it started and every
          -- overlap test returned false. Anchoring both intervals to the date
          -- makes 23:00 + 90 minutes land on 00:30 the NEXT day, as it should.
          -- The existing reservation uses its own snapshotted duration rather
          -- than the restaurant's current setting, so changing that setting can
          -- no longer retroactively shorten bookings that were already sold.
          AND (
            ($3::date + r.start_time,
             $3::date + r.start_time + make_interval(mins => r.duration_minutes))
            OVERLAPS
            ($3::date + $4::time,
             $3::date + $4::time + make_interval(mins => $5::int))
          )
      )
    ORDER BY t.max_capacity ASC, t.label ASC
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

  return result.rows.map((row) => ({
    id: row.id,
    label: row.label,
    minCapacity: row.min_capacity,
    maxCapacity: row.max_capacity,
    zone: row.zone,
    description: row.description,
    attributes: row.attributes
  }));
}
