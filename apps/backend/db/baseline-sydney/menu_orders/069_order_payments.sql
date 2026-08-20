-- Mirror of migrations/030_order_payments.sql for the parked fresh-install
-- baseline. Guest payments for voice orders: Stripe Checkout Sessions
-- (Connect destination charges). Financial ledger — never cleaned up, FKs
-- RESTRICT. The order_payment_status enum is declared with every other shared
-- enum in 002_types.sql, per this tree's rule that types live in core.

CREATE TABLE IF NOT EXISTS menu_orders.order_payments (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                   UUID NOT NULL REFERENCES menu_orders.orders(id) ON DELETE RESTRICT,
  restaurant_id              UUID NOT NULL REFERENCES core.restaurants(id) ON DELETE RESTRICT,
  provider                   TEXT NOT NULL DEFAULT 'stripe',
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id   TEXT,
  stripe_connect_account_id  TEXT,
  status                     core.order_payment_status NOT NULL DEFAULT 'created',
  currency                   TEXT NOT NULL DEFAULT 'aud',
  amount_cents               INTEGER NOT NULL CHECK (amount_cents > 0),
  amount_received_cents      INTEGER,
  application_fee_cents      INTEGER NOT NULL DEFAULT 0
                             CHECK (application_fee_cents >= 0 AND application_fee_cents < amount_cents),
  checkout_url               TEXT,
  recipient_phone            TEXT,
  notification_id            UUID,
  expires_at                 TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at                    TIMESTAMPTZ,
  paid_at                    TIMESTAMPTZ,
  last_error                 TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_order_payments_active
  ON menu_orders.order_payments (order_id)
  WHERE status IN ('created', 'sent', 'processing');

CREATE UNIQUE INDEX IF NOT EXISTS idx_order_payments_session
  ON menu_orders.order_payments (stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_order_payments_intent
  ON menu_orders.order_payments (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_order_payments_order
  ON menu_orders.order_payments (order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_order_payments_reaper
  ON menu_orders.order_payments (expires_at)
  WHERE status IN ('created', 'sent', 'processing');

DROP TRIGGER IF EXISTS set_order_payments_updated_at ON menu_orders.order_payments;
CREATE TRIGGER set_order_payments_updated_at
BEFORE UPDATE ON menu_orders.order_payments
FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- Connect columns live on core.restaurants in the baseline world.
ALTER TABLE core.restaurants ADD COLUMN IF NOT EXISTS stripe_connect_account_id TEXT;
ALTER TABLE core.restaurants ADD COLUMN IF NOT EXISTS stripe_connect_charges_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE core.restaurants ADD COLUMN IF NOT EXISTS stripe_connect_payouts_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_connect_account
  ON core.restaurants (stripe_connect_account_id)
  WHERE stripe_connect_account_id IS NOT NULL;
