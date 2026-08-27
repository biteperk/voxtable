-- Cloud SQL exposes pgAudit after infrastructure enables
-- cloudsql.enable_pgaudit. The stock PostgreSQL image used by CI and local
-- development does not include the extension, so those environments skip this
-- Cloud-SQL-specific step. If pgAudit is available but incorrectly configured,
-- CREATE EXTENSION still fails and prevents a false-successful deployment.
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
