# Phase 5: Production Go Live

## Goal
Move Natalia's real inbound booking calls onto VocoTable, monitor hands-on, and fix launch issues within hours.

## Timeline
Week 4, Days 1-5.

Target milestone: production cutover on Day 3, followed by active monitoring through Days 4-5.

## Scope
- Configure phone forwarding or number porting.
- Add production monitoring and error tracking.
- Confirm call recording policy.
- Send daily summary email.
- Run production smoke tests.
- Prepare rollback path.
- Monitor real calls.

## Production Readiness
Before cutover:
- Railway backend is stable and has production env vars.
- Vercel frontend is deployed and protected by owner login.
- Database backups or Railway recovery path are understood.
- Sentry is configured for backend and frontend.
- Structured logs include request ID, provider call ID, restaurant ID, and booking ID where available.
- Twilio/Vapi forwarding path is tested end to end.
- Staff transfer phone is confirmed.
- Natalia has the dashboard URL and login.

## Monitoring
Track:
- inbound call count.
- booking creation success rate.
- failed tool calls.
- average AI response time.
- transfer rate.
- duplicate booking incidents.
- dashboard API errors.

Create a launch-day watch routine:
- check logs after every early live call.
- review call recordings/transcripts when consent and policy allow it.
- compare dashboard bookings against Natalia's expectations.
- fix P0 issues immediately.

## Daily Summary Email
Send Natalia a simple daily summary:
- calls handled.
- confirmed bookings.
- cancelled bookings.
- transferred calls.
- FAQ-only calls.
- no-shows marked.
- issues needing attention.

This can start as a scheduled backend job or a manually triggered admin endpoint if speed requires it.

## Call Recording Policy
Before enabling recordings:
- confirm local compliance requirements.
- confirm Natalia's consent and desired retention period.
- include recording URLs in `call_logs` only when provider recording is enabled.
- avoid exposing recordings publicly.

## Rollback Plan
If production call handling fails:
- route calls back to staff or previous workflow.
- keep dashboard read-only if data quality is uncertain.
- pause AI bookings while preserving existing reservation records.
- review logs and replay the failure scenario before re-enabling.

Rollback must be executable without code changes.

## Launch Checklist
- Health endpoint green.
- Database connected.
- One test booking can be created from phone call.
- One dashboard edit succeeds.
- One cancellation succeeds.
- Staff transfer succeeds.
- Natalia confirms call forwarding behavior.
- Sentry receives a test event.
- Daily summary path is verified.

## Done When
- Real customer calls are reaching the AI.
- Confirmed real bookings are appearing in Postgres and dashboard.
- Natalia can operate the dashboard during service.
- Monitoring is active.
- A rollback path is known and tested.
- No unresolved P0 launch bugs remain after the first live service window.

## Risks
- Phone-number porting can take longer than expected; call forwarding is the safer Week 4 path.
- Call recording and privacy can become a compliance risk; keep policy explicit.
- Launch-day fixes should be narrow and reversible.

