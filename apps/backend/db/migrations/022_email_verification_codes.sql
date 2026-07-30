-- 022_email_verification_codes.sql
-- Premium signup verification: a 6-digit code emailed via the notifications
-- outbox, typed on the verify screen. One active code per user (uid PK) —
-- issuing a new code replaces the old row. Codes are stored hashed; the
-- plaintext lives only in the outbound email body.

CREATE TABLE IF NOT EXISTS email_verification_codes (
  uid TEXT PRIMARY KEY,               -- Firebase uid; one active code per user
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,            -- sha256(salt || code), hex
  salt TEXT NOT NULL,                 -- random per-code salt, hex
  expires_at TIMESTAMPTZ NOT NULL,    -- issue + 15 min
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  consumed_at TIMESTAMPTZ,
  last_sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sends_in_window INTEGER NOT NULL DEFAULT 1 CHECK (sends_in_window >= 0),
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Branded (HTML) alternative for outbox emails. Nullable so every existing
-- enqueue keeps working; the worker sends text-only when null.
ALTER TABLE notifications_outbox ADD COLUMN IF NOT EXISTS body_html TEXT;
