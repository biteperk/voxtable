# Phase 4: Staging Integration + Soft Launch

## Goal
Connect the staging dashboard and voice system into a soft-launch workflow where friends and family call the staging number, simulate realistic bookings in staging, and expose the top operational bugs before production activation.

## Timeline
Week 3, Days 1-5.

Target milestone by Day 5: top five soft-launch issues are fixed and prompts are locked for production.

## Scope
- Wire dashboard screens to backend data.
- Add transcript visibility.
- Support booking edits, cancellations, and no-show marking.
- Add polling for live updates.
- Run the soft launch with Natalia's trusted callers on the staging number.
- Triage and fix the highest-impact bugs only.

## Integration Behavior
The backend remains the source of truth.

Flow:
1. Twilio receives the inbound call and routes it into RetellAI.
2. AI collects booking details.
3. AI calls backend tools.
4. Backend writes reservation and call log.
5. Dashboard polling fetches updated call and booking data.
6. Natalia can adjust the booking from the dashboard if needed.

## Dashboard API Needs
Add or finalize read endpoints for:
- listing reservations by date range.
- listing call logs by recent activity.
- reading a single call log with transcript.
- updating reservation status.
- updating reservation details.

Keep payloads dashboard-friendly, but do not create separate fake state in the frontend.

## Transcript Handling
Store:
- raw transcript when provider returns it.
- normalized transcript or summary when available.
- final call outcome.
- transfer flag.
- booking ID linked to the call when created.

Dashboard should show transcript text progressively only if provider support is straightforward. Otherwise, show final transcript after call completion for v1.

## Soft Launch Plan
Before staging calls:
- Seed realistic restaurant hours and tables in staging only.
- Confirm transfer phone works.
- Confirm Natalia knows which scenarios to test.
- Freeze non-critical feature requests until after soft launch.

Call scenarios:
- simple booking.
- booking at unavailable time.
- modification.
- cancellation.
- FAQ-only call.
- large group transfer.
- caller asks for staff.
- noisy or unclear caller.

Do not repeat these scenarios in production. Production receives no soft-launch,
dummy, fixture, synthetic, rehearsal or seed data.

After calls:
- Review call log and reservation data.
- Label failures by severity.
- Fix only launch-blocking and high-frequency issues.
- Update prompts for repeated misunderstandings.

## Bug Triage
P0:
- bookings not persisted.
- wrong date/time stored.
- duplicate bookings from one call.
- staff transfer broken.
- dashboard cannot load.

P1:
- common prompt misunderstanding.
- slow response causing caller confusion.
- incorrect FAQ answer.
- edit/cancel bug in dashboard.

P2:
- visual polish.
- analytics inaccuracies that do not affect operations.
- nice-to-have dashboard filters.

## Done When
- Friends/family soft launch has run with realistic call volume.
- Every call creates or updates an inspectable call log.
- Dashboard shows recent bookings and calls from real soft-launch traffic.
- Natalia can edit/cancel/no-show bookings from the dashboard.
- Top five soft-launch bugs are fixed.
- Prompts are locked for production unless a P0/P1 issue appears.

## Risks
- WebSockets can distract from launch; keep polling unless Natalia cannot operate without faster updates.
- Soft launch can turn into product discovery; capture new ideas but do not build them in Week 3.
- Transcript shape may vary by provider; design storage to tolerate missing or partial transcripts.
