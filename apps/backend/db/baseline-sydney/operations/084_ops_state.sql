-- Mirror of migrations/028_ops_state.sql.
--
-- Small key/value store for operational state that must survive a restart:
-- alert heartbeats per restaurant, per-minute failure buckets.

CREATE TABLE IF NOT EXISTS operations.ops_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Prefix scans must use the index regardless of database collation.
CREATE INDEX IF NOT EXISTS idx_ops_state_key_pattern
  ON operations.ops_state (key text_pattern_ops);
