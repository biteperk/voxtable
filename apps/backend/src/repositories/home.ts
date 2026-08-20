/**
 * Home summary — the venue's service state right now, in one query.
 *
 * Deliberately one round trip. The home page's whole premise is answering
 * "what's happening in my venue" fast enough to be worth glancing at, and three
 * sequential queries behind three role-gated endpoints is how that premise dies.
 */

import { DbClient, readPool } from "../db/pool";

export interface HomeSummaryRow {
  covers_booked: number;
  bookings_today: number;
  orders_waiting: number;
  calls_answered: number;
  next_booking_time: string | null;
}

/**
 * `localDate` is the venue's OWN calendar day (utils/time todayInTz), not the
 * server's. `date_trunc('day', now())` would be UTC — for a Sydney venue that
 * rolls over at 10am local, so a strip headed TONIGHT would reset itself in the
 * middle of lunch service. Reservations are stored as TZ-naive DATE + TIME at
 * the venue's wall clock, so they compare directly against this string.
 *
 * call_logs.started_at is TIMESTAMPTZ, so it needs the day boundary converted
 * into the venue's zone rather than compared against a bare date.
 */
export async function getHomeSummary(
  restaurantId: string,
  localDate: string,
  timeZone: string,
  db: DbClient = readPool
): Promise<HomeSummaryRow> {
  const result = await db.query<{
    covers_booked: string;
    bookings_today: string;
    orders_waiting: string;
    calls_answered: string;
    next_booking_time: string | null;
  }>(
    `
    SELECT
      COALESCE((
        SELECT SUM(party_size)
          FROM reservations
         WHERE restaurant_id = $1
           AND reservation_date = $2::date
           AND status NOT IN ('cancelled', 'no_show')
      ), 0)::text AS covers_booked,

      COALESCE((
        SELECT COUNT(*)
          FROM reservations
         WHERE restaurant_id = $1
           AND reservation_date = $2::date
           AND status NOT IN ('cancelled', 'no_show')
      ), 0)::text AS bookings_today,

      COALESCE((
        SELECT COUNT(*)
          FROM orders
         WHERE restaurant_id = $1
           AND status NOT IN ('served', 'cancelled')
      ), 0)::text AS orders_waiting,

      COALESCE((
        SELECT COUNT(*)
          FROM call_logs
         WHERE restaurant_id = $1
           AND started_at >= ($2::date)::timestamp AT TIME ZONE $3
           AND started_at <  ($2::date + 1)::timestamp AT TIME ZONE $3
      ), 0)::text AS calls_answered,

      (
        SELECT to_char(start_time, 'HH24:MI')
          FROM reservations
         WHERE restaurant_id = $1
           AND reservation_date = $2::date
           AND status NOT IN ('cancelled', 'no_show')
           AND start_time >= $4::time
         ORDER BY start_time
         LIMIT 1
      ) AS next_booking_time
    `,
    [restaurantId, localDate, timeZone, nowWallClock(timeZone)]
  );

  const row = result.rows[0]!;
  return {
    covers_booked: Number(row.covers_booked),
    bookings_today: Number(row.bookings_today),
    orders_waiting: Number(row.orders_waiting),
    calls_answered: Number(row.calls_answered),
    next_booking_time: row.next_booking_time
  };
}

/** The venue's current wall-clock time as HH:MM, for "what's next tonight". */
function nowWallClock(timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date());
}
