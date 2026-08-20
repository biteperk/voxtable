-- Mirror of migrations/029_least_privilege.sql, adapted to the domain schemas.
--
-- The app must not connect as a role that owns the schema. On the VM the app
-- ran as the superuser that owned every table, so the append-only
-- agreement_acceptances trigger was bypassable four ways (disable trigger,
-- drop trigger, TRUNCATE, direct DDL). The role split:
--
--   voxtable_owner — runs this baseline, owns objects (the executing role)
--   voxtable_app   — runtime; table/sequence DML only
--
-- Cloud SQL trap this exists to close: users created through the gcloud API
-- are members of `cloudsqlsuperuser`, so a freshly created voxtable_app is
-- nearly as powerful as postgres until demoted.
--
-- Runs LAST because the grants below cover ALL TABLES: every domain file must
-- already have executed. Every block is guarded on role existence, so CI and
-- dev databases (no such roles) apply this as a clean no-op.
--
-- The TRUNCATE guard on the ledger lives with the table it protects, in
-- core/015_agreement_acceptances.sql — it applies in every environment,
-- including the ones with no roles at all.

-- Demote the runtime role: no superuser-ish group, no DDL abilities.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voxtable_app')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudsqlsuperuser') THEN
    REVOKE cloudsqlsuperuser FROM voxtable_app;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voxtable_app') THEN
    ALTER ROLE voxtable_app NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;

-- Runtime grants across every domain schema on the app's search_path, plus
-- default privileges so anything created later needs no per-table grant.
-- Default privileges attach to the CREATING role, so this file must be run by
-- the same role that runs the rest of the baseline (voxtable_owner).
DO $$
DECLARE
  s TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voxtable_app') THEN
    RETURN;
  END IF;

  FOREACH s IN ARRAY ARRAY[
    'core', 'reservations', 'voice', 'menu_orders', 'billing', 'integrations',
    'operations', 'public'
  ] LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO voxtable_app', s);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO voxtable_app', s);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO voxtable_app', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO voxtable_app', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO voxtable_app', s);
  END LOOP;
END $$;
