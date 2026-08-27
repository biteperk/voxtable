CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- Migration 025. Lets the reservations overlap constraint use equality on a
-- uuid column alongside the gist range-overlap operator.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Migration 037. pgAudit is supplied by Cloud SQL but is absent from the stock
-- PostgreSQL image used by CI and local development.
DO $pgaudit$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_available_extensions
    WHERE name = 'pgaudit'
  ) THEN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pgaudit';
  ELSE
    RAISE NOTICE 'pgAudit is not available on this PostgreSQL server; skipping extension creation';
  END IF;
END
$pgaudit$;
