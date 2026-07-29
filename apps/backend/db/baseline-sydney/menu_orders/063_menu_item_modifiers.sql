CREATE TABLE IF NOT EXISTS menu_orders.menu_item_modifiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_item_id UUID NOT NULL REFERENCES menu_orders.menu_items(id) ON DELETE CASCADE,
  group_name TEXT NOT NULL,
  name TEXT NOT NULL,
  price_delta_cents INTEGER NOT NULL DEFAULT 0,
  group_min_select INTEGER NOT NULL DEFAULT 0 CHECK (group_min_select >= 0),
  group_max_select INTEGER NOT NULL DEFAULT 1 CHECK (group_max_select >= 1),
  is_default BOOLEAN NOT NULL DEFAULT false,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (menu_item_id, group_name, name),
  CHECK (group_min_select <= group_max_select)
);

CREATE INDEX IF NOT EXISTS idx_menu_item_modifiers_item_group
  ON menu_orders.menu_item_modifiers (menu_item_id, group_name, display_order);

DROP TRIGGER IF EXISTS set_menu_item_modifiers_updated_at ON menu_orders.menu_item_modifiers;
CREATE TRIGGER set_menu_item_modifiers_updated_at
BEFORE UPDATE ON menu_orders.menu_item_modifiers
FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
