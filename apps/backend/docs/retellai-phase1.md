# RetellAI Phase 1 Setup

This is the Phase 1 voice-agent setup for VocoTable. RetellAI owns the AI conversation layer. Twilio owns the telephony layer when we route calls through a Twilio number or SIP trunk.

## Backend URLs

Use the deployed Railway URL for RetellAI configuration:

```text
https://<railway-service>.up.railway.app
```

Local testing can use:

```text
http://localhost:3050
```

## RetellAI Webhooks

Configure the RetellAI account-level or agent-level webhook URL:

```text
{PUBLIC_API_BASE_URL}/retell/webhook
```

This endpoint stores call lifecycle data in `call_logs`.

Supported event families:

- `call_started`
- `call_ended`
- `call_analyzed`
- `transcript_updated`
- `transfer_started`
- `transfer_bridged`
- `transfer_cancelled`
- `transfer_ended`

## RetellAI Inbound Call Webhook

If the RetellAI number should ask VocoTable for per-call context, configure the inbound webhook:

```text
{PUBLIC_API_BASE_URL}/retell/inbound
```

The backend responds with:

- `dynamic_variables.restaurant_id`
- `dynamic_variables.restaurant_name`
- `dynamic_variables.caller_phone`
- `metadata.restaurant_id`
- optional `override_agent_id` when `RETELL_AGENT_ID` is set

## RetellAI Custom Functions

Create these custom functions in RetellAI.

### `check_availability`

Method:

```text
POST
```

URL:

```text
{PUBLIC_API_BASE_URL}/retell/tools/check-availability
```

JSON schema:

```json
{
  "type": "object",
  "required": ["date", "time", "party_size"],
  "properties": {
    "restaurant_id": {
      "type": "string",
      "description": "Restaurant UUID. Use the provided dynamic variable when available."
    },
    "date": {
      "type": "string",
      "description": "Reservation date in YYYY-MM-DD format."
    },
    "time": {
      "type": "string",
      "description": "Reservation local time in HH:mm 24-hour format."
    },
    "party_size": {
      "type": "integer",
      "description": "Number of guests."
    }
  }
}
```

### `create_booking`

Method:

```text
POST
```

URL:

```text
{PUBLIC_API_BASE_URL}/retell/tools/create-booking
```

JSON schema:

```json
{
  "type": "object",
  "required": ["customer_name", "customer_phone", "date", "time", "party_size"],
  "properties": {
    "restaurant_id": {
      "type": "string",
      "description": "Restaurant UUID. Use the provided dynamic variable when available."
    },
    "customer_name": {
      "type": "string",
      "description": "Caller name for the booking."
    },
    "customer_phone": {
      "type": "string",
      "description": "Caller phone number."
    },
    "date": {
      "type": "string",
      "description": "Reservation date in YYYY-MM-DD format."
    },
    "time": {
      "type": "string",
      "description": "Reservation local time in HH:mm 24-hour format."
    },
    "party_size": {
      "type": "integer",
      "description": "Number of guests."
    },
    "notes": {
      "type": "string",
      "description": "Optional special requests or dietary notes."
    }
  }
}
```

## Generic Function Endpoint

If you prefer one RetellAI function URL and route by function name, use:

```text
{PUBLIC_API_BASE_URL}/retell/functions
```

The body must include RetellAI's standard custom function shape:

```json
{
  "name": "check_availability",
  "call": {},
  "args": {}
}
```

## Signature Verification

RetellAI sends `X-Retell-Signature`.

For local manual testing, keep:

```text
RETELL_VERIFY_SIGNATURE=false
```

For production, set:

```text
RETELL_API_KEY=<retell-api-key>
RETELL_VERIFY_SIGNATURE=true
```

The backend verifies the raw request body using `retell-sdk`.

## Phase 1 Test

1. Run backend migrations and seed data.
2. Deploy the backend to Railway.
3. Configure Twilio number/SIP routing if using Twilio telephony.
4. Configure RetellAI webhook URL.
5. Configure RetellAI inbound webhook URL if using dynamic variables.
6. Add `check_availability` and `create_booking` custom functions.
7. Bind the RetellAI inbound agent to the Twilio-connected or RetellAI-managed number.
8. Call the number.
9. Complete a fake booking.
10. Confirm:
   - one row exists in `reservations`.
   - the matching RetellAI call exists in `call_logs`.
   - transcript and recording URL appear when RetellAI sends them.

For Twilio telephony details, see [`twilio-retellai-phase1.md`](./twilio-retellai-phase1.md).
