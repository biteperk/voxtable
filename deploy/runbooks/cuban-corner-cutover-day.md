# Cutover day — VM → Cloud Run for api.biteperk.com.au

Ordered, copy-paste steps with a verification gate and an abort line after each. Written so
cutover day is execution, not research. Prereqs: PR #323 merged to `main`; platform #62
resolved (migrate job on an owner-role URL); **platform PR #63 merged and applied** (Stripe
return URLs + notifications parity — without it the api fails its boot gate; its apply needs
the `runtime_zeptomail_token` GitHub secret set and `managed_runtime_secret_version_nonce`
bumped); a person on a phone.

**Who runs what:** `[agent]` = Claude with Sam's gcloud session · `[sam]` = Sam only
(DNS, phones, consoles) · `[abhi]` = Abhishek (Terraform applies **and all prod-GCP
mutations** — Sam's account is denied Cloud Run/Cloud SQL/IAM on `bp-voxtable-prod`, so the
`[agent]` steps that mutate prod GCP are executed by Abhishek in practice; `[agent]` still
runs the read-only gates).

**The honest sequencing caveat:** Retell and Twilio call `api.biteperk.com.au`, so live calls
exercise Cloud Run **only after the DNS flip** (step 7). Steps 1–6 prove the stack by direct
`.run.app` URL; step 7 is the moment of truth and has a 60-second revert.

---

## ⚠️ What changed since this was written — read first (3 Sep 2026)

**Why this is now urgent, not optional.** `voxtable.biteperk.com.au` CNAMEs to
`bp-voxtable-prod.web.app`, and the 1.1.0 promotion on 3 Sep deployed a bundle there that
authenticates against Firebase project `bp-voxtable-prod` and calls the Cloud Run API. That
API is up (`/health` → `database: ok`) but its Terraform carries **no
`SELF_SERVE_SIGNUP_ENABLED`**, so every new account is refused with `403 EMAIL_NOT_ALLOWLISTED`,
and its database holds no venues. Nobody can sign a restaurant up at the public address until
this cutover completes. The VM logs show zero auth events in 7 days — no sign-up has ever
reached the real backend.

0. **Cloud SQL prod is NOT empty any more.** The 3 Sep `deploy-backend` run on `main` executed
   `voxtable-prod-migrate` (schema at `042_restaurant_owner_phone.sql`) and rolled
   `voxtable-prod-api-00009-pkw` / `voxtable-prod-worker-00006-lbk`. Step 3's "target DB must be
   EMPTY" gate is stale. `[abhi]`: check for rows first (`users`, `restaurants`,
   `support_requests` — `/api/me/contact` lead capture runs *without* the allowlist, so a stray
   lead row is possible; keep any you find), then restore after
   `DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION vocotable_app;`, still
   connecting as `vocotable_app`. Step 4's migrate then no-ops at 042 — that is success.
0a. **Row counts to reconcile (read from the VM 3 Sep 2026):** `restaurants` **15** (Mazcina,
   Cuban Corner, Natalia's Bistro `live`; twelve test/cancelled), `reservations` 22,
   `call_logs` 220, `agreement_acceptances` 7, `users` 18, `restaurant_members` 16,
   Mazcina `menu_items` 31 with 10 `recommend_rank`. Not 6 as step 2 says.
0b. **Platform PR #63 was closed unmerged, but its content is on `main`** (commit "Give the Cloud
   Run prod api the env it needs to boot and keep SMS working", applied 2 Sep; the one failed
   run that day was a state-lock collision). The parity that is still missing is in
   [biteperk-cloud-platform PR — voxtable prod parity, 3 Sep](#) (see §0c). Platform #62 is
   still open; treat it as a gate only if the 038 demotion WARNING appears in the migrate log.
0c. **Terraform parity before the flip** (`[abhi]` applies): `SELF_SERVE_SIGNUP_ENABLED=true`
   (the fix), `EMAIL_VERIFICATION_CODE_ENABLED=true`, `ORDER_FIRE_AT_ENABLED=true`,
   `KITCHEN_LEAD_MINUTES=25`, `VOICE_AUTOBOOK_MAX_PARTY=4`, `STRIPE_CONNECT_ENABLED=true`,
   `STRIPE_TRIAL_DAYS=7`, and the **`RETELL_WEBHOOK_SECRET`** managed secret — **✅ applied
   3 Sep 2026** (platform PRs #68 + #69, apply run `33734906112`: 4 added, 4 changed, 1
   destroyed — the destroy being the secret-version nonce helper; api and worker rolled new
   revisions on the unchanged 1.1.0 images). Verified the same day by hash: the Biteperk workspace has one key badged
   Webhook, and the VM's `RETELL_API_KEY` and `RETELL_WEBHOOK_SECRET` are that same string
   (an earlier note claiming production differed from Staging was wrong). `env.ts` would fall
   back to the API key anyway, so the explicit secret is belt-and-braces, not a fix. Gate:
   `latestCreatedRevision == latestReadyRevision` and `/health` still `database: ok`.
0d. **Move the people, not just the rows** `[sam]`. Firebase users do not travel with the
   database and `restaurant_members.user_id` is the Firebase uid. 22 accounts exist in project
   `vocotable` (Google + email/password). Enable Email/Password and Google providers on
   `bp-voxtable-prod`; `firebase auth:export users.json --project vocotable`;
   `firebase auth:import users.json --project bp-voxtable-prod --hash-algo SCRYPT …` with the
   scrypt parameters from the `vocotable` project's Auth settings (import preserves `localId`,
   so memberships and passwords survive); set the branded Auth email sender/templates; delete
   `users.json` (it holds password hashes). Gate: sign in at `bp-voxtable-prod.web.app` as
   `skalaliya@gmail.com` → `/api/me` on the `.run.app` URL returns `is_admin: true`.
0e. **Storage rules** `[sam]`: `firebase deploy --only storage --project bp-voxtable-prod`. The
   wizard's menu upload writes to `bp-voxtable-prod.firebasestorage.app`; rules deploy by hand
   and forgetting them broke uploads on 31 Jul. Old menu images keep their `vocotable` bucket
   URLs, which stay readable via their tokens.
0f. **Domain mapping days BEFORE the flip** `[abhi]`:
   `gcloud beta run domain-mappings create --service voxtable-prod-api --domain api.biteperk.com.au --region australia-southeast1`
   (domain verified to the executing identity). The region currently lists zero mappings, so
   this path is untested here; if it is refused, the fallback is an HTTPS load balancer with a
   serverless NEG. Gate: the mapping reports a served certificate before step 7 touches DNS.
0g. **Legacy dashboard hosts after the flip** `[sam]`: `vocotable.web.app` /
   `vocotable.biteperk.com.au` carry a bundle that authenticates against `vocotable`, which the
   Cloud Run backend rejects. Deploy the redirect page in `deploy/legacy-redirect/` to the
   `vocotable` hosting site (`firebase deploy --only hosting:app --project vocotable` with
   `public` pointed at that folder). Tell Camilo's kitchen to open `kds.biteperk.com.au`.
0h. **Rollback honesty.** DNS back to `136.113.35.88` restores calls in under a minute, but the
   dashboard is then split-brain (users hold `bp-voxtable-prod` tokens the VM rejects) and any
   sign-up made on Cloud Run in the gap exists only there. Rollback is clean for the first
   hours; after that, fix forward.
0j. **Sign-ups made on Cloud Run BEFORE the restore are wiped by step 3.** The public address
   already fronts Cloud Run, so once the parity apply lands, real venues can sign up there
   ahead of the data move. Rule: **restore the VM data before inviting anyone.** If a real venue
   has signed up on Cloud Run by restore day, step 3 becomes a merge, not a drop — dump only the
   Cloud Run rows created after the VM cut-off (`users`, `restaurants`, `restaurant_members`,
   `agreement_acceptances`, `menu_*`, `support_requests` — by `created_at`) and re-insert them
   after the VM restore. Test accounts (e.g. `jj@biteperk.com.au`, 3 Sep) are disposable.
0k. **Sam's account has no Auth or Rules admin on `bp-voxtable-prod`** (`auth:export` →
   `INSUFFICIENT_PERMISSION`; `getIamPolicy` denied). §0d (user import) and §0e (storage rules)
   therefore need a one-time grant of `roles/firebaseauth.admin` + `roles/firebaserules.admin`
   to `skalaliya@gmail.com` on that project by whoever owns it — the platform root grants no
   human roles. Until then, both steps are `[abhi]`.
0l. **Order inside the wizard on the new stack:** the menu step's upload is refused until §0e
   (storage rules) is deployed, and the trial step runs **live** Stripe checkout — do not click
   through it on a test account.
0m. **Secret parity, read by hash on 3 Sep 2026 (prod Secret Manager vs VM `.env`):** equal —
   `ZEPTOMAIL_TOKEN`, `RETELL_API_KEY`, `RETELL_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_SECRET`.
   **Different** — `STRIPE_SECRET_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
   `MENU_OCR_API_KEY`. Twilio is expected (the VM still carries the legacy Algorythmos
   credentials per `domain-migration.md`; Cloud Run should hold Biteperk-production's — confirm
   the SID is `ACd423bd09…`). Stripe and OCR must be settled before step 7: if Cloud Run's Stripe
   key is not the **live** key the VM bills with, every checkout after the flip is wrong.
0n. **The worker's CPU allocation was inherited, not declared.** Every outbox tick —
   verification codes, booking SMS, Cal.com mirror, reapers — is a `setInterval` that only runs
   while the instance has CPU. The module never set `cpu_idle`; the staging worker's live
   revision reads `run.googleapis.com/cpu-throttling=false` (always allocated) by provider
   default only. Pinned explicitly (`cpu_idle = false`) in a platform PR so a default change
   cannot silently stall the worker. **Not** the cause of the 3 Sep missing code: that test used
   made-up `@biteperk.com.au` addresses; re-test with a mailbox that exists before blaming the
   worker (the admin `/api/admin/ops-summary` shows notification outbox counts once an admin
   account exists in `bp-voxtable-prod`).
0i. **Proof that sign-up is open** (after step 7): a brand-new, non-allowlisted email signs up at
   `voxtable.biteperk.com.au` → code email from `hello@biteperk.com.au` → restaurant created →
   listed in `/admin/venues`. Rehearse the identical walk on `bp-voxtable-stg.web.app` first.
   Then update `deploy/voice-lines.json`'s production block to `retell_credentials.via:
   "secret-manager"` (`bp-voxtable-prod`, `voxtable-prod-retell-api-key`) and `db.via:
   "unreachable"`, mirroring staging, and run `npm run check:voice-lines`.

---

### 1. Legal manifest resolves `[agent]`
```bash
curl -sf https://storage.googleapis.com/bp-voxtable-prod-legal-documents/current/manifest.json | head -c 400
```
Gate: HTTP 200 and a `document_set_version`. Abort: run `publish-legal-documents.yml` on
`main` and re-check — the api boot gate dies without this.

### 2. Fresh dump from the VM `[agent]`
```bash
gcloud compute ssh core-central-vm --zone us-central1-a --project vocotable-497209 \
  --command "sudo docker exec vocotable-postgres-1 pg_dump -U vocotable --no-owner --no-acl vocotable" > /tmp/cutover-dump.sql
grep -c '^COPY' /tmp/cutover-dump.sql   # table count sanity (expect ~32)
```
Gate: dump >500KB, ~32 COPY blocks. **Expect 6 `restaurants` rows, not 2** — Mazcina (`live`)
and Cuban Corner (`provisioning`) plus four test/leftover venues (Dishoom, Haryana, Mazcina 123,
Dnata). All six migrate; that is correct. Clean up test rows post-cutover, never mid-cutover.
Record row counts to reconcile in step 3:
```bash
gcloud compute ssh core-central-vm --zone us-central1-a --project vocotable-497209 \
  --command "sudo docker exec vocotable-postgres-1 psql -U vocotable -t -c \"SELECT 'restaurants',count(*) FROM restaurants UNION ALL SELECT 'reservations',count(*) FROM reservations UNION ALL SELECT 'menu_items',count(*) FROM menu_items UNION ALL SELECT 'call_logs',count(*) FROM call_logs\""
```
**From this moment the VM is read-only in spirit: no bookings should land between dump and
flip, so do steps 2–7 inside one quiet window (early morning).**

### 3. Restore into Cloud SQL + reconcile `[abhi]`
**Restore via the Cloud SQL Auth Proxy, CONNECTING AS `vocotable_app`.** Do **not** use
`gcloud sql import sql` — it restores as `cloudsqladmin`, so with `--no-owner --no-acl` every
table lands owned by the wrong role, the app hits `permission denied for table restaurants`,
and migration 038 will NOT repair it (038 is already recorded in the restored
`schema_migrations`, so it never re-runs). Restoring as `vocotable_app` makes ownership ==
runtime role and grants are inherent.

Target the database the prod `DATABASE_URL` secret names — **check the secret first, do not
assume** (it also carries the `vocotable_app` password):
```bash
gcloud secrets versions access latest --secret voxtable-prod-database-url --project bp-voxtable-prod | sed -E 's#//([^:]+):[^@]+@#//\1:***@#'
```
```bash
cloud-sql-proxy bp-voxtable-prod:australia-southeast1:voxtable-prod-postgres --port 5433 &
# The target DB must be EMPTY (services are still on the bootstrap image; the migrate job is
# a placeholder that has never run). If \dt shows tables, stop and find out why before
# dropping anything.
psql "postgresql://vocotable_app:<PW_FROM_SECRET>@localhost:5433/<DB_FROM_SECRET>" -c '\dt'
psql "postgresql://vocotable_app:<PW_FROM_SECRET>@localhost:5433/<DB_FROM_SECRET>" \
  -v ON_ERROR_STOP=1 -f /tmp/cutover-dump.sql
```
Gate: the four row counts match step 2 exactly (re-run the step-2 count query over the proxy).
Abort: drop and re-restore; nothing else has happened yet.

### 4. Migrate from the NEW image `[abhi]`
⚠️ **Placeholder trap:** Terraform ships `voxtable-prod-migrate` as a bootstrap placeholder
(`/bin/sh -c "echo bootstrap migration job"` — `prod/main.tf`). Executing it before anything
has swapped its image **echoes and exits 0 having migrated nothing** — the same silent-no-op
class as the 20 Aug VM incident. The deploy-backend workflow is what updates the job to the
real api image running `dist/db/migrate.js` and executes it; if running by hand, `gcloud run
jobs update voxtable-prod-migrate --image <api:semver> ...` FIRST, then:
```bash
gcloud run jobs execute voxtable-prod-migrate --project bp-voxtable-prod --region australia-southeast1 --wait
```
Because step 3 restored a dump already at the current head, the expected result is a clean
**no-op pass** (every file already in `schema_migrations`) — that is success, not a failure.
Gate — both, as the app role:
```
SELECT max(filename) FROM schema_migrations;   -- expect the repo's current head (042_restaurant_owner_phone.sql as of 2 Sep 2026)
SELECT count(*) FROM restaurants;              -- connects and reads as the runtime role (expect 6)
```
Watch the job logs for the 038 demotion WARNING — if it appears, the role demotion still needs
a privileged run (platform #62's one-liner). Abort: read the job logs; do not roll services on
a failed migrate.

### 5. Roll services, verify directly `[agent]`
```bash
# deploy-backend.yml on main does this on promotion; if running by hand:
gcloud run services update voxtable-prod-api    --image <api:semver>    --project bp-voxtable-prod --region australia-southeast1
gcloud run services update voxtable-prod-worker --image <worker:semver> --project bp-voxtable-prod --region australia-southeast1
API=$(gcloud run services describe voxtable-prod-api --project bp-voxtable-prod --region australia-southeast1 --format='value(status.url)')
curl -sf $API/health; curl -sf $API/readyz
```
Gate: both 200, `database: ok`. Abort: revision rollback
(`gcloud run services update-traffic voxtable-prod-api --to-revisions <prev>=100 …`) — drilled
on staging, timings in `rollback.md`.

### 6. Pre-flip call check `[sam]`
Ring BOTH lines (`+61 468 202 846`, `+61 485 071 140`). They still traverse the VM — this
establishes the working baseline you will compare against two minutes after the flip.
Gate: both answer normally. Abort: fix before flipping; the flip must not be the variable
that hides an existing fault.

### 7. DNS flip `[sam]`
Cloudflare → zone `biteperk.com.au` → `api` A record `136.113.35.88` → change to a CNAME of the
Cloud Run domain mapping (or the mapping's A records), **gray cloud** (DNS-only — orange breaks
Retell/Twilio signature URLs and certbot). TTL is already low.
Immediately: `[sam]` ring both lines again; `[agent]` `curl -sf https://api.biteperk.com.au/health`
until it serves from Cloud Run (header `server` no longer nginx).
Gate: both lines answer, booking leg 3 of the rehearsal card lands on the dashboard.
**Abort (≤60s): point the record back at `136.113.35.88` — the VM is still running and intact.**

### 8. Only now: stop the VM containers `[agent]`
```bash
gcloud compute ssh core-central-vm --zone us-central1-a --project vocotable-497209 \
  --command "cd /opt/vocotable && sudo docker compose stop api worker"
```
The VM (and Postgres container) stays bootable for **2 weeks** as rollback; decommission is a
separate change (#153 retires the backup chain with it).

### 9. Disaster Recovery URLs on both trunks `[agent]`
Only once `https://api.biteperk.com.au/twilio/disaster` answers 200 on Cloud Run:
```bash
# US1 trunk (Cuban Corner) — US1 key from bp-voxtable-prod secrets:
curl -s -X POST https://trunking.twilio.com/v1/Trunks/TK50f2a0cc6c4906a1b946867489716548 \
  -u "$TWILIO_US1_KEY_SID:$TWILIO_US1_KEY_SECRET" \
  --data-urlencode "DisasterRecoveryUrl=https://api.biteperk.com.au/twilio/disaster" \
  --data-urlencode "DisasterRecoveryMethod=POST"
# Mazcina's trunk — US1 since the 31 Aug cutover (TK3140735e…, per voice-lines.json — the
# old AU1 trunk TK6fcd3c96… this step used to name is no longer the live one). Same US1 key:
curl -s -X POST https://trunking.twilio.com/v1/Trunks/TK3140735e33b7b22007a88f00f15e0e9a \
  -u "$TWILIO_US1_KEY_SID:$TWILIO_US1_KEY_SECRET" \
  --data-urlencode "DisasterRecoveryUrl=https://api.biteperk.com.au/twilio/disaster" \
  --data-urlencode "DisasterRecoveryMethod=POST"
```
Gate: read each trunk back and see the URL. Then update `deploy/voice-lines.json` in the same
change and run `npm run check:voice-lines`.

### 10. Post-cutover watch `[agent]`
48h: voice-line-health green on all three lines, zero unexplained 5xx in Cloud Run logs, daily
call-log review for a week. Then the full rehearsal battery
(`deploy/runbooks/cuban-corner-rehearsal-call-script.md`) gates go-live.
