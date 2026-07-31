-- 023_menu_ingestion_pages.sql
-- Multi-page menu imports.
--
-- A job used to carry exactly one `source_url`, so a menu was one image and one
-- vision call. Real restaurant menus are 12+ page designed PDFs whose parsed
-- output blows past a single call's output limit, so the client now renders each
-- page separately and a job carries an ORDERED LIST of page images that the
-- worker reads in batches.
--
-- Additive and backward compatible on purpose:
--   * `source_url` stays NOT NULL and keeps holding page 1, so rows written by
--     the old client (and any job already in flight during the deploy) still
--     work untouched.
--   * `source_urls` defaults to '[]', so the new code can read it on a database
--     where this migration has not landed yet. That matters because
--     deploy-backend.yml restarts the containers BEFORE running migrations —
--     new code briefly serves traffic against the old schema.
--
-- Readers must therefore treat an empty `source_urls` as "fall back to
-- source_url", never as "this job has no pages".

ALTER TABLE menu_ingestion_jobs
  ADD COLUMN IF NOT EXISTS source_urls JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Backfill so every existing row satisfies the same invariant the new code
-- expects (page list is non-empty for a job that has a source).
UPDATE menu_ingestion_jobs
   SET source_urls = to_jsonb(ARRAY[source_url])
 WHERE source_urls = '[]'::jsonb
   AND source_url IS NOT NULL;

-- Guard the array shape at the database level: a JSON array, and bounded so a
-- malformed or hostile payload can't make the worker fan out into hundreds of
-- paid vision calls. 48 pages is the product cap (8 batches of 6).
ALTER TABLE menu_ingestion_jobs
  DROP CONSTRAINT IF EXISTS menu_ingestion_jobs_source_urls_shape;

ALTER TABLE menu_ingestion_jobs
  ADD CONSTRAINT menu_ingestion_jobs_source_urls_shape
  CHECK (
    jsonb_typeof(source_urls) = 'array'
    AND jsonb_array_length(source_urls) <= 48
  );

COMMENT ON COLUMN menu_ingestion_jobs.source_urls IS
  'Ordered page images for this menu (page 1 first). Empty means legacy row — read source_url instead.';
