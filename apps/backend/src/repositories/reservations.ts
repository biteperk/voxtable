import { DbClient, pool } from "../db/pool";
import { BookingSource, ReservationStatus } from "../domain/types";

export interface ReservationRow {
  id: string;
  restaurant_id: string;
  customer_id: string;
  table_id: string | null;
  reservation_date: string;
  start_time: string;
  party_size: number;
  status: ReservationStatus;
  source: BookingSource;
  notes: string | null;
  cancellation_reason: string | null;
  created_from_call_log_id: string | null;
  calcom_booking_uid: string | null;
}

export async function upsertCustomer(input: {
  restaurantId: string;
  name: string;
  phone: string;
}, db: DbClient = pool): Promise<string> {
  const result = await db.query<{ id: string }>(
    `
    INSERT INTO customers (restaurant_id, name, phone)
    VALUES ($1, $2, $3)
    ON CONFLICT (restaurant_id, phone) DO UPDATE SET
      name = EXCLUDED.name
    RETURNING id
    `,
    [input.restaurantId, input.name, input.phone]
  );

  return result.rows[0]!.id;
}

export async function createReservation(input: {
  restaurantId: string;
  customerId: string;
  tableId: string;
  date: string;
  time: string;
  partySize: number;
  source: BookingSource;
  notes?: string;
  callLogId?: string;
}, db: DbClient = pool): Promise<ReservationRow> {
  const result = await db.query<ReservationRow>(
    `
    INSERT INTO reservations (
      restaurant_id,
      customer_id,
      table_id,
      reservation_date,
      start_time,
      party_size,
      status,
      source,
      notes,
      created_from_call_log_id
    )
    VALUES ($1, $2, $3, $4::date, $5::time, $6, 'confirmed', $7, $8, $9)
    RETURNING *
    `,
    [
      input.restaurantId,
      input.customerId,
      input.tableId,
      input.date,
      input.time,
      input.partySize,
      input.source,
      input.notes ?? null,
      input.callLogId ?? null
    ]
  );

  return result.rows[0]!;
}

export async function getReservationById(
  id: string,
  db: DbClient = pool
): Promise<ReservationRow | null> {
  const result = await db.query<ReservationRow>("SELECT * FROM reservations WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

export async function getReservationByCallLogId(callLogId: string): Promise<ReservationRow | null> {
  const result = await pool.query<ReservationRow>(
    `SELECT * FROM reservations
     WHERE created_from_call_log_id = $1
       AND status NOT IN ('cancelled', 'no_show')
     ORDER BY created_at DESC
     LIMIT 1`,
    [callLogId]
  );
  return result.rows[0] ?? null;
}

export interface ReservationListItem extends ReservationRow {
  customer_name: string;
  customer_phone: string;
  table_label: string | null;
}

export async function listReservations(input: {
  restaurantId: string;
  date?: string;
  limit?: number;
}): Promise<ReservationListItem[]> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const params: unknown[] = [input.restaurantId];
  let whereDate = "";

  if (input.date) {
    params.push(input.date);
    whereDate = `AND r.reservation_date = $${params.length}::date`;
  }

  params.push(limit);

  const result = await pool.query<ReservationListItem>(
    `
    SELECT
      r.*,
      c.name AS customer_name,
      c.phone AS customer_phone,
      t.label AS table_label
    FROM reservations r
    JOIN customers c ON c.id = r.customer_id
    LEFT JOIN tables t ON t.id = r.table_id
    WHERE r.restaurant_id = $1 ${whereDate}
    ORDER BY r.reservation_date DESC, r.start_time DESC, r.created_at DESC
    LIMIT $${params.length}
    `,
    params
  );

  return result.rows;
}

export async function updateReservation(
  input: {
    id: string;
    tableId?: string | null;
    date?: string;
    time?: string;
    partySize?: number;
    notes?: string | null;
    status?: ReservationStatus;
  },
  db: DbClient = pool
): Promise<ReservationRow> {
  const current = await getReservationById(input.id, db);

  if (!current) {
    throw new Error("Reservation not found.");
  }

  const nextStatus = input.status ?? current.status;
  const cancelledAtSql = nextStatus === "cancelled" ? "now()" : "cancelled_at";

  const result = await db.query<ReservationRow>(
    `
    UPDATE reservations
    SET
      table_id = COALESCE($2, table_id),
      reservation_date = COALESCE($3::date, reservation_date),
      start_time = COALESCE($4::time, start_time),
      party_size = COALESCE($5, party_size),
      notes = COALESCE($6, notes),
      status = COALESCE($7::reservation_status, status),
      cancelled_at = ${cancelledAtSql}
    WHERE id = $1
    RETURNING *
    `,
    [
      input.id,
      input.tableId ?? null,
      input.date ?? null,
      input.time ?? null,
      input.partySize ?? null,
      input.notes ?? null,
      input.status ?? null
    ]
  );

  return result.rows[0]!;
}

/**
 * Stamp a successful Cal.com push uid onto our reservation. Called by the
 * outbox worker after `POST /v2/bookings` returns 200. UNIQUE constraint on
 * `idx_reservations_calcom_uid` means duplicate uids fail loudly — a signal
 * we'd be double-pushing.
 *
 * Pass a transaction client (`db`) when called inside one (the executor does
 * this); falls back to the pool otherwise.
 */
export async function updateReservationCalcomUid(
  reservationId: string,
  uid: string,
  db: DbClient = pool
): Promise<void> {
  await db.query(
    "UPDATE reservations SET calcom_booking_uid = $2 WHERE id = $1",
    [reservationId, uid]
  );
}

/**
 * Look up a reservation by its Cal.com booking uid. Used by the inbox handler
 * for loop prevention: when we receive `BOOKING_CREATED` for a uid we already
 * stamped on a reservation, we know we created that booking ourselves and skip
 * the side-effect path.
 */
export async function findReservationByCalcomUid(
  uid: string,
  db: DbClient = pool
): Promise<ReservationRow | null> {
  const result = await db.query<ReservationRow>(
    "SELECT * FROM reservations WHERE calcom_booking_uid = $1 LIMIT 1",
    [uid]
  );
  return result.rows[0] ?? null;
}

/**
 * Atomically transition a reservation to cancelled. Returns the cancelled row,
 * or null if the row was already cancelled (so a concurrent second caller is a
 * no-op rather than re-firing the Cal.com cancel webhook).
 *
 * Audit fix M3 — the previous version always returned a row, which meant two
 * racing cancels both succeeded and both enqueued a Cal.com cancel-outbox
 * push. Cal.com's idempotency key absorbs the duplicate at the upstream end,
 * but we'd still double-write the outbox + emit duplicate logs.
 */
export async function cancelReservation(
  input: {
    id: string;
    reason?: string;
  },
  db: DbClient = pool
): Promise<ReservationRow | null> {
  const result = await db.query<ReservationRow>(
    `
    UPDATE reservations
    SET
      status = 'cancelled',
      cancellation_reason = $2,
      cancelled_at = now()
    WHERE id = $1
      AND status <> 'cancelled'
    RETURNING *
    `,
    [input.id, input.reason ?? null]
  );

  return result.rows[0] ?? null;
}
