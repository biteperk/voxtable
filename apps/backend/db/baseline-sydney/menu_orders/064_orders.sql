CREATE TABLE IF NOT EXISTS menu_orders.orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES core.restaurants(id) ON DELETE CASCADE,
  reservation_id UUID REFERENCES reservations.reservations(id) ON DELETE SET NULL,
  table_id UUID REFERENCES reservations.tables(id) ON DELETE SET NULL,
  source core.order_source NOT NULL,
  status core.order_status NOT NULL DEFAULT 'pending',
  payment_status core.payment_status NOT NULL DEFAULT 'unpaid',
  subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  special_instructions TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT,
  order_number INTEGER,
  ordered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  ready_at TIMESTAMPTZ,
  served_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT,
  created_by TEXT,
  created_from_call_log_id UUID REFERENCES voice.call_logs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency
  ON menu_orders.orders (restaurant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_active
  ON menu_orders.orders (restaurant_id, created_at DESC)
  WHERE status NOT IN ('served', 'cancelled');

CREATE INDEX IF NOT EXISTS idx_orders_reservation
  ON menu_orders.orders (reservation_id)
  WHERE reservation_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_orders_updated_at ON menu_orders.orders;
CREATE TRIGGER set_orders_updated_at
BEFORE UPDATE ON menu_orders.orders
FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
