-- Cal.com hybrid integration: scaffolding only.
--
-- Adds:
--   * reservations.calcom_booking_uid          — link to the mirrored Cal.com booking
--   * 'web' value on the booking_source enum   — for self-serve widget bookings
--   * outbox_calcom                            — durable queue for pushes TO Cal.com
--   * inbox_calcom_events                      — dedup'd audit log for events FROM Cal.com
--
-- The runner (apps/backend/src/db/migrate.ts) wraps each file in its own
-- BEGIN/COMMIT, so no explicit transaction here. Notes for future operators:
--   * PG ≤ 13: `ALTER TYPE ... ADD VALUE` cannot be referenced in the same
--     transaction it was added in. We don't reference 'web' here (no INSERTs
--     with source='web') so this is safe.
--   * Migration 003 hit `08P01` from node-pg multi-statement quirks. If this
--     file trips it, apply via `psql -f` and INSERT INTO schema_migrations
--     manually.

-- 1) Link reservations to Cal.com bookings (nullable; only set when synced).
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS calcom_booking_uid TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_reservations_calcom_uid
  ON reservations (calcom_booking_uid)
  WHERE calcom_booking_uid IS NOT NULL;

-- 2) Allow web-widget bookings as a first-class source alongside 'voice'/'dashboard'.
ALTER TYPE booking_source ADD VALUE IF NOT EXISTS 'web';

-- 3) Durable outbox — every push to Cal.com is enqueued in the SAME transaction
--    as the reservation it mirrors. Worker drains with FOR UPDATE SKIP LOCKED.
CREATE TABLE IF NOT EXISTS outbox_calcom (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id  UUID NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  op              TEXT NOT NULL CHECK (op IN ('create','cancel','reschedule')),
  payload         JSONB NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error      TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  succeeded_at    TIMESTAMPTZ,
  failed_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (succeeded_at IS NULL OR failed_at IS NULL)
);

-- Pending rows are the hot path for the worker — partial index keeps it lean.
CREATE INDEX IF NOT EXISTS idx_outbox_calcom_pending
  ON outbox_calcom (next_attempt_at)
  WHERE succeeded_at IS NULL AND failed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_outbox_calcom_reservation
  ON outbox_calcom (reservation_id);

-- 4) Durable inbox — every Cal.com webhook is persisted before any business
--    logic. event_id is a deterministic hash from the caller so replays are
--    no-ops via INSERT ... ON CONFLICT DO NOTHING.
CREATE TABLE IF NOT EXISTS inbox_calcom_events (
  event_id       TEXT PRIMARY KEY,
  trigger_event  TEXT NOT NULL,
  raw_payload    JSONB NOT NULL,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at   TIMESTAMPTZ,
  process_error  TEXT
);

CREATE INDEX IF NOT EXISTS idx_inbox_calcom_unprocessed
  ON inbox_calcom_events (received_at)
  WHERE processed_at IS NULL;
