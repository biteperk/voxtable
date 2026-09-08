-- A card can fail and the venue never learns of it: our transactional email is
-- off (EMAIL_PROVIDER=none), Stripe's failed-payment email was off, and a
-- "suspended" venue kept answering calls anyway. This column is the clock for a
-- recoverable pause: set when a subscription first goes past-due, cleared when
-- payment succeeds. A daily sweep pauses the venue (onboarding_status =
-- 'suspended') once it has been set for more than three days; the voice path
-- refuses while suspended and resumes on recovery.
--
-- NULL = paying (or never lapsed). A timestamp = the current unpaid episode
-- began then. Deliberately NOT reset on each retry failure, so the three-day
-- clock measures from the first failure, not the last.
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS billing_past_due_since TIMESTAMPTZ;

-- The sweep scans live venues whose clock has run out; a partial index keeps
-- that a cheap lookup rather than a full scan as the venue count grows.
CREATE INDEX IF NOT EXISTS idx_restaurants_billing_past_due
  ON restaurants (billing_past_due_since)
  WHERE billing_past_due_since IS NOT NULL;
