CREATE TABLE IF NOT EXISTS core.restaurant_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL UNIQUE REFERENCES core.restaurants(id) ON DELETE CASCADE,
  booking_duration_minutes INTEGER NOT NULL DEFAULT 90 CHECK (booking_duration_minutes BETWEEN 15 AND 360),
  opening_hours_json JSONB NOT NULL DEFAULT '{
    "monday": [{"open": "17:00", "close": "22:00"}],
    "tuesday": [{"open": "17:00", "close": "22:00"}],
    "wednesday": [{"open": "17:00", "close": "22:00"}],
    "thursday": [{"open": "17:00", "close": "22:00"}],
    "friday": [{"open": "17:00", "close": "23:00"}],
    "saturday": [{"open": "12:00", "close": "23:00"}],
    "sunday": [{"open": "12:00", "close": "21:00"}]
  }'::jsonb,
  faq_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  voice_config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS set_restaurant_settings_updated_at ON core.restaurant_settings;
CREATE TRIGGER set_restaurant_settings_updated_at
BEFORE UPDATE ON core.restaurant_settings
FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
