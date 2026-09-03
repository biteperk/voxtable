# Separating BitePerk production from legacy and sandbox resources

BitePerk production uses only resources owned by BitePerk and configured in
`bp-voxtable-prod`. The legacy Algorythmos estate and `core-central-vm` are not
production dependencies or rollback paths.

## Required boundaries

- Production Retell agents use the Biteperk workspace and production Secret Manager key.
- Production Twilio numbers, trunks and Messaging Services use Biteperk-production.
- Every agent webhook and tool URL targets the production Cloud Run API.
- Production venue bindings live only in production Cloud SQL.
- Legacy numbers and hostnames may be retired or redirected, but never proxy to the sandbox VM.
- Legacy recordings are handled under the recording-retention/legal process; they are not imported
  as production application data.

Verification is `npm run check:voice-lines`, provider read-back, Cloud Run health and a real call
whose records appear in production Cloud SQL. Do not inspect or mutate VM state as production proof.
