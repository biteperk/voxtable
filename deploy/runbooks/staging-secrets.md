# Staging secrets — where they live and how to fetch one

> **This file contains no secret values, and must never contain one.**
> It is a registry of *names*. Values live in Google Secret Manager; the repo
> holds pointers only. See [`SECURITY.md`](../../SECURITY.md) and the
> `.gitignore` rule that exists for precisely this: *"secrets belong in the
> prod env / password manager, not git."*

## The rule, in one line

**An agent (or a person) resolves a secret by NAME from Secret Manager. It
never reads a value out of a document, a chat, a screenshot, or a `.env` that
someone pasted.**

A key committed to git is not removable. Rewriting history does not reach
existing clones, forks, or the CI caches that already pulled it — the only
real remedy is rolling the key at the vendor. So the cost of getting this
wrong is not "clean up the file", it is "rotate and re-verify every
environment that used it".

## Where staging config actually comes from

Staging runs on Cloud Run in **`bp-voxtable-stg`**. It does **not** read a
`.env` from this repo.

```
Secret Manager (bp-voxtable-stg)
        │  referenced by name
        ▼
Terraform env map  ──►  biteperk/biteperk-cloud-platform
        │                 roots/products/voxtable/stg
        ▼
Cloud Run services voxtable-stg-api / voxtable-stg-worker
```

Two consequences worth internalising:

1. **Adding a secret here is not enough.** A new env var must also be added to
   the Terraform env map, or the service boots into the fail-closed gate in
   `apps/backend/src/config/env.ts` and dies with `Refusing to start`.
2. **`.env.example` is documentation, not configuration.** It lists every key
   the schema knows about so `envExample.test.ts` can catch drift. It is never
   the source of a value.

## The registry

Naming convention: `voxtable-stg-<thing>`. Anything not on this list is either
the Cloud SQL bootstrap set (`db-*`) or does not exist yet.

| Secret name | What it is | Read by |
|---|---|---|
| `voxtable-stg-database-url` | Postgres connection string (app role) | api + worker |
| `voxtable-stg-stripe-secret-key` | Stripe **sandbox** secret key (`sk_test_…`) | api |
| `voxtable-stg-stripe-webhook-secret` | Stripe webhook signing secret | api |
| `voxtable-stg-retell-api-key` | Retell **Staging workspace** key. Also serves as the webhook secret — the new workspace's single key is badged as both | api + worker |
| `voxtable-stg-twilio-account-sid` | `Biteperk-staging` Account SID | api + worker |
| `voxtable-stg-twilio-auth-token` | `Biteperk-staging` auth token | api + worker |
| `voxtable-stg-menu-ocr-api-key` | Vision provider key for menu OCR | worker |
| `voxtable-stg-smoke-user-password` | Firebase password for the smoke-suite user | `smoke:*` against staging |
| `db-app-url` / `db-app-password` | Cloud SQL runtime role | Terraform / migrations |
| `db-owner-url` / `db-owner-password` | Cloud SQL owner role — migrations run as this, never `postgres` (migration 029) | migration job |

**Not secrets, deliberately absent from this table:** the Stripe *publishable*
key (`pk_test_…`) and the Firebase web config. Both ship inside the browser
bundle and are public by design — see the long comment in
`apps/frontend/src/lib/firebaseConfig.js`. They belong in the Terraform
frontend config, not in Secret Manager.

**Account identifiers** — Stripe account id, Twilio SIDs, Retell agent and LLM
ids — live in `deploy/runbooks/vendor-accounts.local.md`, which is gitignored
because it carries vendor logins and PII. It exists on Sam's machine only; a
fresh clone will not have it.

## Fetching one

```bash
gcloud secrets versions access latest \
  --secret=voxtable-stg-stripe-secret-key \
  --project=bp-voxtable-stg
```

Prefer piping it straight into whatever needs it. Do not echo it, do not write
it to a file in the repo, and do not paste it into a terminal that is being
screen-shared or recorded.

## Adding or rotating one

```bash
# New secret
printf '%s' "$VALUE" | gcloud secrets create voxtable-stg-<thing> \
  --project=bp-voxtable-stg --replication-policy=automatic --data-file=-

# New version of an existing secret (this is what rotation is)
printf '%s' "$VALUE" | gcloud secrets versions add voxtable-stg-<thing> \
  --project=bp-voxtable-stg --data-file=-
```

Use `printf` rather than `echo` — `echo` appends a newline, and a trailing
newline inside an API key produces a 401 that looks exactly like a wrong key.

⚠️ **Adding a version changes what `:latest` resolves to.** If the Terraform
map pins `:latest`, the next revision picks up the new value immediately. Check
what the running service currently resolves before adding a version, and roll
services deliberately rather than discovering the change during a call.

⚠️ **A new secret is invisible until Terraform references it.** Adding it here
and expecting the app to see it is the most common way to lose an afternoon.

## Rotate when a key has been exposed

Treat a key as exposed the moment it appears in any of: a chat message, a
screenshot, a commit, a CI log, a support ticket, or a shared terminal.
Sandbox and test-mode keys are lower blast radius — they cannot move real
money — but rotating one costs nothing, so there is no reason not to.

Rotation is: create the new key at the vendor → `gcloud secrets versions add`
→ roll the service → verify against a real request → revoke the old key at the
vendor. Revoking before verifying is how staging goes down at 6pm.

## Related

- [`staging-cloudrun-bootstrap.md`](staging-cloudrun-bootstrap.md) — the
  original bootstrap, largely superseded by Terraform. Kept for the IAM
  binding recipes.
- [`vendor-hardening.md`](vendor-hardening.md) — vendor-side account posture.
- Issue #136 — secret and access hygiene, including the loose 2FA recovery
  code that still needs vaulting.
