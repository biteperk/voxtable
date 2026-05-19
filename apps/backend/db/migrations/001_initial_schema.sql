CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'reservation_status') THEN
    CREATE TYPE reservation_status AS ENUM ('pending', 'confirmed', 'cancelled', 'no_show', 'completed');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'booking_source') THEN
    CREATE TYPE booking_source AS ENUM ('voice', 'dashboard');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'call_status') THEN
    CREATE TYPE call_status AS ENUM ('started', 'in_progress', 'completed', 'failed', 'transferred');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS restaurants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Australia/Sydney',
  phone_number TEXT,
  transfer_phone_number TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  min_capacity INTEGER NOT NULL DEFAULT 1 CHECK (min_capacity > 0),
  max_capacity INTEGER NOT NULL CHECK (max_capacity >= min_capacity),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, label)
);

CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, phone)
);

CREATE TABLE IF NOT EXISTS restaurant_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL UNIQUE REFERENCES restaurants(id) ON DELETE CASCADE,
  booking_duration_minutes INTEGER NOT NULL DEFAULT 90 CHECK (booking_duration_minutes BETWEEN 15 AND 360),
  opening_hours_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  faq_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  voice_config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS call_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'retell',
  provider_call_id TEXT,
  caller_phone TEXT,
  status call_status NOT NULL DEFAULT 'started',
  transcript TEXT,
  summary TEXT,
  recording_url TEXT,
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  transferred_to_staff BOOLEAN NOT NULL DEFAULT false,
  reservation_id UUID,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_call_id)
);

CREATE TABLE IF NOT EXISTS reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  table_id UUID REFERENCES tables(id) ON DELETE SET NULL,
  reservation_date DATE NOT NULL,
  start_time TIME NOT NULL,
  party_size INTEGER NOT NULL CHECK (party_size > 0),
  status reservation_status NOT NULL DEFAULT 'confirmed',
  source booking_source NOT NULL,
  notes TEXT,
  cancellation_reason TEXT,
  cancelled_at TIMESTAMPTZ,
  created_from_call_log_id UUID REFERENCES call_logs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'call_logs_reservation_id_fkey'
  ) THEN
    ALTER TABLE call_logs
      ADD CONSTRAINT call_logs_reservation_id_fkey
      FOREIGN KEY (reservation_id)
      REFERENCES reservations(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tables_restaurant_capacity
  ON tables (restaurant_id, is_active, min_capacity, max_capacity);

CREATE INDEX IF NOT EXISTS idx_reservations_restaurant_date_time
  ON reservations (restaurant_id, reservation_date, start_time);

CREATE INDEX IF NOT EXISTS idx_reservations_table_date_time
  ON reservations (table_id, reservation_date, start_time)
  WHERE status IN ('pending', 'confirmed');

CREATE INDEX IF NOT EXISTS idx_call_logs_restaurant_created
  ON call_logs (restaurant_id, created_at DESC);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_restaurants_updated_at ON restaurants;
CREATE TRIGGER set_restaurants_updated_at
BEFORE UPDATE ON restaurants
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_tables_updated_at ON tables;
CREATE TRIGGER set_tables_updated_at
BEFORE UPDATE ON tables
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_customers_updated_at ON customers;
CREATE TRIGGER set_customers_updated_at
BEFORE UPDATE ON customers
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_restaurant_settings_updated_at ON restaurant_settings;
CREATE TRIGGER set_restaurant_settings_updated_at
BEFORE UPDATE ON restaurant_settings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_call_logs_updated_at ON call_logs;
CREATE TRIGGER set_call_logs_updated_at
BEFORE UPDATE ON call_logs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_reservations_updated_at ON reservations;
CREATE TRIGGER set_reservations_updated_at
BEFORE UPDATE ON reservations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
