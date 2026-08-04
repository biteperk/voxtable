-- 029_least_privilege.sql
-- X4: the app must not connect as a role that owns the schema. On the VM the
-- app ran as the superuser that owned every table, so the append-only
-- agreement_acceptances trigger was bypassable four ways (disable trigger,
-- drop trigger, TRUNCATE, direct DDL). The Cloud SQL world splits roles:
--
--   voxtable_owner — runs migrations, owns objects (the role executing this)
--   voxtable_app   — runtime; table/sequence DML only
--
-- Cloud SQL trap this migration exists to close: users created through the
-- gcloud API are members of `cloudsqlsuperuser`, so a freshly created
-- voxtable_app is nearly as powerful as postgres until demoted. Every block
-- is guarded on role existence so CI / dev databases (no such roles, no
-- cloudsqlsuperuser) apply this as a clean no-op.

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

-- Runtime grants: connect, see the schema, DML on everything that exists…
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voxtable_app') THEN
    GRANT USAGE ON SCHEMA public TO voxtable_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO voxtable_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO voxtable_app;
  END IF;
END $$;

-- …and on everything future migrations create. Default privileges attach to
-- the creating role, which is the role running this file (voxtable_owner in
-- staging/production), so later CREATE TABLEs need no per-table grants.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voxtable_app') THEN
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO voxtable_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO voxtable_app;
  END IF;
END $$;

-- The TRUNCATE guard (all environments, not just Cloud SQL): the append-only
-- ledger's row-level triggers never fire on TRUNCATE, so it was the one
-- silent mass-delete left. A statement-level BEFORE TRUNCATE trigger closes
-- it for every role short of a superuser who first drops the trigger — and
-- voxtable_app can no longer do that.
CREATE OR REPLACE FUNCTION refuse_truncate_agreement_acceptances()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'agreement_acceptances is an append-only ledger; TRUNCATE is never legitimate here';
END;
$$;

DROP TRIGGER IF EXISTS agreement_acceptances_no_truncate ON agreement_acceptances;

CREATE TRIGGER agreement_acceptances_no_truncate
  BEFORE TRUNCATE ON agreement_acceptances
  FOR EACH STATEMENT
  EXECUTE FUNCTION refuse_truncate_agreement_acceptances();
