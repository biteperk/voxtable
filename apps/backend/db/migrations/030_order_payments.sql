-- 030_order_payments.sql
-- Voice-order payments: Stripe Checkout Sessions (Connect destination charges)
-- texted to the caller. One row per payment attempt; the partial unique index
-- on order_id is the concurrency guarantee against Retell double-firing the
-- send_payment_link tool (same belt-and-braces posture as
-- reservations_no_overlap: advisory lock for politeness, constraint for
-- correctness).
--
-- Rows here are a financial ledger: never cleaned up (see cleanupWorker), and
-- FKs are ON DELETE RESTRICT — a payment record must not vanish with its
-- parent row.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'order_payment_status') THEN
    CREATE TYPE order_payment_status AS ENUM (
      'created',     -- Stripe session created, link not yet enqueued
      'sent',        -- SMS enqueued in notifications_outbox
      'processing',  -- guest submitted; async method not yet settled
      'paid',        -- terminal (except refund/dispute)
      'expired',
      'failed',
      'cancelled',   -- superseded (order edited/cancelled before payment)
      'refunded',    -- terminal
      'disputed'     -- terminal; resolution is manual
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS order_payments (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                   UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  restaurant_id              UUID NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  provider                   TEXT NOT NULL DEFAULT 'stripe',
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id   TEXT,
  stripe_connect_account_id  TEXT,
  status                     order_payment_status NOT NULL DEFAULT 'created',
  currency                   TEXT NOT NULL DEFAULT 'aud',
  amount_cents               INTEGER NOT NULL CHECK (amount_cents > 0),
  -- What Stripe actually reported on completion — differs from amount_cents
  -- only in the amount-mismatch forensic path (order edited after link sent).
  amount_received_cents      INTEGER,
  application_fee_cents      INTEGER NOT NULL DEFAULT 0
                             CHECK (application_fee_cents >= 0 AND application_fee_cents < amount_cents),
  checkout_url               TEXT,
  recipient_phone            TEXT,
  notification_id            UUID REFERENCES notifications_outbox(id) ON DELETE SET NULL,
  expires_at                 TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at                    TIMESTAMPTZ,
  paid_at                    TIMESTAMPTZ,
  last_error                 TEXT
);

-- One live payment attempt per order. Retries after expiry/failure/cancel are
-- new rows; a Retell double-fire's second insert hits this and is handled as a
-- replay, never a second charge path.
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_payments_active
  ON order_payments (order_id)
  WHERE status IN ('created', 'sent', 'processing');

CREATE UNIQUE INDEX IF NOT EXISTS idx_order_payments_session
  ON order_payments (stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;

-- Webhooks for charge.* events resolve by PaymentIntent id.
CREATE INDEX IF NOT EXISTS idx_order_payments_intent
  ON order_payments (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_order_payments_order
  ON order_payments (order_id, created_at DESC);

-- Reaper scan: active rows past their expiry.
CREATE INDEX IF NOT EXISTS idx_order_payments_reaper
  ON order_payments (expires_at)
  WHERE status IN ('created', 'sent', 'processing');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'set_order_payments_updated_at'
  ) THEN
    CREATE TRIGGER set_order_payments_updated_at
      BEFORE UPDATE ON order_payments
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- The venue's Stripe connected account (destination for guest payments).
-- charges_enabled/payouts_enabled are a cache of the account's capability
-- state, synced from account.updated webhooks — the code refuses to create a
-- payment link while charges_enabled is false.
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS stripe_connect_account_id TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS stripe_connect_charges_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS stripe_connect_payouts_enabled BOOLEAN NOT NULL DEFAULT false;

-- account.updated events carry no metadata/customer — they are resolved by
-- event.account against this index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_connect_account
  ON restaurants (stripe_connect_account_id)
  WHERE stripe_connect_account_id IS NOT NULL;
