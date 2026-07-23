# Onboarding batch deploy — runbook

> Historical batch-deploy note. Keep for audit context, but use
> `apps/backend/docs/gcp-deployment.md`, `deploy/runbooks/rollback.md`, and
> `deploy/runbooks/backup-restore.md` for current production operations.

The production-grade hardening was committed to `main` in stages. A1–A4 + B1 + B2 are **already live**
(image built from commit `4933407`). Four further commits are on `main` but **not yet on the VM**, plus
the external integrations (OCR / Stripe / SendGrid) that need keys + Firebase Storage. This runbook is
the single mechanical cutover to bring it all live once Sam has (a) re-enabled GCP billing and (b)
grabbed the keys.

> **Prereqs (Sam, outside this runbook):**
> 1. **GCP billing re-enabled** on project `vocotable-497209` (the "Main-Billing" account was closed).
>    Then optionally resize the disk: `gcloud compute disks resize core-central-vm --size=20 --zone=us-central1-a`
>    then on the VM `sudo growpart /dev/sda 1 && sudo resize2fs /dev/sda1`.
> 2. **Firebase Storage bucket provisioned** (Firebase console → Storage → Get started, region
>    `australia-southeast1`).
> 3. **Keys in hand** (entered by Sam directly on the VM `.env`, never pasted to the agent):
>    OCR (Gemini free and/or OpenRouter), Stripe price id + webhook secret, SendGrid (optional).

Coordinate with Ali before deploying (he pushes to `main` directly). Per CLAUDE.md, env is baked at
container creation → **force-recreate** after any `.env` change.

---

## Commits shipping in this batch (since the live image `4933407`)
- `0e093c8` D1 — daily Slack onboarding-funnel summary
- `30f623f` C1 — `storage.rules` + `firebase.json` wiring
- `6066720` B3 — provisioning re-checks active subscription before buying a number
- `b551fb8` C2 — provider-agnostic menu OCR (open-weight VLM support)
- `+ S1/S2/S3/S4` — isolation smoke script, `/api/admin/onboarding-health`, `.env.example`, this runbook

Rollback image is tagged **`vocotable-api:rollback-pre-onboarding`** (`8e8c1a0d`); the current live
image is `vocotable-api:latest` (`9cee27b`, the B2 build). Tag it before recreating (step 3) so you can
revert in one command.

---

## Step 0 — sync the VM working tree to `main`
```
gcloud config set project vocotable-497209
# Push code to the VM (file-copy deploy; the VM has no git creds). From the Mac repo root:
gcloud compute scp --recurse apps/backend/src core-central-vm:/tmp/src-new --zone us-central1-a
# …or the established tar/rsync push. Then on the VM, lay it into /opt/vocotable and verify:
gcloud compute ssh core-central-vm --zone us-central1-a --command \
  'cd /opt/vocotable && grep -c EMAIL_NOT_VERIFIED apps/backend/src/auth/firebaseAuth.js 2>/dev/null; \
   git -C /opt/vocotable log --oneline -1 2>/dev/null || true'
```
(If the VM ever regains git creds, prefer `git fetch && git reset --hard origin/main`.)

## Step 1 — set the env (Sam, on the VM, in his own shell)
Edit `/opt/vocotable/.env`. For OCR pick ONE block:

**Gemini (free tier, fastest to validate):**
```
MENU_OCR_ENABLED=true
MENU_OCR_PROVIDER=openai
MENU_OCR_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
MENU_OCR_MODEL=gemini-2.0-flash
MENU_OCR_API_KEY=<gemini key from aistudio.google.com/apikey>
```
**OpenRouter (open-weight Qwen2.5-VL):**
```
MENU_OCR_ENABLED=true
MENU_OCR_PROVIDER=openai
MENU_OCR_BASE_URL=https://openrouter.ai/api/v1
MENU_OCR_MODEL=qwen/qwen-2.5-vl-72b-instruct
MENU_OCR_API_KEY=<openrouter key from openrouter.ai/keys>
```
Stripe (when ready): `STRIPE_BILLING_ENABLED=true`, `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`,
`STRIPE_WEBHOOK_SECRET`. Notifications (optional): `NOTIFICATIONS_ENABLED=true`, `SENDGRID_API_KEY`.
Leave `PROVISIONING_AUTO_ENABLED=false` until a supervised pilot (C5).

## Step 2 — reclaim disk headroom (if not resized)
```
gcloud compute ssh core-central-vm --zone us-central1-a --command \
 'sudo docker builder prune -af; sudo apt-get clean; df -h / | tail -1'
```
Need ≥1.5 GB free for the build (build holds old+new image simultaneously).

## Step 3 — tag rollback, build, force-recreate
```
gcloud compute ssh core-central-vm --zone us-central1-a --command '
  cd /opt/vocotable
  sudo docker tag vocotable-api:latest vocotable-api:rollback-$(date +%Y%m%d) || true
  sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml build api
  sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-build --force-recreate api
'
```

## Step 4 — Firebase Storage rules (after the bucket exists)
```
# From the Mac repo root (firebase CLI authed):
firebase deploy --only storage --project vocotable
```

## Step 5 — smoke (do NOT announce done until green)
```
gcloud compute ssh core-central-vm --zone us-central1-a --command '
  sudo docker ps --format "{{.Names}} | {{.Status}}"
  curl -s -o /dev/null -w "local /health -> %{http_code}\n" http://localhost:3050/health
'
curl -s -o /dev/null -w "public /health -> %{http_code}\n" https://vocotable.algorythmos.com.au/health
```
- `/health` 200 local + public; container healthy.
- Admin token → `GET /api/admin/onboarding-health` returns funnel + `menu_ocr_today`; non-admin → 403.
- **OCR end-to-end:** sign in as a new owner → menu step → upload a menu photo → OCR draft appears →
  review → commit → `menu_items` rows land and status advances `menu→trial`. Watch `menu_ocr_call`
  log lines for the provider/model/token counts.
- **Stripe (if enabled, test mode):** checkout → webhook → `trial→provisioning` (Stripe `stripe listen`
  or the registered prod webhook).
- DB row counts unchanged for existing tenants (Natalia's data intact).

## Rollback (≤1 min)
```
gcloud compute ssh core-central-vm --zone us-central1-a --command '
  cd /opt/vocotable
  sudo docker tag vocotable-api:rollback-pre-onboarding vocotable-api:latest
  sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-build --force-recreate api
'
```
Or set the offending flag back to `false` + force-recreate (env-only issues). Migrations are additive —
do not roll them back.

## Notes
- OCR quality: open-weight VLMs read menus well but can fuzz prices — the wizard's review-against-photo
  step is the safety net (owner confirms before commit), so an open model is safe here.
- The whole batch is inert without the flags: shipping the code with flags off changes nothing at
  runtime, so Step 0+3 can be done independently of the keys if you just want the image current.
