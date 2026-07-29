CREATE TABLE IF NOT EXISTS integrations.outbox_calcom (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id UUID NOT NULL REFERENCES reservations.reservations(id) ON DELETE CASCADE,
  op TEXT NOT NULL CHECK (op IN ('create','cancel','reschedule')),
  payload JSONB NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  succeeded_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (succeeded_at IS NULL OR failed_at IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_outbox_calcom_pending
  ON integrations.outbox_calcom (next_attempt_at)
  WHERE succeeded_at IS NULL AND failed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_outbox_calcom_reservation
  ON integrations.outbox_calcom (reservation_id);
