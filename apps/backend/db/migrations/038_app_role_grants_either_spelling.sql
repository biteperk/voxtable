-- 038_app_role_grants_either_spelling.sql
--
-- Migration 029 does its least-privilege work only if a role named
-- `voxtable_app` exists. On the database the services actually connect to, the
-- runtime role is `vocotable_app` — voco, not vox — so every guarded block in
-- 029 has been a clean, silent no-op there since the day it shipped.
--
-- Two consequences, and the second is the reason this is a migration rather
-- than a runbook step:
--
-- 1. The demotion never happened. 029 exists because a Cloud SQL role created
--    through the gcloud API is a member of `cloudsqlsuperuser`, which makes the
--    append-only agreement_acceptances ledger bypassable (disable the trigger,
--    drop it, TRUNCATE, or DDL around it). If the live runtime role was created
--    that way and never demoted, that hole is still open.
--
-- 2. A pg_dump restore re-creates every table owned by whoever ran the restore,
--    and grants do not travel with `--no-owner --no-acl`. The app then connects
--    fine and fails `permission denied for table restaurants` on the first
--    call. Fixing that by hand during a cutover works exactly as often as
--    someone remembers; running here means the migrate job repairs it every
--    time, which is what the cutover sequence already does after a restore.
--
-- Applies to whichever spelling exists, both, or neither. Neither is CI and
-- local dev, where there is no role split at all — a clean no-op, as 029 is.

DO $$
DECLARE
  app_role text;
BEGIN
  FOREACH app_role IN ARRAY ARRAY['voxtable_app', 'vocotable_app'] LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role);

    -- Demote first. A role that still holds cloudsqlsuperuser does not need the
    -- grants below and can undo anything they express.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudsqlsuperuser') THEN
      EXECUTE format('REVOKE cloudsqlsuperuser FROM %I', app_role);
    END IF;
    EXECUTE format('ALTER ROLE %I NOCREATEDB NOCREATEROLE NOINHERIT', app_role);

    -- DML on what exists — this is the half a restore silently drops.
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', app_role);
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', app_role);
    EXECUTE format(
      'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', app_role);

    -- …and on what later migrations create. Default privileges attach to the
    -- role executing this file (the owner), so this only covers objects that
    -- role goes on to create — which is why the explicit grants above matter
    -- after a restore, where the tables already exist.
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public '
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', app_role);
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public '
      'GRANT USAGE, SELECT ON SEQUENCES TO %I', app_role);

    RAISE NOTICE 'runtime grants applied to %', app_role;
  END LOOP;
END $$;

-- The owner must not lose the ability to maintain what it owns; nothing above
-- touches it, and this is a no-op where the role is absent.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vocotable_owner') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO vocotable_owner';
  END IF;
END $$;
