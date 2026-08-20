CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- Migration 025. Lets the reservations overlap constraint use equality on a
-- uuid column alongside the gist range-overlap operator.
CREATE EXTENSION IF NOT EXISTS btree_gist;
