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
  seated_at: string | null;
  completed_at: string | null;
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

/**
 * Tenant-scoped lookup: returns the reservation only if it belongs to the given
 * restaurant. Use this on dashboard id-based routes so a cross-tenant UUID
 * resolves to null (404) rather than leaking another tenant's row.
 */
export async function getReservationForTenant(
  id: string,
  restaurantId: string,
  db: DbClient = pool
): Promise<ReservationRow | null> {
  const result = await db.query<ReservationRow>(
    "SELECT * FROM reservations WHERE id = $1 AND restaurant_id = $2",
    [id, restaurantId]
  );
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
  table_zone: string | null;
  table_description: string | null;
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
      t.label AS table_label,
      t.zone AS table_zone,
      t.description AS table_description
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
    // When set, the lookup AND update are scoped to this restaurant so a
    // cross-tenant id can never be modified. Dashboard/voice callers pass it.
    restaurantId?: string;
  },
  db: DbClient = pool
): Promise<ReservationRow> {
  const current = input.restaurantId
    ? await getReservationForTenant(input.id, input.restaurantId, db)
    : await getReservationById(input.id, db);

  if (!current) {
    throw new Error("Reservation not found.");
  }

  const nextStatus = input.status ?? current.status;
  // When a booking moves OUT of "cancelled" (e.g. a dashboard restore), clear
  // the cancellation stamps so a now-active booking doesn't carry a stale
  // reason/timestamp; moving INTO cancelled stamps the time.
  const cancelledAtSql = nextStatus === "cancelled" ? "now()" : "NULL";
  const cancellationReasonSql = nextStatus === "cancelled" ? "cancellation_reason" : "NULL";

  const params: unknown[] = [
    input.id,
    input.tableId ?? null,
    input.date ?? null,
    input.time ?? null,
    input.partySize ?? null,
    input.notes ?? null,
    input.status ?? null
  ];
  let tenantClause = "";
  if (input.restaurantId) {
    params.push(input.restaurantId);
    tenantClause = `AND restaurant_id = $${params.length}`;
  }

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
      cancelled_at = ${cancelledAtSql},
      cancellation_reason = ${cancellationReasonSql}
    WHERE id = $1 ${tenantClause}
    RETURNING *
    `,
    params
  );

  if (!result.rows[0]) {
    throw new Error("Reservation not found.");
  }
  return result.rows[0];
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
    // Optional tenant guard — dashboard/voice callers pass it so a cross-tenant
    // id is a no-op (null) rather than cancelling another restaurant's booking.
    restaurantId?: string;
  },
  db: DbClient = pool
): Promise<ReservationRow | null> {
  const params: unknown[] = [input.id, input.reason ?? null];
  let tenantClause = "";
  if (input.restaurantId) {
    params.push(input.restaurantId);
    tenantClause = `AND restaurant_id = $${params.length}`;
  }

  const result = await db.query<ReservationRow>(
    `
    UPDATE reservations
    SET
      status = 'cancelled',
      cancellation_reason = $2,
      cancelled_at = now()
    WHERE id = $1
      AND status <> 'cancelled'
      ${tenantClause}
    RETURNING *
    `,
    params
  );

  return result.rows[0] ?? null;
}

// Floor-state transitions — mirror the M3 cancelReservation pattern:
// single UPDATE ... RETURNING with guard conditions, returns null on no-op so
// the route can disambiguate "already in that state" vs "not found" with a
// follow-up SELECT. Idempotency is the caller's responsibility; seating a
// row twice returns null the second time.

export async function seatReservation(
  id: string,
  restaurantId?: string,
  db: DbClient = pool
): Promise<ReservationRow | null> {
  const params: unknown[] = [id];
  let tenantClause = "";
  if (restaurantId) {
    params.push(restaurantId);
    tenantClause = `AND restaurant_id = $${params.length}`;
  }
  const result = await db.query<ReservationRow>(
    `
    UPDATE reservations
    SET seated_at = now()
    WHERE id = $1
      AND status = 'confirmed'
      AND seated_at IS NULL
      AND completed_at IS NULL
      ${tenantClause}
    RETURNING *
    `,
    params
  );

  return result.rows[0] ?? null;
}

export async function completeReservation(
  id: string,
  restaurantId?: string,
  db: DbClient = pool
): Promise<ReservationRow | null> {
  const params: unknown[] = [id];
  let tenantClause = "";
  if (restaurantId) {
    params.push(restaurantId);
    tenantClause = `AND restaurant_id = $${params.length}`;
  }
  const result = await db.query<ReservationRow>(
    `
    UPDATE reservations
    SET status = 'completed',
        completed_at = now()
    WHERE id = $1
      AND status = 'confirmed'
      AND completed_at IS NULL
      ${tenantClause}
    RETURNING *
    `,
    params
  );

  return result.rows[0] ?? null;
}
