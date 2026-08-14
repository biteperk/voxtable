# Staging Cloud Run bootstrap

> ⚠️ **Twilio staging is a *sibling account*, not a subaccount.** `Biteperk-staging` has
> `Parent Account SID: N/A`. That distinction matters: subaccounts inherit some parent
> configuration, siblings inherit nothing — regulatory bundles must be cloned per account and
> alphanumeric sender IDs have no clone API at all. See
> [`twilio-account-topology.md`](twilio-account-topology.md). — one-time service configuration

> ## ⛔ SUPERSEDED by Terraform (6 Aug 2026)
>
> The service/job/secret configuration below is now managed by
> **`biteperk/biteperk-cloud-platform`** — `roots/products/voxtable/stg` applied via
> that repo's `terraform.yml` workflow (manual dispatch: voxtable / stg / apply). Do
> NOT run the gcloud sections of this document; hand-mutated services will fight the
> Terraform state on the next apply.
>
> What Terraform does **not** do, and the only parts of this runbook still live:
> - **§1 — provisioning the staging vendor identities** (a separate Retell agent and
>   a Twilio sibling account + number for staging; never production's).
> - Putting the three secrets (`RETELL_API_KEY`, `TWILIO_ACCOUNT_SID`,
>   `TWILIO_AUTH_TOKEN`) on that repo's **staging GitHub Environment**.
>   `RETELL_AGENT_ID` and `TWILIO_PHONE_NUMBER` deliberately go NOWHERE in the
>   deployment: they are per-restaurant database data (review decision closing
>   biteperk-cloud-platform PR #20; boot requirement dropped in voxtable PR #107).
>   Bind them to the staging restaurant row instead (admin bind route or one
>   UPDATE on `restaurants.twilio_phone_number` / `retell_agent_id`).
> - **§6-style verification** after an apply + deploy: `/health` returns 200,
>   `/workerz` shows ticking workers.
>
> The rest is retained as history / a map of what the Terraform manages.

`deploy-backend.yml` deploys staging by rolling the **image only**
(`gcloud run services update --image`). It never sets env vars or secrets — it
assumes the `voxtable-stg-api` / `voxtable-stg-worker` services and the
`voxtable-stg-migrate` job already exist and are fully configured. This runbook was
that one-time configuration, before Terraform took it over.

**Why it's needed now:** the services currently refuse to boot with
`Refusing to start: the environment is not safe to boot` — the PR #82 fail-closed
gate firing on missing env. The api needs all six of `PUBLIC_API_BASE_URL`,
`RETELL_API_KEY`, `RETELL_AGENT_ID`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`TWILIO_PHONE_NUMBER` present (plus `DATABASE_URL` and a non-empty allowlist).

**Who runs this:** someone with `roles/run.admin`, `roles/secretmanager.admin`,
and `iam.serviceAccountUser` on **`bp-voxtable-stg`**. Sam's account can't reach the
project, so this is Abhishek's lane (or grant Sam those roles first).

> ⚠️ These commands were written from `deploy-backend.yml` and the (now-removed)
> `deploy-cloudrun.sh`; they have **not** been run against the live project. Confirm
> the Cloud SQL instance name, runtime SA, and the staging API hostname before
> executing, and check `--help` if a flag was renamed in your gcloud version.

---

## 0. Constants (confirm these first)

```bash
export PROJECT=bp-voxtable-stg
export REGION=australia-southeast1
export SQL_INSTANCE="${PROJECT}:${REGION}:voxtable-stg-postgres"   # confirm instance name
export RUNTIME_SA="voxtable-stg-runtime@${PROJECT}.iam.gserviceaccount.com"  # confirm SA exists
export REGISTRY="australia-southeast1-docker.pkg.dev/bp-shared-artifacts/voxtable"

# Service/job names — MUST match the GitHub staging env vars
#   CLOUD_RUN_API_SERVICE=voxtable-stg-api
#   CLOUD_RUN_WORKER_SERVICE=voxtable-stg-worker
#   CLOUD_RUN_MIGRATION_JOB=voxtable-stg-migrate
export API_SVC=voxtable-stg-api
export WORKER_SVC=voxtable-stg-worker
export MIGRATE_JOB=voxtable-stg-migrate

gcloud config set project "$PROJECT"
```

---

## 1. Provision the real staging vendor accounts (human step)

Staging gets its **own** Retell agent and Twilio sibling account/number — never
production's. Prod creds in staging means staging can place/receive calls and text
real customers, and it confuses webhook signature routing (Retell/Twilio verify by
URL). Collect six values:

| Value | Source |
|---|---|
| `RETELL_AGENT_ID` | Retell → new staging agent (clone Bella's config; point webhooks at the staging API URL) |
| `RETELL_API_KEY` | Retell → API key for the staging workspace |
| `RETELL_WEBHOOK_SECRET` | Retell → signing secret for the staging agent's webhook |
| `TWILIO_ACCOUNT_SID` | Twilio → **staging sibling account** SID |
| `TWILIO_AUTH_TOKEN` | Twilio → staging sibling account auth token |
| `TWILIO_PHONE_NUMBER` | Twilio → an AU test number on the staging sibling account, E.164 (`+61…`) |

Point the staging Retell agent's webhooks and the Twilio number's voice/status
webhooks at the staging API host once step 3 confirms its URL.

---

## 2. Secret Manager — vendor creds + DB URLs

Vendor tokens are stored as **secrets** (matching `deploy-backend.yml`, which
`--remove-secrets RETELL_API_KEY,RETELL_WEBHOOK_SECRET,TWILIO_ACCOUNT_SID,TWILIO_AUTH_TOKEN`
on the migrate job — so those bindings must exist). `RETELL_AGENT_ID` and
`TWILIO_PHONE_NUMBER` are identifiers, not secrets → plain env in step 3.

```bash
create_secret () {  # usage: create_secret <name> <value>
  if gcloud secrets describe "$1" --project="$PROJECT" >/dev/null 2>&1; then
    printf '%s' "$2" | gcloud secrets versions add "$1" --project="$PROJECT" --data-file=-
  else
    printf '%s' "$2" | gcloud secrets create "$1" --project="$PROJECT" \
      --replication-policy=user-managed --locations="$REGION" --data-file=-
  fi
  gcloud secrets add-iam-policy-binding "$1" --project="$PROJECT" \
    --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor >/dev/null
}

create_secret voxtable-stg-retell-api-key         '<<RETELL_API_KEY>>'
create_secret voxtable-stg-retell-webhook-secret  '<<RETELL_WEBHOOK_SECRET>>'
create_secret voxtable-stg-twilio-sid             '<<TWILIO_ACCOUNT_SID>>'
create_secret voxtable-stg-twilio-auth-token      '<<TWILIO_AUTH_TOKEN>>'

# DB URLs should already exist from the DB bring-up. Confirm both:
#   db-app-url   -> the least-privilege app role (services)
#   db-owner-url -> voxtable_owner (migrate job ONLY — migration 029 needs owner
#                   to run ALTER DEFAULT PRIVILEGES / touch the append-only ledger)
gcloud secrets describe db-app-url   --project="$PROJECT" >/dev/null && echo "db-app-url OK"
gcloud secrets describe db-owner-url --project="$PROJECT" >/dev/null && echo "db-owner-url OK"
```

---

## 3. Configure the services and the migrate job

`APP_ENV=production` on staging is deliberate — staging rehearses the fail-closed
production ruleset (signature gates ON, allowlist enforced), differing from prod
only in credentials and data. The gates (`RETELL_VERIFY_SIGNATURE`,
`TWILIO_VALIDATE_SIGNATURE`, `DASHBOARD_VERIFY_AUTH`) default `true`, so leave them
unset. `^@^` makes `@` the list delimiter so the email allowlist can contain commas.

```bash
# Confirm the staging API hostname before setting PUBLIC_API_BASE_URL.
export PUBLIC_URL="https://api-staging.biteperk.com.au"      # confirm
export ALLOWLIST="skalaliya@gmail.com,biteperk@gmail.com"    # confirm

BASE_ENV="APP_ENV=production@NODE_ENV=production@PUBLIC_API_BASE_URL=${PUBLIC_URL}@DASHBOARD_ALLOWED_EMAILS=${ALLOWLIST}@RETELL_AGENT_ID=<<RETELL_AGENT_ID>>@TWILIO_PHONE_NUMBER=<<TWILIO_PHONE_NUMBER>>@DATABASE_SSL=false"

API_ENV="^@^${BASE_ENV}@PG_APPLICATION_NAME=voxtable-api"
WORKER_ENV="^@^${BASE_ENV}@PG_APPLICATION_NAME=voxtable-worker@PG_POOL_MAX_WRITE=30@PG_POOL_MAX_READ=5"

VENDOR_SECRETS="RETELL_API_KEY=voxtable-stg-retell-api-key:latest,RETELL_WEBHOOK_SECRET=voxtable-stg-retell-webhook-secret:latest,TWILIO_ACCOUNT_SID=voxtable-stg-twilio-sid:latest,TWILIO_AUTH_TOKEN=voxtable-stg-twilio-auth-token:latest"
APP_SECRETS="DATABASE_URL=db-app-url:latest,${VENDOR_SECRETS}"
MIGRATE_SECRETS="DATABASE_URL=db-owner-url:latest,${VENDOR_SECRETS}"

# Pick any already-published image tag to initialise with (a recent integration
# SHA present in the registry). deploy-backend.yml rolls the real tag afterwards.
export INIT_TAG="<<recent-integration-sha>>"

# --- api (request-serving) ---
gcloud run services update "$API_SVC" --project="$PROJECT" --region="$REGION" \
  --image="${REGISTRY}/api:${INIT_TAG}" \
  --set-env-vars="$API_ENV" --set-secrets="$APP_SECRETS" \
  --set-cloudsql-instances="$SQL_INSTANCE" --service-account="$RUNTIME_SA" \
  --port=3050 --min-instances=0 --max-instances=3 --memory=512Mi \
  --startup-probe="httpGet.path=/readyz,httpGet.port=3050,initialDelaySeconds=5,periodSeconds=5,failureThreshold=12" \
  --liveness-probe="httpGet.path=/livez,httpGet.port=3050,periodSeconds=30" \
  --allow-unauthenticated

# --- worker (poller: always-on CPU, exactly one instance) ---
gcloud run services update "$WORKER_SVC" --project="$PROJECT" --region="$REGION" \
  --image="${REGISTRY}/worker:${INIT_TAG}" \
  --set-env-vars="$WORKER_ENV" --set-secrets="$APP_SECRETS" \
  --set-cloudsql-instances="$SQL_INSTANCE" --service-account="$RUNTIME_SA" \
  --port=3050 --min-instances=1 --max-instances=1 --no-cpu-throttling --memory=512Mi \
  --startup-probe="httpGet.path=/readyz,httpGet.port=3050,initialDelaySeconds=5,periodSeconds=5,failureThreshold=12" \
  --liveness-probe="httpGet.path=/livez,httpGet.port=3050,periodSeconds=30" \
  --no-allow-unauthenticated

# --- migrate job (owner role) ---
# Give it the same secrets so deploy-backend.yml's per-run --remove-secrets is valid;
# DATABASE_URL here is the OWNER url, unlike the services.
gcloud run jobs update "$MIGRATE_JOB" --project="$PROJECT" --region="$REGION" \
  --image="${REGISTRY}/api:${INIT_TAG}" \
  --set-env-vars="^@^${BASE_ENV}@PG_APPLICATION_NAME=voxtable-migrate" \
  --set-secrets="$MIGRATE_SECRETS" \
  --set-cloudsql-instances="$SQL_INSTANCE" --service-account="$RUNTIME_SA" \
  --command=node --args=apps/backend/dist/db/migrate.js \
  --max-retries=0 --task-timeout=10m
# (Use `gcloud run jobs create …` with the same flags if the job doesn't exist yet.)
```

If a service update fails on `--set-env-vars` string parsing, the `^@^` prefix must
be the first characters of the value — keep it exactly as written.

---

## 4. Deploy and verify

```bash
# Trigger the real deploy workflow (rolls the correct image tag):
gh workflow run deploy-backend.yml -f environment=staging
# …or just push/merge to integration and let CI → deploy-backend.yml run.

# Watch it, then verify boot:
API_URL="$(gcloud run services describe "$API_SVC" --project="$PROJECT" \
  --region="$REGION" --format='value(status.url)')"
curl -fsS "${API_URL}/health"      # expect 200; /livez and /readyz should also pass

gcloud run services describe "$WORKER_SVC" --project="$PROJECT" --region="$REGION" \
  --format='value(status.latestReadyRevisionName,spec.template.spec.containers[0].image)'
# worker image should be .../worker:<sha>, NOT Google's placeholder
```

**Done when:** the api revision leaves the `Refusing to start` crash loop, `/health`
returns 200, and the worker runs our image. Signed Retell/Twilio calls will now
authenticate against the real staging agent/number; unsigned ones still 401 (gates
stay on). Rollback if needed:
`gcloud run services update-traffic "$API_SVC" --to-revisions PREV=100`.
