-- Retry state for inbound Cal.com webhooks.
--
-- Why this exists. `claimUnprocessedInbox` was written for a worker that was
-- never built — it has had zero callers since migration 004, and cleanupWorker
-- carries a comment saying so. Meanwhile /cal/webhook processes inline and
-- converts EVERY failure into a 200, because a 5xx makes Cal.com retry forever.
-- The two together mean an inbound booking that fails once is lost: we do not
-- retry it, and neither does Cal.com. The failure modes are ordinary — a lock
-- wait, a pool timeout, a transient Cal.com call inside the handler.
--
-- That was survivable while Cal.com merely mirrored bookings taken by phone.
-- It is not survivable now Cal.com is a channel guests actually book through,
-- where a lost inbox row is a guest holding a confirmation for a table the
-- restaurant has no record of.
--
-- The retry worker needs three things this table lacks: somewhere to count
-- attempts, somewhere to schedule the next one, and a terminal state. Without
-- the last, a permanently-failing row (an unmapped event type, say) would be
-- retried every tick forever — and each retry re-attempts the cancel-back call
-- to Cal.com, so the bug would be loud at the vendor rather than only here.
--
-- Shapes and names deliberately mirror outbox_calcom (004) so the two workers
-- read the same way.

ALTER TABLE inbox_calcom_events
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;

ALTER TABLE inbox_calcom_events
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Terminal. A dead-lettered row is evidence, not work: the claim below skips
-- it, so it stops consuming retries, and it stays out of the "unprocessed
-- depth" alert that would otherwise latch on it forever. cleanupWorker's
-- delete guard (processed_at IS NOT NULL AND process_error IS NULL) already
-- refuses to sweep it, which is what #214 established and this relies on.
ALTER TABLE inbox_calcom_events
  ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_inbox_calcom_terminal_state') THEN
    -- A row cannot be both handled and dead-lettered. Same guard outbox_calcom
    -- carries on (succeeded_at, failed_at).
    ALTER TABLE inbox_calcom_events ADD CONSTRAINT chk_inbox_calcom_terminal_state
      CHECK (processed_at IS NULL OR failed_at IS NULL);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_inbox_calcom_attempts') THEN
    ALTER TABLE inbox_calcom_events ADD CONSTRAINT chk_inbox_calcom_attempts
      CHECK (attempts >= 0);
  END IF;
END $$;

-- The worker's hot path: rows still owed work, in due order. Partial so it
-- stays small — the table is mostly settled rows.
CREATE INDEX IF NOT EXISTS idx_inbox_calcom_retryable
  ON inbox_calcom_events (next_attempt_at)
  WHERE processed_at IS NULL AND failed_at IS NULL;

-- The pre-existing idx_inbox_calcom_unprocessed (004) stays: it serves the
-- stats query, which asks a different question from the claim.
