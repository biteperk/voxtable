CREATE TABLE IF NOT EXISTS menu_orders.order_item_modifiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id UUID NOT NULL REFERENCES menu_orders.order_items(id) ON DELETE CASCADE,
  modifier_id UUID NOT NULL REFERENCES menu_orders.menu_item_modifiers(id) ON DELETE RESTRICT,
  name_snapshot TEXT NOT NULL,
  group_name_snapshot TEXT NOT NULL,
  price_delta_cents_snapshot INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_item_modifiers_item
  ON menu_orders.order_item_modifiers (order_item_id);
