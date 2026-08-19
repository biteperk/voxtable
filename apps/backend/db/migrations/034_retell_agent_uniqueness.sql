-- One Retell agent belongs to exactly one venue.
--
-- Why this exists (incident, 18 Aug 2026): the staging venue's row carried
-- `agent_b9087333…`, which is "Natalia's Bistro (STAGING)". Dialled-number ->
-- restaurant resolution was correct and /retell/inbound returned the right
-- restaurant_name, timezone and dates — and then handed the call to another
-- venue's agent, whose prompt hard-coded that venue's name and its owner's
-- name. The caller was told, confidently, that they had reached a different
-- restaurant, while the booking landed against the right one.
--
-- Nothing objected. `retell_agent_id` was added by 008 as bare TEXT with no
-- constraint, while every other vendor identifier on this table (both phone
-- numbers in 007, stripe_customer_id in 008) got a partial unique index. This
-- closes that gap.
--
-- The agent is where a venue's identity, prompt and tool endpoints live, so
-- sharing one between venues is not a configuration nuance — it is the bug.
-- If a deliberate shared-agent model is ever wanted, dropping this index should
-- be its own migration and its own decision.

DO $$
DECLARE
  conflict_text TEXT;
BEGIN
  -- Fail with the offending venues named, rather than the bare duplicate-key
  -- error CREATE UNIQUE INDEX would give. A migration that blocks a deploy must
  -- say exactly what to fix.
  SELECT string_agg(detail, '; ')
    INTO conflict_text
    FROM (
      SELECT retell_agent_id || ' -> ' || string_agg(name, ', ' ORDER BY name) AS detail
        FROM restaurants
       WHERE retell_agent_id IS NOT NULL
       GROUP BY retell_agent_id
      HAVING count(*) > 1
    ) AS dupes;

  IF conflict_text IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot enforce one-agent-per-venue: these Retell agents are bound to more than one restaurant (%). Give each venue its own agent and LLM (deploy/runbooks/venue-onboarding.md), then re-run.',
      conflict_text;
  END IF;
END $$;

-- Partial: most venues are unprovisioned and hold NULL, and NULLs must not
-- collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_retell_agent
  ON restaurants (retell_agent_id)
  WHERE retell_agent_id IS NOT NULL;
