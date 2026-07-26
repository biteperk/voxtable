CREATE TABLE IF NOT EXISTS menu_orders.menu_item_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_item_id UUID NOT NULL REFERENCES menu_orders.menu_items(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price_delta_cents INTEGER NOT NULL DEFAULT 0,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (menu_item_id, name)
);

CREATE INDEX IF NOT EXISTS idx_menu_item_variants_item
  ON menu_orders.menu_item_variants (menu_item_id, display_order);

DROP TRIGGER IF EXISTS set_menu_item_variants_updated_at ON menu_orders.menu_item_variants;
CREATE TRIGGER set_menu_item_variants_updated_at
BEFORE UPDATE ON menu_orders.menu_item_variants
FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
