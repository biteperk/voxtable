# Production vendor-account hardening

Production integrations use BitePerk-owned accounts and `bp-voxtable-prod`
Secret Manager bindings. The legacy Algorythmos estate and `core-central-vm`
are sandbox/legacy resources, not production dependencies or recovery paths.

## Required controls

- Require MFA and company-controlled recovery methods for Twilio, Retell,
  Stripe, Firebase/GCP, email and DNS providers.
- Keep production and staging accounts separate and label every credential by
  environment.
- Store runtime credentials in the matching GCP project; mirror only the
  minimum read-only credentials needed by monitoring into its GitHub Environment.
- Use least-privilege service accounts and rotate user-managed keys.
- Verify every account and resource by API read-back before and after a change.
- Prove telephony and messaging with a real call or delivered message.

Never copy credentials from the sandbox VM into production. Never treat a
legacy provider account as production fallback.

Production database protection is Cloud SQL automated backup and PITR, covered
by `backup-restore.md`; legacy VM/GCS dump jobs are not production controls.
