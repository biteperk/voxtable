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
- Configure Twilio telephony and RetellAI enough for a real inbound test call.
- Log inbound call metadata and final transcript/state.

## Backend Architecture
- Keep the service as a single deployable API for v1.
- Use layered modules:
  - HTTP routes/controllers for request and response boundaries.
  - Services for booking and availability rules.
  - Repository/database layer for Postgres access.
  - Provider adapters for Twilio telephony events and RetellAI webhooks, inbound-call context, and custom functions.
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

## RetellAI Provider Contracts

### `POST /retell/webhook`
Purpose:
- Receive RetellAI lifecycle events and keep `call_logs` current.

Expected RetellAI events:
- `call_started`
- `call_ended`
- `call_analyzed`
- `transcript_updated`
- `transfer_started`
- `transfer_bridged`
- `transfer_cancelled`
- `transfer_ended`

Behavior:
- Verify `X-Retell-Signature` when `RETELL_VERIFY_SIGNATURE=true`.
- Use raw request body for signature verification.
- Upsert `call_logs` by `(provider, provider_call_id)`.
- Store `provider='retell'`, `call.call_id`, `from_number`, transcript, summary, recording URL, latency, transfer state, start timestamp, and end timestamp when present.
- Return `204` quickly; webhook handling must stay inside RetellAI's retry timeout.

### `POST /retell/inbound`
Purpose:
- Provide per-call context before RetellAI connects an inbound call.

Behavior:
- Verify signature when enabled.
- Return `call_inbound.dynamic_variables.restaurant_id`.
- Return `call_inbound.dynamic_variables.restaurant_name`.
- Return `call_inbound.dynamic_variables.caller_phone`.
- Return `call_inbound.metadata.restaurant_id`.
- Return `call_inbound.override_agent_id` only when `RETELL_AGENT_ID` is configured.

### `POST /retell/tools/check-availability`
Purpose:
- RetellAI custom function endpoint for availability checks.

Input:
- RetellAI standard function body with `name`, `call`, and `args`, or args-only payload.
- Required args: `date`, `time`, `party_size`.
- Optional args: `restaurant_id`.

Behavior:
- Normalize RetellAI arguments into the internal `checkAvailability` service.
- Use `DEFAULT_RESTAURANT_ID` when `restaurant_id` is omitted.
- Return a compact JSON result that RetellAI can read back to the caller.

### `POST /retell/tools/create-booking`
Purpose:
- RetellAI custom function endpoint for booking creation.

Input:
- RetellAI standard function body with `name`, `call`, and `args`, or args-only payload.
- Required args: `customer_name`, `customer_phone`, `date`, `time`, `party_size`.
- Optional args: `restaurant_id`, `notes`.

Behavior:
- Normalize RetellAI arguments into the internal `createBooking` service.
- Attach the booking to the RetellAI `call.call_id` when present.
- Re-check availability before writing the reservation.
- Return a voice-safe confirmation message.

### `POST /retell/functions`
Purpose:
- Generic RetellAI custom-function endpoint if we prefer one RetellAI URL and route by `name`.

Behavior:
- Route `check_availability` to availability.
- Route `create_booking` to booking creation.
- Reject unknown function names with a clear `UNKNOWN_RETELL_FUNCTION` error.

## Twilio Telephony Contracts

### `POST /twilio/voice`
Purpose:
- Twilio Programmable Voice fallback/testing endpoint for incoming calls.

Behavior:
- Verify `X-Twilio-Signature` when `TWILIO_VALIDATE_SIGNATURE=true`.
- Store a Twilio call log with `provider='twilio'` and `provider_call_id=CallSid`.
- Return TwiML that dials the configured RetellAI SIP URI.
- Default SIP target is `TWILIO_RETELL_SIP_URI=sip:sip.retellai.com`.

Production note:
- The preferred production path is Twilio Elastic SIP Trunking into RetellAI. This endpoint remains useful for local smoke tests, status logging, or fallback Programmable Voice routing.

### `POST /twilio/status`
Purpose:
- Receive Twilio voice status callbacks.

Behavior:
- Verify `X-Twilio-Signature` when enabled.
- Upsert `call_logs` by Twilio `CallSid`.
- Map Twilio statuses into VocoTable call status:
  - `queued`, `initiated`, `ringing` -> `started`.
  - `in-progress`, `answered` -> `in_progress`.
  - `completed` -> `completed`.
  - `busy`, `failed`, `no-answer`, `canceled` -> `failed`.

## RetellAI Flow
- Buy or configure a Twilio Australian phone number.
- Configure Twilio Elastic SIP Trunking so inbound calls route to RetellAI.
- Use RetellAI's Twilio setup:
  - Twilio origination URI: `sip:sip.retellai.com`.
  - RetellAI phone-number import uses the Twilio termination URI, usually `{your-trunk}.pstn.twilio.com`.
- Configure a RetellAI voice agent to answer inbound calls.
- Configure the RetellAI webhook URL:
  - `POST /retell/webhook` for call lifecycle events.
- Configure the RetellAI inbound-call webhook if per-call context is needed:
  - `POST /retell/inbound` returns `restaurant_id`, `restaurant_name`, caller metadata, and optional `override_agent_id`.
- Add RetellAI custom functions for:
  - checking availability through `POST /retell/tools/check-availability`.
  - creating bookings through `POST /retell/tools/create-booking`.
  - modifying bookings if time permits.
  - cancelling bookings if time permits.
- For Week 1, the happy path is enough:
  1. Caller asks for a table.
  2. AI collects name, phone, date, time, and party size.
  3. RetellAI calls `check_availability`.
  4. RetellAI calls `create_booking`.
  5. AI confirms the booking.
  6. Backend stores reservation and call log.

## Environment Variables
Document these in the backend README or env example during implementation:
- `DATABASE_URL`
- `PORT`
- `APP_ENV`
- `PUBLIC_API_BASE_URL`
- `RETELL_API_KEY`
- `RETELL_AGENT_ID`
- `RETELL_PHONE_NUMBER`
- `RETELL_VERIFY_SIGNATURE`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_PHONE_NUMBER`
- `TWILIO_TERMINATION_URI`
- `TWILIO_RETELL_SIP_URI`
- `TWILIO_VALIDATE_SIGNATURE`
- `DEFAULT_RESTAURANT_ID`

## Verification
- `GET /health` returns `status: ok` locally and on Railway.
- A local API smoke test can create a reservation.
- A deployed API smoke test can create a reservation.
- Twilio can route inbound calls to RetellAI or the fallback `/twilio/voice` endpoint returns valid SIP TwiML.
- RetellAI can call the `check_availability` and `create_booking` custom functions.
- A real phone call creates one confirmed reservation in Postgres.
- Twilio and RetellAI call metadata is stored in `call_logs`, even if transcript capture is initially partial.

## Done When
- Backend is deployed and reachable from Twilio and RetellAI.
- Postgres schema exists in Railway.
- Core endpoints are implemented with validation and clear error responses.
- One seeded Natalia restaurant record exists.
- A fake booking from a phone call persists in `reservations`.
- The matching Twilio and/or RetellAI call appears in `call_logs`.
- The Day 5 demo can be repeated without manual database edits.

## Risks
- Provider webhook payloads may differ from assumptions; inspect real Twilio callbacks plus RetellAI webhook and custom-function payloads before finalizing adapters.
- Public API tunneling can hide deployment issues; test against the Railway URL before declaring success.
- Availability rules can become complex quickly; keep v1 to table capacity and overlapping reservation checks.
