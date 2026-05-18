# Phase 1: Foundation + Voice Skeleton

## Goal
Build the smallest end-to-end system that proves the product works: a test phone call reaches the AI, checks availability, creates a fake reservation through our backend API, and persists the booking plus call log in Postgres.

This is the most important phase. If this is late, the 4-week launch plan is already at risk.

## Timeline
Week 1, Days 1-5.

Target milestone by Day 5: call the number, complete a fake booking, and see the reservation in Postgres.

## Scope
- Create the backend project structure with Node.js and TypeScript.
- Define Postgres schema and migrations for the v1 data model.
- Deploy backend and Postgres to Railway.
- Add health check and core reservation APIs.
- Configure Vapi and Twilio enough for a real test call.
- Log inbound call metadata and final transcript/state.

## Backend Architecture
- Keep the service as a single deployable API for v1.
- Use layered modules:
  - HTTP routes/controllers for request and response boundaries.
  - Services for booking and availability rules.
  - Repository/database layer for Postgres access.
  - Provider adapters for Vapi/Twilio events where needed.
- Use runtime request validation for provider-facing endpoints.
- Store all timestamps in UTC. Use the restaurant timezone when displaying or interpreting local reservation times.
- Use `restaurant_id` on all restaurant-owned records even while only Natalia is live.

## Database Schema
Minimum tables:
- `restaurants`
  - `id`, `name`, `timezone`, `phone_number`, `transfer_phone_number`, `created_at`, `updated_at`.
- `tables`
  - `id`, `restaurant_id`, `label`, `min_capacity`, `max_capacity`, `is_active`.
- `customers`
  - `id`, `restaurant_id`, `name`, `phone`, `created_at`, `updated_at`.
- `reservations`
  - `id`, `restaurant_id`, `customer_id`, `reservation_date`, `start_time`, `party_size`, `status`, `source`, `notes`, `created_from_call_log_id`, `created_at`, `updated_at`.
- `call_logs`
  - `id`, `restaurant_id`, `provider`, `provider_call_id`, `caller_phone`, `status`, `transcript`, `summary`, `recording_url`, `latency_ms`, `transferred_to_staff`, `started_at`, `ended_at`, `created_at`.
- `restaurant_settings`
  - `id`, `restaurant_id`, `booking_duration_minutes`, `opening_hours_json`, `faq_json`, `voice_config_json`, `created_at`, `updated_at`.

Use enums or constrained strings for reservation status:
- `pending`
- `confirmed`
- `cancelled`
- `no_show`
- `completed`

## API Contracts
Implement these before connecting the voice prompt.

### `GET /health`
Must verify:
- API process is running.
- Database connection succeeds.
- Build/version value is available.

### `POST /availability/check`
Input:
- `restaurant_id`
- `date`
- `time`
- `party_size`

Behavior:
- Validate date, time, and party size.
- Check restaurant operating hours.
- Check overlapping confirmed reservations.
- Return available or a nearby suggested time.

v1 rule:
- Keep availability simple and deterministic. A table is available when its capacity fits the party and no overlapping confirmed reservation blocks it.

### `POST /bookings`
Input:
- `restaurant_id`
- customer name and phone.
- date, time, party size.
- source: `voice` or `dashboard`.
- optional notes.
- optional `call_log_id`.

Behavior:
- Upsert customer by `restaurant_id` and phone.
- Re-check availability before confirming.
- Create confirmed reservation when available.
- Return a short confirmation message suitable for voice.

### `PATCH /bookings/:id`
Behavior:
- Allow changes to date, time, party size, notes, and status.
- Re-check availability when date, time, or party size changes.
- Preserve audit-friendly timestamps.

### `POST /bookings/:id/cancel`
Behavior:
- Set reservation status to `cancelled`.
- Record source/reason where provided.
- Return cancellation confirmation.

## Vapi/Twilio Flow
- Buy or connect a Twilio AU phone number.
- Configure Vapi assistant to answer inbound calls.
- Add backend tools for:
  - checking availability.
  - creating bookings.
  - modifying bookings if time permits.
  - cancelling bookings if time permits.
- For Week 1, the happy path is enough:
  1. Caller asks for a table.
  2. AI collects name, phone, date, time, and party size.
  3. AI calls `/availability/check`.
  4. AI calls `/bookings`.
  5. AI confirms the booking.
  6. Backend stores reservation and call log.

## Environment Variables
Document these in the backend README or env example during implementation:
- `DATABASE_URL`
- `PORT`
- `APP_ENV`
- `PUBLIC_API_BASE_URL`
- `VAPI_API_KEY`
- `VAPI_WEBHOOK_SECRET`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_PHONE_NUMBER`
- `DEFAULT_RESTAURANT_ID`

## Verification
- `GET /health` returns `status: ok` locally and on Railway.
- A local API smoke test can create a reservation.
- A deployed API smoke test can create a reservation.
- Vapi can call `/availability/check` and `/bookings`.
- A real phone call creates one confirmed reservation in Postgres.
- Call metadata is stored in `call_logs`, even if transcript capture is initially partial.

## Done When
- Backend is deployed and reachable from Vapi.
- Postgres schema exists in Railway.
- Core endpoints are implemented with validation and clear error responses.
- One seeded Natalia restaurant record exists.
- A fake booking from a phone call persists in `reservations`.
- The matching call appears in `call_logs`.
- The Day 5 demo can be repeated without manual database edits.

## Risks
- Provider webhook payloads may differ from assumptions; inspect real Vapi payloads before finalizing adapters.
- Public API tunneling can hide deployment issues; test against the Railway URL before declaring success.
- Availability rules can become complex quickly; keep v1 to table capacity and overlapping reservation checks.

