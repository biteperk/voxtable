-- PR2: floor-state lifecycle on reservations.
--
-- Senior call: don't introduce a parallel `table_sessions` table or a new
-- `seated` enum value. ALTER TYPE ... ADD VALUE cannot run inside a
-- transaction in PG, and migrate.ts wraps each file in BEGIN/COMMIT, so that
-- path is a dead end via this runner.
--
-- Instead, derive floor state from existing fields + two timestamp columns:
--   status='confirmed' AND seated_at IS NULL                         -> reserved
--   status='confirmed' AND seated_at IS NOT NULL AND completed_at IS NULL -> seated
--   status='completed' AND completed_at IS NOT NULL                  -> done
--
-- Existing findAvailableTable (availability.ts) already excludes 'completed',
-- so re-booking the same slot after Mark Done works without changes there.

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS seated_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- Recreate the partial unique index to also exclude completed rows.
-- Without this, a reservation marked done would still block a fresh booking
-- at the same (table, date, start_time).
DROP INDEX IF EXISTS idx_reservations_no_double_book;

CREATE UNIQUE INDEX IF NOT EXISTS idx_reservations_no_double_book
  ON reservations (table_id, reservation_date, start_time)
  WHERE status NOT IN ('cancelled', 'no_show', 'completed')
    AND table_id IS NOT NULL;
