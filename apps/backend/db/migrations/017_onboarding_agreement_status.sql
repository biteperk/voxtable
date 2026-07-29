-- 017_onboarding_agreement_status.sql
-- New onboarding step: 'agreement' (the legal Order-Form + consent step),
-- between 'profile' and 'menu'. Isolated in its own migration file because
-- ALTER TYPE ... ADD VALUE may not run in the same transaction as statements
-- that use the new value, and the migration runner sends each file as one
-- implicit transaction. The tables/columns that use it are in 018.
--
-- Existing rows are unaffected: rows already at 'menu' or later rank past the
-- new value (the app-layer state machine is idempotent for completed steps),
-- and the only production tenant is 'live'.

ALTER TYPE onboarding_status ADD VALUE IF NOT EXISTS 'agreement' AFTER 'profile';
