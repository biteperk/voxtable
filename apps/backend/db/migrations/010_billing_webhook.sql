-- 010_billing_webhook.sql
-- Stripe webhook idempotency inbox (Phase 3). Stripe retries webhooks
-- aggressively and can deliver out of order; we dedupe on the event id and
-- process each event exactly once (mirrors inbox_calcom_events).

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  process_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_unprocessed
  ON stripe_webhook_events (received_at)
  WHERE processed_at IS NULL;
