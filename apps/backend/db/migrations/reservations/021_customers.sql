CREATE TABLE IF NOT EXISTS reservations.customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES core.restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, phone)
);

DROP TRIGGER IF EXISTS set_customers_updated_at ON reservations.customers;
CREATE TRIGGER set_customers_updated_at
BEFORE UPDATE ON reservations.customers
FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
