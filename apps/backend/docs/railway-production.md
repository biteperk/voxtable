# Railway Production Setup

Use Railway for the backend service and Railway PostgreSQL for the database.

## Production Environment Variables

Set these on the Railway backend service:

```env
APP_ENV=production
APP_VERSION=0.1.0
PUBLIC_API_BASE_URL=https://<your-railway-domain>

DATABASE_URL=${{Postgres.DATABASE_URL}}
DATABASE_SSL=true

DEFAULT_RESTAURANT_ID=<generated-production-uuid>

RETELL_API_KEY=<retell-api-key>
RETELL_AGENT_ID=<retell-agent-id>
RETELL_PHONE_NUMBER=<optional-retell-managed-number>
RETELL_VERIFY_SIGNATURE=true

TWILIO_ACCOUNT_SID=<twilio-account-sid>
TWILIO_AUTH_TOKEN=<twilio-auth-token>
TWILIO_PHONE_NUMBER=+61275011140
TWILIO_TERMINATION_URI=<twilio-termination-uri-if-using-sip-trunk>
TWILIO_RETELL_SIP_URI=sip:sip.retellai.com
TWILIO_VALIDATE_SIGNATURE=true
```

Generate the production restaurant UUID once and keep it stable:

```powershell
[guid]::NewGuid().ToString()
```

Do not use the local placeholder ID in production:

```env
DEFAULT_RESTAURANT_ID=11111111-1111-4111-8111-111111111111
```

The backend will reject production startup if this placeholder is still used.

## Railway Services

Create two services in the same Railway project:

- Backend service from this repository.
- PostgreSQL service.

The backend service should reference the database with:

```env
DATABASE_URL=${{Postgres.DATABASE_URL}}
```

If the PostgreSQL service name is not `Postgres`, use the actual service namespace shown in Railway's variable reference UI.

## Deploy Commands

`railway.json` is configured for production:

- build: `npm ci && npm run build:backend`
- pre-deploy: `npm run db:migrate:prod && npm run db:seed:prod`
- start: `npm run start:backend`
- healthcheck: `/health`

The `/health` endpoint verifies both the API process and PostgreSQL connection.

## RetellAI URLs

After Railway gives the backend a public HTTPS domain, configure RetellAI with:

```text
https://<your-railway-domain>/retell/webhook
https://<your-railway-domain>/retell/inbound
https://<your-railway-domain>/retell/tools/check-availability
https://<your-railway-domain>/retell/tools/create-booking
```

## Twilio URLs

For fallback Programmable Voice or status callbacks:

```text
https://<your-railway-domain>/twilio/voice
https://<your-railway-domain>/twilio/status
```

For the preferred production path, route the Twilio Australian number into RetellAI through Twilio Elastic SIP Trunking.

## Production Verification

Run these checks after deployment:

1. `GET https://<your-railway-domain>/health` returns `status: ok` and `database: ok`.
2. Railway deploy logs show migrations completed before the app starts.
3. Railway deploy logs show `Seeded Natalia restaurant <production-uuid>`.
4. RetellAI custom function smoke call can check availability.
5. RetellAI custom function smoke call can create a booking.
6. Twilio status callback writes a `call_logs` row.
7. A real phone call creates one confirmed reservation in Postgres.

Do not declare Phase 1 production-ready until checks 1-7 pass.
