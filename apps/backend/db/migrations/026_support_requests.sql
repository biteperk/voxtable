-- 026: create the support_requests table.
--
-- `POST /api/support` has been failing in production with 42P01 (undefined
-- table). The repository writes to `support_requests`, but the table was only
-- ever defined in db/baseline-sydney/operations/083_support_requests.sql — the
-- PARKED fresh-install schema, which the migration runner deliberately does not
-- walk. So the code shipped and the table never did.
--
-- This is the same class of miss that migration 020 was written to fix
-- ("the split-services branch introduced the COLUMN only in its parked
-- baseline"). Caught this time by an audit rather than by a customer.
--
-- Columns mirror the parked definition exactly, minus the schema qualifier, so
-- the two do not drift.

CREATE TABLE IF NOT EXISTS support_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
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
  ON support_requests (restaurant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_requests_status_created
  ON support_requests (status, created_at DESC);
