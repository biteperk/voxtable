CREATE TABLE IF NOT EXISTS billing.stripe_webhook_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  process_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_unprocessed
  ON billing.stripe_webhook_events (received_at)
  WHERE processed_at IS NULL;
