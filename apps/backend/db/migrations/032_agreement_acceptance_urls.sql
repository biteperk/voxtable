-- The acceptance ledger stores the document hashes but not where the
-- documents lived, so a recorded digest has no provenance. Store the URLs the
-- acceptance was made against (they are verified against the published
-- manifest server-side before insert).
--
-- ADD COLUMN is safe on the append-only table: the 018 trigger blocks row
-- UPDATE/DELETE and 029 blocks TRUNCATE; neither blocks DDL. Existing rows
-- keep NULL — their URLs were never captured and inventing them now would be
-- fabricating evidence.
ALTER TABLE agreement_acceptances
  ADD COLUMN csa_url TEXT,
  ADD COLUMN schedule_url TEXT;
