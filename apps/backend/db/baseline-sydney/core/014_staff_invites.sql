CREATE TABLE IF NOT EXISTS core.staff_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES core.restaurants(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role core.member_role NOT NULL DEFAULT 'server',
  invited_by TEXT NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_invites_pending
  ON core.staff_invites (restaurant_id, lower(email))
  WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_invites_token
  ON core.staff_invites (token)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_staff_invites_restaurant
  ON core.staff_invites (restaurant_id);

DROP TRIGGER IF EXISTS set_staff_invites_updated_at ON core.staff_invites;
CREATE TRIGGER set_staff_invites_updated_at
BEFORE UPDATE ON core.staff_invites
FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
