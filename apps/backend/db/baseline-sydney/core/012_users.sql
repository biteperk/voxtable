CREATE TABLE IF NOT EXISTS core.users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  -- Migration 021. The PERSON BitePerk follows up with (E.164), distinct from
  -- the venue's advertised phone; signup_source segments future CRM syncs.
  phone TEXT,
  signup_source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower
  ON core.users (lower(email));

DROP TRIGGER IF EXISTS set_users_updated_at ON core.users;
CREATE TRIGGER set_users_updated_at
BEFORE UPDATE ON core.users
FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
