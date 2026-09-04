# VoxTable architecture

For operational detail, read the root `CLAUDE.md`, `AGENTS.md` and
`apps/backend/docs/gcp-deployment.md`.

## Production request path

```mermaid
flowchart LR
  Caller[Restaurant caller] --> Twilio[Twilio production number and SIP trunk]
  Twilio --> Retell[Retell Bella agent]
  Retell --> API[Cloud Run voxtable-prod-api]
  Dashboard[Firebase-hosted dashboard] --> API
  KDS[Firebase-hosted KDS] --> API
  API --> DB[(Cloud SQL voxtable-prod-postgres)]
  API --> Stripe[Stripe]
  API --> Cal[Cal.com]
  Worker[Cloud Run voxtable-prod-worker] --> DB
  Worker --> Notify[Email and SMS providers]
```

Production resources live in `bp-voxtable-prod`. The API and worker run as
separate Cloud Run services, and the migration runner is a separate Cloud Run
job. Runtime secrets come from Secret Manager; infrastructure is managed in
`biteperk-cloud-platform`.

`core-central-vm` is an isolated sandbox and is deliberately absent from the
production diagram. It does not serve production traffic and its data is not a
production bootstrap, backup or migration source.

## Deployment and schema flow

```mermaid
flowchart LR
  PR[Reviewed promotion to main] --> CI[CI build and checks]
  CI --> Images[Artifact Registry images]
  Images --> Migrate[voxtable-prod-migrate]
  Migrate -->|success| API[Roll API revision]
  Migrate -->|success| Worker[Roll worker revision]
  Migrate --> DB[(Production Cloud SQL)]
```

The migration job runs from the new API image and must succeed before either
service rolls. Database migrations are append-only and run as `voxtable_owner`;
runtime services connect as `voxtable_app`.

Production application data is created directly in the production environment
through reviewed onboarding/admin paths. Staging and sandbox data never promote.

## Recovery

- Application recovery: route Cloud Run traffic to a known-good revision, then
  restore `--to-latest` after the fix.
- Database recovery: Cloud SQL automated backup or point-in-time recovery into
  a reviewed replacement instance.
- Integration recovery: disable the relevant Terraform-managed kill switch.
- Never use the sandbox VM as a production rollback target.
