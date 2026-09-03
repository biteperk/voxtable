# Bella staging real-call test

Run this test only against the declared `bp-voxtable-stg` voice line, staging
Cloud Run API, staging Cloud SQL, staging dashboard and staging KDS.

Never point this battery at `api.biteperk.com.au`, a production phone number,
the Biteperk production Retell/Twilio workspaces or production Cloud SQL.

## Before the call

1. Confirm the staging API and worker revisions are ready.
2. Confirm staging `/health` and `/readyz` report a healthy Cloud SQL connection.
3. Run `npm run check:voice-lines` and select the declared staging line.
4. Open the staging dashboard and KDS with a staging test venue selected.
5. Record the starting staging reservation, call-log and order identifiers.

## Call battery

- Hear the correct venue identity and required disclosures.
- Ask for opening hours and availability.
- Complete one booking with an unambiguous local date and time.
- If enabled, add a pre-order and verify price/options are read from tool output.
- Interrupt once and confirm Bella stops speaking promptly.
- End the call normally.

## Evidence and cleanup

- The Retell call is bound to the declared staging agent.
- Staging Cloud Run logs show signed requests without unexplained 4xx/5xx responses.
- The call log and reservation appear in staging Cloud SQL through the dashboard/API.
- Any order appears in the staging KDS.
- Any promised staging notification is delivered.
- Remove or cancel the staging test records after evidence is captured.

Production promotion uses only the configuration and code proven here. After
deployment, production receives non-mutating health/readiness checks,
configuration read-backs and monitoring—never this call battery.
