-- 024_menu_ingestion_page_results.sql
-- Per-page outcome for a menu parse.
--
-- Written after an import read 59 of 65 items: one page produced NOTHING and
-- nothing in the system noticed. The batch containing that page had SUCCEEDED,
-- so the existing `failedPages` list was empty, and the owner was told
-- "everything looked clear". The parser could not tell "this page had nothing
-- on it" from "I skipped this page", and reported both as success. This column
-- is where that distinction gets written down.
--
-- Shape: an ordered array, one entry per source page:
--   [{ "page": 1, "status": "items", "items": 18 },
--    { "page": 2, "status": "empty_confirmed", "items": 0, "note": "cover page" }]
--
-- status:
--   items           - at least one item from this page reached the draft
--   recovered       - first pass found nothing, the single-page re-read did
--   empty_confirmed - a re-read positively determined there are no priced
--                     dishes here (a cover, a photo page, opening hours)
--   unread          - the call covering this page errored
--   unverified      - nothing came from this page and we could not settle why
--
-- NULLABLE, and that is load-bearing. A row parsed before this column existed
-- genuinely has no page information, and there is no way to reconstruct it —
-- unlike 023, which could rebuild `source_urls` from `source_url`. Inventing
-- clean entries for those rows would be the same false reassurance in a new
-- column. Readers must treat NULL as "unknown", never as "all pages fine".
--
-- DEPLOY ORDER: deploy-backend.yml restarts the containers BEFORE running
-- migrations, so the worker can try to write this column while the old schema
-- is still live. Pre-apply this by psql before merging (the expand-first
-- procedure in CLAUDE.md). markParsed also catches undefined_column (42703) and
-- retries without it, because losing an already-paid-for parse to a missing
-- column is exactly the class of failure this work exists to remove.

ALTER TABLE menu_ingestion_jobs
  ADD COLUMN IF NOT EXISTS page_results JSONB;

ALTER TABLE menu_ingestion_jobs
  DROP CONSTRAINT IF EXISTS menu_ingestion_jobs_page_results_shape;

-- Bounded by the same 48-page product cap as source_urls, so a malformed
-- payload can't store an unbounded blob against a job row.
ALTER TABLE menu_ingestion_jobs
  ADD CONSTRAINT menu_ingestion_jobs_page_results_shape
  CHECK (
    page_results IS NULL
    OR (jsonb_typeof(page_results) = 'array' AND jsonb_array_length(page_results) <= 48)
  );

COMMENT ON COLUMN menu_ingestion_jobs.page_results IS
  'Ordered per-page parse outcome: [{page,status,items,note?}]. '
  'status: items | recovered | empty_confirmed | unread | unverified. '
  'NULL means the job parsed before this column existed — that is "unknown", never "clean".';
