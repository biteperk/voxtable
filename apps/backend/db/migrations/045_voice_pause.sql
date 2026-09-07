-- A per-venue kill switch for the phone line.
--
-- When a rush overwhelms a venue, the owner needs to stop Bella taking bookings
-- for THEIR restaurant without silencing every other venue. The only per-venue
-- control before this was un-checking the Retell inbound webhook by hand, which
-- clears the URL and let a stale draft agent get statically bound — it caused
-- two outages in one day (7 Sep 2026, Mazcina). The global VOICE_BOOKING_ENABLED
-- gate exists but silences all tenants at once and is an env var, not a toggle.
--
-- A TIMESTAMPTZ rather than a boolean so the dashboard can say "paused since…"
-- and the fact is self-auditing. NULL = live; a timestamp = paused, at that time.

ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS voice_paused_at TIMESTAMPTZ;

COMMENT ON COLUMN restaurants.voice_paused_at IS
  'When the venue paused its phone line (owner/admin kill switch). NULL = live. '
  'Read UNCACHED on every inbound call and voice tool call so a pause lands on the '
  'next call — see getVoicePausedAt in repositories/restaurants.ts.';
