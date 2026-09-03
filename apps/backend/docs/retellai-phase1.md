# RetellAI Setup

RetellAI owns the voice-agent conversation layer for VocoTable. Twilio owns the
telephony layer when calls route through a Twilio number or SIP trunk.

## Backend URLs

Use the deployed API URL for RetellAI configuration:

```text
https://api.biteperk.com.au
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

Create the required custom functions in RetellAI. Booking tools must return
snake_case JSON because Bella reads those messages directly.

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

## Additional Current Tools

The current backend also exposes:

```text
{PUBLIC_API_BASE_URL}/retell/tools/modify-booking
{PUBLIC_API_BASE_URL}/retell/tools/menu-lookup
{PUBLIC_API_BASE_URL}/retell/tools/create-order
```

Use the dedicated tool URLs where possible; the generic dispatcher remains for
compatibility.

## Signature Verification

RetellAI sends `X-Retell-Signature`.

For local manual testing, keep:

```text
RETELL_VERIFY_SIGNATURE=false
```

For production, set:

```text
RETELL_API_KEY=<retell-api-key>
RETELL_WEBHOOK_SECRET=<retell-webhook-secret>
RETELL_VERIFY_SIGNATURE=true
```

`RETELL_API_KEY` is the REST API key. `RETELL_WEBHOOK_SECRET` is the dedicated
webhook signing secret from Retell. The backend verifies the raw request body
using `retell-sdk`.

## Staging Smoke Test

Run this sequence only in staging:

1. Run staging migrations and provision staging test data.
2. Deploy the backend to staging Cloud Run through the CI-gated workflow (see [GCP Deployment Guide](./gcp-deployment.md)).
3. Configure the staging Twilio number/SIP routing if using Twilio telephony.
4. Configure the staging RetellAI webhook URL.
5. Configure the staging RetellAI inbound webhook URL if using dynamic variables.
6. Add `check_availability` and `create_booking` custom functions to the staging agent.

Production receives only genuine customer data. After promotion, use health/readiness,
configuration read-back and monitoring; do not repeat this smoke test.
7. Bind the RetellAI inbound agent to the Twilio-connected or RetellAI-managed number.
8. Call the number.
9. Complete a fake booking.
10. Confirm:
   - one row exists in `reservations`.
   - the matching RetellAI call exists in `call_logs`.
   - transcript and recording URL appear when RetellAI sends them.

For Twilio telephony details, see [`twilio-retellai-phase1.md`](./twilio-retellai-phase1.md).
