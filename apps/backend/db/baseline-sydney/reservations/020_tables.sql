CREATE TABLE IF NOT EXISTS reservations.tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES core.restaurants(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  min_capacity INTEGER NOT NULL DEFAULT 1 CHECK (min_capacity > 0),
  max_capacity INTEGER NOT NULL CHECK (max_capacity >= min_capacity),
  zone TEXT,
  description TEXT,
  attributes TEXT[] NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, label)
);

CREATE INDEX IF NOT EXISTS idx_tables_restaurant_capacity
  ON reservations.tables (restaurant_id, is_active, min_capacity, max_capacity);

CREATE INDEX IF NOT EXISTS idx_tables_restaurant_attributes
  ON reservations.tables USING GIN (attributes);

DROP TRIGGER IF EXISTS set_tables_updated_at ON reservations.tables;
CREATE TRIGGER set_tables_updated_at
BEFORE UPDATE ON reservations.tables
FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
