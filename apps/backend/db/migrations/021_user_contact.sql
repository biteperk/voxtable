-- 021_user_contact.sql
-- Representative contact details captured at self-serve signup: the PERSON
-- BitePerk follows up with (mobile in E.164), distinct from the VENUE's
-- advertised phone on restaurants. signup_source segments future CRM syncs
-- ('self_serve' | 'invited' | 'admin'; nullable for pre-existing rows).
--
-- Nullable-additive and invisible to running code (the only reader is the new
-- POST /api/me/contact endpoint) — safe for the deploy's auto-migrate path,
-- no expand-first choreography needed.
--
-- DDL discipline (per CLAUDE.md 08P01 gotcha): plain ADD COLUMN only.

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_source TEXT;
