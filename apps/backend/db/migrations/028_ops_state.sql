-- 028_ops_state.sql
-- Cross-process ops state: keyed JSONB rows for the counters, heartbeats and
-- alert latches that used to live in module memory.
--
-- Why: the api and the worker are separate processes. The KDS heartbeat map
-- was written by the api and read by the health alerter in the worker — two
-- module instances, so the "no kitchen tablet heartbeat" alert could never
-- fire. The Retell auth-failure counter had the same split, so "the agent
-- answers but no booking is written" could never fire either. And
-- /api/ops/calcom-health (api process) reported a circuit breaker that only
-- the worker ever drives — permanently "closed" no matter what. One small
-- keyed table ends the whole class.
--
-- Key conventions (see src/repositories/opsState.ts):
--   kds-heartbeat:<restaurant_id>:<tablet_id>   {"at": <epoch ms>}
--   retell-auth-failures:<epoch minute>         {"count": N}
--   calcom-breaker                              {"state","consecutiveFailures","openedAt"}
--   calcom-quota:<YYYY-MM-DD>                   {"count": N, "startedAt": iso}
--   health-alerter-latches                      the alerter's edge-trigger latches
--
-- DDL discipline (08P01 gotcha): single-statement DDL, no DO blocks needed.

CREATE TABLE IF NOT EXISTS ops_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Prefix scans (heartbeats per restaurant, per-minute failure buckets) must
-- use the index regardless of database collation.
CREATE INDEX IF NOT EXISTS idx_ops_state_key_pattern
  ON ops_state (key text_pattern_ops);
