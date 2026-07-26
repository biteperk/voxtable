CREATE TABLE IF NOT EXISTS menu_orders.menu_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES core.restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_menu_categories_restaurant_name_lower
  ON menu_orders.menu_categories (restaurant_id, LOWER(name));

DROP TRIGGER IF EXISTS set_menu_categories_updated_at ON menu_orders.menu_categories;
CREATE TRIGGER set_menu_categories_updated_at
BEFORE UPDATE ON menu_orders.menu_categories
FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
