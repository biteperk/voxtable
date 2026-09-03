# Production domain activation

Production API traffic belongs only on Cloud Run in `bp-voxtable-prod`.
`core-central-vm`, `136.113.35.88`, sandbox nginx and legacy VM hostnames are not
production origins or rollback targets.

## API domain

`api.biteperk.com.au` must terminate on the production Cloud Run service through
the platform-managed domain mapping or HTTPS load balancer. Configure DNS only
after the managed certificate is ready.

Verification:

1. Resolve the hostname and confirm it targets the platform-managed Cloud Run
   frontend, never the sandbox VM IP.
2. Confirm `/health` and `/readyz` return success and report database health.
3. Read back the Retell, Twilio, Cal.com and Stripe endpoint configuration and
   confirm each references the production hostname.
4. Confirm monitoring sees normal production traffic without generating a test
   call, webhook, booking or other write.

Exercise DNS, webhook signatures, calls and dashboard writes against the staging
domains before promotion. Production domain verification is non-mutating only.

Rollback is a Cloud Run revision or load-balancer configuration rollback. Never
point DNS to the sandbox VM.

## Dashboard and KDS domains

`voxtable.biteperk.com.au` and `kds.biteperk.com.au` use the production Firebase
Hosting sites in `bp-voxtable-prod`. Add them to Firebase Auth authorized domains
and the production API CORS allowlist before publishing them.

Build outputs must contain the production Firebase project and production API
URL, with no staging, legacy-project or sandbox identifiers.

## Legacy names

Legacy names may redirect to current product surfaces when required for old
links. They must not proxy or forward application traffic to the sandbox VM.

This file replaces the former VM/domain cutover plan. There is no VM-to-Cloud
Run traffic cutover and no VM data migration.
