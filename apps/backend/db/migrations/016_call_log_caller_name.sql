-- Capture the caller's name on the call log so the dashboard Live Feed can show
-- WHO called, not just a phone number. Calls that produce a booking already have
-- the name on the linked reservation's customer (resolved via a JOIN in the API);
-- this column covers the rest — info calls, no-availability, abandoned — populated
-- from Retell's post-call analysis (custom_analysis_data.caller_name).
ALTER TABLE call_logs
  ADD COLUMN IF NOT EXISTS caller_name TEXT;
