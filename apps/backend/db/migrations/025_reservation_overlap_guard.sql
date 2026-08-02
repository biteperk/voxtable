-- 025: make double-booking impossible at the database layer.
--
-- The old guard was a unique index on (table_id, reservation_date, start_time).
-- It only caught bookings that START at the same minute. A 19:00 booking lasting
-- 90 minutes and a 19:30 booking on the same table did not collide, so the table
-- was handed out twice. The per-slot advisory lock had the same blind spot
-- because its key was restaurant:date:time.
--
-- This replaces both with a real overlap constraint over a timestamp range, so
-- the database rejects any overlap regardless of what the application does.
-- Using a timestamp range (date + time) rather than a bare TIME also fixes the
-- midnight-wrap bug: 23:00 + 90 minutes is 00:30 the NEXT DAY, where plain
-- TIME arithmetic wrapped to 00:30 the same day and reported no overlap.
--
-- duration_minutes is snapshotted per reservation rather than read from
-- restaurant_settings. Previously, lowering the restaurant's booking duration
-- retroactively re-evaluated every existing booking as shorter, silently
-- opening overlap windows against bookings that were sold as longer.

-- btree_gist lets a gist exclusion constraint use equality on a uuid column
-- alongside the range overlap operator.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- NOT NULL DEFAULT 90 keeps inserts from the currently-deployed code working:
-- it does not know about this column yet, and gets the same default the code
-- has always fallen back to. New code sets it explicitly from the restaurant's
-- setting at the moment of booking.
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS duration_minutes INTEGER NOT NULL DEFAULT 90
  CHECK (duration_minutes > 0);

-- Backfill from each restaurant's configured duration. Rows whose restaurant
-- has no settings row keep the 90-minute default.
UPDATE reservations r
   SET duration_minutes = rs.booking_duration_minutes
  FROM restaurant_settings rs
 WHERE rs.restaurant_id = r.restaurant_id
   AND rs.booking_duration_minutes IS NOT NULL
   AND rs.booking_duration_minutes > 0
   AND r.duration_minutes = 90;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reservations_no_overlap'
  ) THEN
    ALTER TABLE reservations
      ADD CONSTRAINT reservations_no_overlap
      EXCLUDE USING gist (
        table_id WITH =,
        tsrange(
          (reservation_date + start_time),
          (reservation_date + start_time + make_interval(mins => duration_minutes)),
          '[)'
        ) WITH &&
      )
      WHERE (
        status NOT IN ('cancelled', 'no_show', 'completed')
        AND table_id IS NOT NULL
      );
  END IF;
END $$;

-- The old unique index is now strictly weaker than the constraint above:
-- identical ranges overlap, so exact-time collisions are still rejected.
-- Dropping it avoids two different error codes for the same condition.
DROP INDEX IF EXISTS idx_reservations_no_double_book;
