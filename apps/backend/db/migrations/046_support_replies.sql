-- A support request was a dead end: the admin could change its status and
-- nothing else. There was no way to answer the venue, and no record of what
-- anybody had said to them — so the same question got answered twice, or not
-- at all.
--
-- Two kinds of row live here, distinguished by `channel`:
--   'email'    the reply we sent the requester (the outbox row id is recorded
--              so the thread and the delivery attempt can be reconciled)
--   'internal' a note for whoever picks the request up next; never sent
--
-- Deliberately NOT append-only. This is operational correspondence, not legal
-- evidence like agreement_acceptances, and a mistyped internal note should be
-- deletable. The audit trail of WHO replied lives in admin_actions either way.

CREATE TABLE IF NOT EXISTS support_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  support_request_id UUID NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'internal')),
  author_uid TEXT NOT NULL,
  author_email TEXT,
  body TEXT NOT NULL,
  -- The notifications_outbox row this reply was queued as, when it was emailed.
  -- Null for internal notes, and null for an email reply queued before this
  -- column existed. No FK: the cleanup worker prunes sent notifications on a
  -- retention sweep, and losing an old outbox row must not take the thread
  -- with it.
  notification_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The thread is always read for one request, oldest first.
CREATE INDEX IF NOT EXISTS idx_support_replies_request
  ON support_replies (support_request_id, created_at);
