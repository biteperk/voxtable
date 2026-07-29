CREATE TABLE IF NOT EXISTS voice.call_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES core.restaurants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'retell',
  provider_call_id TEXT,
  caller_phone TEXT,
  caller_name TEXT,
  status core.call_status NOT NULL DEFAULT 'started',
  transcript TEXT,
  summary TEXT,
  recording_url TEXT,
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  transferred_to_staff BOOLEAN NOT NULL DEFAULT false,
  reservation_id UUID,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  intent TEXT CHECK (intent IS NULL OR intent IN ('book','modify','cancel','info','other')),
  booking_outcome TEXT CHECK (booking_outcome IS NULL OR booking_outcome IN ('confirmed','no_availability','declined','transferred','none')),
  user_sentiment TEXT CHECK (user_sentiment IS NULL OR user_sentiment IN ('positive','neutral','negative','unknown')),
  in_voicemail BOOLEAN NOT NULL DEFAULT false,
  call_successful BOOLEAN,
  special_requests TEXT,
  analysis_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  duration_seconds INTEGER GENERATED ALWAYS AS (
    CASE
      WHEN ended_at IS NOT NULL AND started_at IS NOT NULL
      THEN GREATEST(0, EXTRACT(EPOCH FROM (ended_at - started_at))::int)
      ELSE NULL
    END
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_call_id)
);

CREATE INDEX IF NOT EXISTS idx_call_logs_restaurant_created
  ON voice.call_logs (restaurant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_call_logs_restaurant_started
  ON voice.call_logs (restaurant_id, started_at DESC NULLS LAST);

DROP TRIGGER IF EXISTS set_call_logs_updated_at ON voice.call_logs;
CREATE TRIGGER set_call_logs_updated_at
BEFORE UPDATE ON voice.call_logs
FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
