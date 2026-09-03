# KDS kiosk setup

Production KDS is deployed by the frontend workflow to the production Firebase
Hosting site in `bp-voxtable-prod` and calls the production Cloud Run API.
The VM and the repository's default legacy Firebase target are sandbox-only.

## Application prerequisites

- Required KDS migrations have succeeded through `voxtable-prod-migrate`.
- The production venue menu exists through the reviewed admin/onboarding flow.
- The production API CORS list includes the production KDS hostname.
- The production bundle contains the `bp-voxtable-prod` Firebase project and
  production API URL, with no staging or sandbox identifiers.
- The kiosk identity has a kitchen membership for the intended venue; do not
  grant manager permissions merely to make sign-in work.

Promote the frontend/KDS through the normal `main` workflow. Do not run a manual
Firebase deploy against the repository's default project for production.

## Tablet setup

1. Use a workspace-managed, non-personal kiosk account with a vaulted password.
2. Factory-reset or enrol the tablet in managed kiosk mode.
3. Connect to the venue Wi-Fi and disable disruptive updates during service.
4. Open `https://kds.biteperk.com.au`, sign in and install the PWA.
5. Enable sound and keep the device powered.

## Verification

- In staging, create a test order for the intended venue twin.
- Confirm it appears on the staging KDS within the polling interval and the chime sounds.
- In staging, move it through Pending, Preparing and Ready.
- In staging, confirm another venue cannot read or mutate it.
- In staging, disconnect/reconnect Wi-Fi and verify the offline/stale-state behavior.
- After production deployment, limit verification to readiness, configuration read-back,
  page load and monitoring. Do not create or mutate a production order.

Dummy, fixture, synthetic, rehearsal and seed orders are prohibited in production.

Backend configuration changes are Terraform/Cloud Run changes. Never restart
Docker Compose or edit the sandbox VM as part of production KDS setup.
