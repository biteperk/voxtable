CREATE TABLE IF NOT EXISTS menu_orders.order_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES menu_orders.orders(id) ON DELETE CASCADE,
  event_type core.order_event_type NOT NULL,
  from_value TEXT,
  to_value TEXT,
  actor TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_events_order_created
  ON menu_orders.order_events (order_id, created_at);
