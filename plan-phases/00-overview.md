# VocoTable MVP Overview

## Goal
Ship a voice AI booking platform for Natalia's restaurant in Sydney within 30 days.
The customer calls the restaurant, the AI answers, captures the booking, and writes the result into our system. Natalia sees live operational state in a web dashboard.

The MVP is intentionally narrow: one restaurant, English-only calls, one owner login, no external booking-system integrations, and manual smoke testing where that keeps the launch on schedule.

## Business Target
- First customer: Natalia's Bistro in Sydney.
- Price: $80/month flat subscription, no per-cover fees.
- Expected infrastructure cost: about $25-35/month total at v1 scale.
- Target gross margin per customer: about $45-60/month.
- Launch target: Natalia live by the end of Week 4.
- Decision rule: if Natalia cannot go live by the end of Week 4, pause and reassess scope, architecture, and customer fit.

## Product Surface
- Voice booking agent answers inbound calls routed through Twilio telephony into RetellAI.
- Backend owns reservations, customers, tables, call logs, transcripts, and settings in Postgres.
- Dashboard gives Natalia live visibility into calls, bookings, edits, cancellations, no-shows, analytics, and subscription state.
- AI handles normal booking and FAQ flows; edge cases transfer cleanly to staff.

## Technical Stack
- Telephony: Twilio Australian number, call routing, SIP trunking, forwarding, and status callbacks.
- Voice AI orchestration: RetellAI agent, conversation flow, speech pipeline, custom functions, transcript, and call analysis.
- Voice synthesis: ElevenLabs Aussie English voice.
- LLM: Claude Sonnet 4.6 or GPT-4o, selected by tool-calling reliability and latency.
- Backend: Node.js, TypeScript, REST API, PostgreSQL.
- Frontend: React, Tailwind CSS.
- Frontend hosting: Vercel.
- Backend and database hosting: Railway.
- Error tracking: Sentry before production cutover.

## Architecture Principles
- Keep v1 single-tenant operationally, but model data with `restaurant_id` so the system can become multi-tenant later without a rewrite.
- Define provider-facing API contracts before prompt work so the voice agent can call stable tools.
- Store booking and call state in Postgres from day one; do not rely on Twilio, RetellAI, or dashboard memory as the source of truth.
- Prefer polling for dashboard freshness until a real latency requirement justifies WebSockets.
- Keep the backend boring: typed request validation, structured logs, deterministic booking rules, and explicit fallback paths.
- Optimize for launch reliability over abstraction. Add only the seams needed for provider swaps, multilingual prompts, and future multi-restaurant support.

## Core API Contracts
These contracts are the first implementation boundary and should stay stable during the sprint.

### `GET /health`
Returns service health and database connectivity.

Response:
```json
{
  "status": "ok",
  "database": "ok",
  "version": "0.1.0"
}
```

### `POST /availability/check`
Checks whether a party can be seated for a requested date, time, and size.

Request:
```json
{
  "restaurant_id": "uuid",
  "date": "2026-06-01",
  "time": "19:30",
  "party_size": 4
}
```

Response:
```json
{
  "available": true,
  "suggested_time": "19:30",
  "table_ids": ["uuid"],
  "message": "Available at 7:30 PM"
}
```

### `POST /bookings`
Creates a reservation from a voice call or dashboard action.

Request:
```json
{
  "restaurant_id": "uuid",
  "customer_name": "Sam Taylor",
  "customer_phone": "+61400000000",
  "date": "2026-06-01",
  "time": "19:30",
  "party_size": 4,
  "source": "voice",
  "notes": "Window table if available",
  "call_log_id": "uuid"
}
```

Response:
```json
{
  "booking_id": "uuid",
  "status": "confirmed",
  "confirmation_message": "Your table for 4 is confirmed for 7:30 PM."
}
```

### `PATCH /bookings/:id`
Updates booking details or status.

### `POST /bookings/:id/cancel`
Cancels a booking and records the cancellation reason/source.

## Data Model
Minimum v1 tables:
- `restaurants`: restaurant profile, timezone, phone, operating settings.
- `tables`: table labels and capacity rules.
- `customers`: phone-number based customer identity.
- `reservations`: booking date, time, party size, status, notes, source, table assignment.
- `call_logs`: Twilio call SIDs, RetellAI call IDs, call status, transcript, recording URL, latency, transfer outcome.
- `restaurant_settings`: opening hours, booking duration, FAQ answers, transfer phone, voice configuration.

## Dashboard Direction
Use the provided dark UI designs as the visual baseline:
- Left sidebar navigation with compact product identity, operational navigation, settings access, and owner profile.
- Live Feed for active/recent calls and transcripts.
- Booking Log for confirmed, edited, cancelled, and no-show reservations.
- Analytics with call volume, booking success rate, revenue saved, average AI response time, and outcome breakdown.
- Settings/Billing showing the $80/month subscription state.

Do not create a separate AI Configuration page for v1. The source plan calls for prompt, FAQ, transfer, and voice setup work, but it does not require an owner-facing configuration screen. For the 30-day MVP, those settings are managed through RetellAI, Twilio, environment variables, seed data, and backend `restaurant_settings` until the live restaurant workflow proves the need for a UI.

## Sprint Milestones
- Week 1 Day 5: phone call creates a fake reservation in Postgres.
- Week 2 Day 5: Natalia hears and approves the voice agent direction.
- Week 4 Day 3: production cutover begins.
- Week 4 Day 5: Natalia is live with hands-on monitoring.
- Week 6: two more Sydney pilots signed at $80/month.
- Week 10: five paying customers and $400 MRR.
- Month 4: twenty customers and $1,600 MRR.

## Primary Risks
- Latency: voice calls need fast turn-taking; target sub-1-second AI response where provider constraints allow it.
- Scope creep: every feature outside v1 competes with launch.
- Edge cases: large groups, dietary constraints, ambiguous times, angry callers, and private events need a graceful staff-transfer path.
- Provider instability: Twilio, RetellAI, voice, and LLM provider behavior must be isolated behind clear contracts.
- Customer expectation drift: daily check-ins with Natalia are required from Day 1.
