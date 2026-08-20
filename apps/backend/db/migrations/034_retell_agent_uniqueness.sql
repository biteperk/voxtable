-- One Retell agent belongs to exactly one venue.
--
-- Why this exists. On 18 Aug 2026 a call to the staging line was answered as a
-- different venue. Checking the staging database on 19 Aug showed the row is
-- named "Natalia Bistro" AND carries `agent_b9087333…` ("Natalia's Bistro
-- (STAGING)"), so the venue and its agent agreed with each other — no agent was
-- shared, and this index would not have caught it. The honest description is a
-- venue configured as the wrong restaurant, not a cross-wired one.
--
-- The index is still worth having: it closes the gap that would let the same
-- call happen for a reason nobody could see. `retell_agent_id` was added by 008
-- as bare TEXT with no constraint, so two venues CAN hold one agent, and then
-- the caller hears the wrong venue while the booking lands against the right
-- one — with the venue name resolving correctly, which is what makes that
-- version read as a mystery rather than a bug.
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
