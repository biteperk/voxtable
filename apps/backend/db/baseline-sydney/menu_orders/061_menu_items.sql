CREATE TABLE IF NOT EXISTS menu_orders.menu_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES core.restaurants(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES menu_orders.menu_categories(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  description TEXT,
  base_price_cents INTEGER NOT NULL CHECK (base_price_cents >= 0),
  is_available BOOLEAN NOT NULL DEFAULT true,
  image_url TEXT,
  image_blurhash TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_menu_items_restaurant_available
  ON menu_orders.menu_items (restaurant_id, is_available);

CREATE INDEX IF NOT EXISTS idx_menu_items_category
  ON menu_orders.menu_items (category_id, display_order);

CREATE INDEX IF NOT EXISTS idx_menu_items_name_trgm
  ON menu_orders.menu_items USING gin ((LOWER(name)) gin_trgm_ops);

DROP TRIGGER IF EXISTS set_menu_items_updated_at ON menu_orders.menu_items;
CREATE TRIGGER set_menu_items_updated_at
BEFORE UPDATE ON menu_orders.menu_items
FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
