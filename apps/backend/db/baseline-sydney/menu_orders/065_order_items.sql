CREATE TABLE IF NOT EXISTS menu_orders.order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES menu_orders.orders(id) ON DELETE CASCADE,
  menu_item_id UUID NOT NULL REFERENCES menu_orders.menu_items(id) ON DELETE RESTRICT,
  variant_id UUID REFERENCES menu_orders.menu_item_variants(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  line_total_cents INTEGER NOT NULL CHECK (line_total_cents >= 0),
  name_snapshot TEXT NOT NULL,
  variant_name_snapshot TEXT,
  special_requests TEXT,
  status core.order_item_status NOT NULL DEFAULT 'queued',
  started_at TIMESTAMPTZ,
  ready_at TIMESTAMPTZ,
  served_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_items_order
  ON menu_orders.order_items (order_id);

DROP TRIGGER IF EXISTS set_order_items_updated_at ON menu_orders.order_items;
CREATE TRIGGER set_order_items_updated_at
BEFORE UPDATE ON menu_orders.order_items
FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
