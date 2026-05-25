-- Phase 9 hardening: structured post-call analysis fields + double-booking safety net.

ALTER TABLE call_logs
  ADD COLUMN IF NOT EXISTS intent TEXT
    CHECK (intent IS NULL OR intent IN ('book','modify','cancel','info','other')),
  ADD COLUMN IF NOT EXISTS booking_outcome TEXT
    CHECK (booking_outcome IS NULL OR booking_outcome IN
      ('confirmed','no_availability','declined','transferred','none')),
  ADD COLUMN IF NOT EXISTS user_sentiment TEXT
    CHECK (user_sentiment IS NULL OR user_sentiment IN
      ('positive','neutral','negative','unknown')),
  ADD COLUMN IF NOT EXISTS in_voicemail BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS call_successful BOOLEAN,
  ADD COLUMN IF NOT EXISTS special_requests TEXT,
  ADD COLUMN IF NOT EXISTS analysis_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS duration_seconds INTEGER GENERATED ALWAYS AS (
    CASE
      WHEN ended_at IS NOT NULL AND started_at IS NOT NULL
      THEN GREATEST(0, EXTRACT(EPOCH FROM (ended_at - started_at))::int)
      ELSE NULL
    END
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_call_logs_restaurant_started
  ON call_logs (restaurant_id, started_at DESC NULLS LAST);

-- DB-level safety net for the per-table booking race fixed in bookingService.ts.
-- Partial unique index — confirmed/seated reservations cannot share (table_id, date, start_time).
-- Cancelled / no_show rows are excluded so a re-book at the same slot is still allowed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reservations_no_double_book
  ON reservations (table_id, reservation_date, start_time)
  WHERE status NOT IN ('cancelled', 'no_show') AND table_id IS NOT NULL;
