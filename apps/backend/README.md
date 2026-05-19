# VocoTable Backend

Phase 1 backend for the VocoTable voice booking MVP.

## Local Setup
1. Copy `.env.example` to `.env`.
2. Set `DATABASE_URL` to a local or Railway Postgres database.
3. Install dependencies:
   ```bash
   npm install
   ```
4. Run migrations and seed data:
   ```bash
   npm run db:migrate
   npm run db:seed
   ```
5. Start the API:
   ```bash
   npm run dev:backend
   ```

## Core Endpoints
- `GET /health`
- `POST /availability/check`
- `POST /bookings`
- `PATCH /bookings/:id`
- `POST /bookings/:id/cancel`
- `POST /retell/webhook`
- `POST /retell/inbound`
- `POST /retell/functions`
- `POST /retell/tools/check-availability`
- `POST /retell/tools/create-booking`
- `POST /twilio/voice`
- `POST /twilio/status`

## RetellAI Setup
Set the RetellAI account-level or agent-level webhook URL to:

```text
{PUBLIC_API_BASE_URL}/retell/webhook
```

If the phone number should ask VocoTable for per-call metadata and dynamic variables, set the inbound webhook URL to:

```text
{PUBLIC_API_BASE_URL}/retell/inbound
```

For RetellAI custom function URLs, use:

```text
{PUBLIC_API_BASE_URL}/retell/tools/check-availability
{PUBLIC_API_BASE_URL}/retell/tools/create-booking
```

Alternatively, route both custom functions through:

```text
{PUBLIC_API_BASE_URL}/retell/functions
```

See [`docs/retellai-phase1.md`](./docs/retellai-phase1.md) for the full RetellAI setup.

## Twilio Setup
Twilio owns the phone-number and telephony layer. For the production path, use Twilio Elastic SIP Trunking with RetellAI.

The backend also exposes Twilio-compatible fallback/testing endpoints:

```text
{PUBLIC_API_BASE_URL}/twilio/voice
{PUBLIC_API_BASE_URL}/twilio/status
```

See [`docs/twilio-retellai-phase1.md`](./docs/twilio-retellai-phase1.md) for the full Twilio + RetellAI setup.

## Smoke Test
With the API running:

```bash
npm run smoke:backend
```

The smoke test checks `/health`, checks availability, creates a booking, updates it, and cancels it.

To exercise the RetellAI-shaped inbound, webhook, and custom-function endpoints locally:

```bash
npm run smoke:retell
```

Keep `RETELL_VERIFY_SIGNATURE=false` for local manual smoke tests unless you are sending real signed RetellAI requests.

To exercise the Twilio-shaped voice and status endpoints locally:

```bash
npm run smoke:twilio
```

Keep `TWILIO_VALIDATE_SIGNATURE=false` for local manual smoke tests unless you are sending real signed Twilio requests.
