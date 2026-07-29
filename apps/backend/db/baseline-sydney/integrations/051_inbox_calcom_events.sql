CREATE TABLE IF NOT EXISTS integrations.inbox_calcom_events (
  event_id TEXT PRIMARY KEY,
  trigger_event TEXT NOT NULL,
  raw_payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  process_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_inbox_calcom_unprocessed
  ON integrations.inbox_calcom_events (received_at)
  WHERE processed_at IS NULL;
