CREATE TABLE IF NOT EXISTS reservations.reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES core.restaurants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES reservations.customers(id) ON DELETE RESTRICT,
  table_id UUID REFERENCES reservations.tables(id) ON DELETE SET NULL,
  reservation_date DATE NOT NULL,
  start_time TIME NOT NULL,
  party_size INTEGER NOT NULL CHECK (party_size > 0),
  status core.reservation_status NOT NULL DEFAULT 'confirmed',
  source core.booking_source NOT NULL,
  notes TEXT,
  cancellation_reason TEXT,
  cancelled_at TIMESTAMPTZ,
  seated_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  calcom_booking_uid TEXT,
  created_from_call_log_id UUID REFERENCES voice.call_logs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reservations_restaurant_date_time
  ON reservations.reservations (restaurant_id, reservation_date, start_time);

CREATE INDEX IF NOT EXISTS idx_reservations_table_date_time
  ON reservations.reservations (table_id, reservation_date, start_time)
  WHERE status IN ('pending', 'confirmed');

CREATE UNIQUE INDEX IF NOT EXISTS idx_reservations_no_double_book
  ON reservations.reservations (table_id, reservation_date, start_time)
  WHERE status NOT IN ('cancelled', 'no_show', 'completed')
    AND table_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_reservations_calcom_uid
  ON reservations.reservations (calcom_booking_uid)
  WHERE calcom_booking_uid IS NOT NULL;

DROP TRIGGER IF EXISTS set_reservations_updated_at ON reservations.reservations;
CREATE TRIGGER set_reservations_updated_at
BEFORE UPDATE ON reservations.reservations
FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
