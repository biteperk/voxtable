CREATE TABLE IF NOT EXISTS integrations.inbox_calcom_events (
  event_id TEXT PRIMARY KEY,
  trigger_event TEXT NOT NULL,
  raw_payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  process_error TEXT,

  -- Migration 036. Retry state, shaped to mirror outbox_calcom so the two
  -- workers read the same way.
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Terminal. A dead-lettered row is evidence, not work: the claim skips it,
  -- so it stops consuming retries and stays out of the depth alert.
  failed_at TIMESTAMPTZ,

  CONSTRAINT chk_inbox_calcom_attempts CHECK (attempts >= 0),
  -- A row cannot be both handled and dead-lettered.
  CONSTRAINT chk_inbox_calcom_terminal_state CHECK (processed_at IS NULL OR failed_at IS NULL)
);

-- Serves the stats query, which asks a different question from the claim.
CREATE INDEX IF NOT EXISTS idx_inbox_calcom_unprocessed
  ON integrations.inbox_calcom_events (received_at)
  WHERE processed_at IS NULL;

-- Migration 036. The worker's hot path: rows still owed work, in due order.
-- Partial so it stays small — the table is mostly settled rows.
CREATE INDEX IF NOT EXISTS idx_inbox_calcom_retryable
  ON integrations.inbox_calcom_events (next_attempt_at)
  WHERE processed_at IS NULL AND failed_at IS NULL;
