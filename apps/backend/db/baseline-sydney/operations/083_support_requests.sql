CREATE TABLE IF NOT EXISTS operations.support_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES core.restaurants(id) ON DELETE CASCADE,
  user_id TEXT,
  user_email TEXT,
  category TEXT NOT NULL CHECK (category IN ('account', 'billing', 'booking', 'technical', 'other')),
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_support_requests_restaurant_created
  ON operations.support_requests (restaurant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_requests_status_created
  ON operations.support_requests (status, created_at DESC);
