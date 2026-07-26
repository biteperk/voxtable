CREATE TABLE IF NOT EXISTS core.restaurant_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  restaurant_id UUID NOT NULL REFERENCES core.restaurants(id) ON DELETE CASCADE,
  role core.member_role NOT NULL DEFAULT 'staff',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, restaurant_id)
);

CREATE INDEX IF NOT EXISTS idx_restaurant_members_user
  ON core.restaurant_members (user_id);

CREATE INDEX IF NOT EXISTS idx_restaurant_members_restaurant
  ON core.restaurant_members (restaurant_id);

DROP TRIGGER IF EXISTS set_restaurant_members_updated_at ON core.restaurant_members;
CREATE TRIGGER set_restaurant_members_updated_at
BEFORE UPDATE ON core.restaurant_members
FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
