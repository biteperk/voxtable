-- 014_staff_roles.sql
-- Extends the member_role enum with granular restaurant roles (server, kitchen).
--
-- DDL discipline (per CLAUDE.md + the 004/005 precedent): a value added with
-- ALTER TYPE ... ADD VALUE cannot be USED in the same transaction it was added
-- in, and migrate.ts wraps each migration file in a single BEGIN/COMMIT. So the
-- enum extension lives in its OWN migration here (committed at the end of this
-- file's txn); the staff_invites table that references 'server' as a column
-- DEFAULT lands in 015, which runs after this commit. Splitting the two is what
-- keeps `npm run db:migrate` from failing with
--   ERROR: unsafe use of new value "server" of enum type member_role
-- on a clean database.
--
-- ADD VALUE IF NOT EXISTS is natively idempotent (PG >= 10), so re-running the
-- migration set is safe and no guard block is needed.

ALTER TYPE member_role ADD VALUE IF NOT EXISTS 'server';
ALTER TYPE member_role ADD VALUE IF NOT EXISTS 'kitchen';
