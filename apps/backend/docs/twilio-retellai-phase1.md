# Twilio + RetellAI Setup

VocoTable uses both providers, but they own different layers:

- Twilio owns telephony plumbing: Australian number, call routing, SIP trunking, status callbacks, and optional SMS later.
- RetellAI owns the voice agent: speech, conversation flow, LLM/tool calling, call analysis, transcript, and AI booking functions.

## Preferred Production Path

Use Twilio Elastic SIP Trunking to route inbound calls to RetellAI.

RetellAI's Twilio setup expects:

- Twilio origination URI: `sip:sip.retellai.com`
- A Twilio termination URI for outbound/return routing, such as:

```text
{your-trunk}.pstn.twilio.com
```

Store that value in:

```text
TWILIO_TERMINATION_URI=
```

Then import/connect the Twilio number in RetellAI so the RetellAI agent receives calls for that number.

## Backend Twilio Webhooks

The backend also exposes Twilio-compatible webhook endpoints. These are useful for local testing, status logging, or a fallback Programmable Voice routing setup.

Production API base URL:

```text
https://api.biteperk.com.au
```

### Incoming Voice URL

```text
POST {PUBLIC_API_BASE_URL}/twilio/voice
```

Behavior:

- Validates Twilio signature when `TWILIO_VALIDATE_SIGNATURE=true`.
- Stores a Twilio call log with `provider='twilio'`.
- Returns TwiML that dials the configured RetellAI SIP URI.

Default SIP URI:

```text
TWILIO_RETELL_SIP_URI=sip:sip.retellai.com
```

### Status Callback URL

```text
POST {PUBLIC_API_BASE_URL}/twilio/status
```

Behavior:

- Validates Twilio signature when enabled.
- Upserts Twilio call state into `call_logs`.
- Maps Twilio status values to VocoTable call status:
  - `queued`, `initiated`, `ringing` -> `started`
  - `in-progress`, `answered` -> `in_progress`
  - `completed` -> `completed`
  - `busy`, `failed`, `no-answer`, `canceled` -> `failed`

## Environment Variables

```text
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
TWILIO_TERMINATION_URI=
TWILIO_RETELL_SIP_URI=sip:sip.retellai.com
TWILIO_VALIDATE_SIGNATURE=false
```

For production:

```text
TWILIO_VALIDATE_SIGNATURE=true
```

## RetellAI Still Handles Booking Intelligence

RetellAI custom functions still point to:

```text
{PUBLIC_API_BASE_URL}/retell/tools/check-availability
{PUBLIC_API_BASE_URL}/retell/tools/create-booking
{PUBLIC_API_BASE_URL}/retell/tools/modify-booking
{PUBLIC_API_BASE_URL}/retell/tools/menu-lookup
{PUBLIC_API_BASE_URL}/retell/tools/create-order
```

RetellAI lifecycle webhooks still point to:

```text
{PUBLIC_API_BASE_URL}/retell/webhook
```

## Staging Smoke Test

Run against the staging Cloud Run API with signature validation enabled and the
staging Twilio credentials:

```bash
npm run smoke:twilio
```

This verifies that the backend can:

1. Accept a Twilio-style incoming voice webhook.
2. Return TwiML with a SIP dial target.
3. Accept a Twilio-style status callback.

Never run this smoke against the production API. Production is limited to
health/readiness, configuration read-back and monitoring.
4. Store/update `call_logs` for the Twilio call SID.
