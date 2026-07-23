# Prod config hardening — prerequisite for the onboarding cutover

> Historical hardening plan from the onboarding cutover. The current production
> configuration expectations are captured in `.env.example`,
> `apps/backend/src/config/env.ts`, and `apps/backend/docs/gcp-deployment.md`.

Recon of `core-central-vm` (2026-05-29) found the "production" box is running a
**development configuration**. Harden it BEFORE rebuilding with the onboarding
code (which adds `/api/admin/*` + onboarding endpoints — we don't want those on
an unauthenticated box). The validated migrations (`007–012`) are applied as
part of this, not before.

## What recon found (the live VM `/opt/vocotable/.env`)
| Setting | Now | Problem |
|---|---|---|
| `APP_ENV` | `development` | prod fail-safes off; voice/tenant use dev fallbacks |
| `firebase-admin.json` | an empty **directory** (Docker auto-created the bind-mount) | Firebase Admin not wired → token verification can't work |
| `DASHBOARD_VERIFY_AUTH` | unset → off | **dashboard API is unauthenticated** |
| `DASHBOARD_ALLOWED_EMAILS` | empty | no allowlist |
| `TWILIO_PHONE_NUMBER` / `RETELL_PHONE_NUMBER` | empty | voice resolves via dev default only |
| `DEFAULT_RESTAURANT_ID` | `11111111-…` (local test UUID) | keep as-is — existing data references it |

## Secrets / values needed from Sam (before cutover)
1. **Real Firebase service-account JSON** → place at `/opt/vocotable/firebase-admin.json`
   (delete the empty dir first: `sudo rmdir /opt/vocotable/firebase-admin.json`).
2. **Allowlists**: `DASHBOARD_ALLOWED_EMAILS` (owner+staff), `DASHBOARD_MANAGER_EMAILS`,
   `DASHBOARD_ADMIN_EMAILS` (VocoTable staff for the provisioning console).
3. **Natalia's real numbers**: `TWILIO_PHONE_NUMBER`, `RETELL_PHONE_NUMBER` (E.164).
4. Confirm keep `DEFAULT_RESTAURANT_ID=11111111-…` (do NOT change — existing
   reservations/call_logs reference it).

## Hardened cutover order
1. **Firebase**: `sudo rmdir /opt/vocotable/firebase-admin.json` then upload the
   real JSON to that path (the prod compose already mounts it `:ro`).
2. **`.env`** — set:
   ```
   APP_ENV=production
   DASHBOARD_VERIFY_AUTH=true
   DASHBOARD_ALLOWED_EMAILS=<owner,staff,...>
   DASHBOARD_MANAGER_EMAILS=<owner,...>
   DASHBOARD_ADMIN_EMAILS=<vocotable-staff,...>
   MULTITENANCY_LEGACY_FALLBACK=true     # existing allowlisted users → default restaurant w/o backfill
   TWILIO_PHONE_NUMBER=+61...            # Natalia's real number
   RETELL_PHONE_NUMBER=+61...
   # feature flags stay OFF:
   MENU_OCR_ENABLED=false
   STRIPE_BILLING_ENABLED=false
   NOTIFICATIONS_ENABLED=false
   PROVISIONING_AUTO_ENABLED=false
   ```
   ⚠️ `APP_ENV=production` + `DASHBOARD_VERIFY_AUTH=true` together flip auth from
   off→on. The allowlist + firebase JSON MUST be correct or the dashboard locks
   out. (`APP_ENV=production` also makes voice **fail safe** on an unmapped number,
   so step 4's number set is required first.)
3. **Backup** the prod DB (`pg_dump`, copied off-box).
4. **Migrations** `007–012` via `psql -f` (validated clean on a prod-data canary
   2026-05-29 — see `onboarding-rollout.md` Step 2). Set Natalia's restaurant
   `twilio_phone_number`/`retell_phone_number` (targeted `UPDATE`, NOT the full
   `db:seed` — that would clobber name/timezone/transfer_phone_number).
5. **Build + deploy** the onboarding code (the merged `main` tree is already laid
   into `/opt/vocotable` — see note below): `docker compose -f docker-compose.yml
   -f docker-compose.prod.yml up -d --build --force-recreate`.
6. **Smoke** (with auth now ON): log in with a real allowlisted Google account →
   reservations/call-logs/menu load; `GET /api/me` returns the membership;
   `/api/admin/*` rejects a non-admin; **place a live test call** → booking lands
   with the correct `restaurant_id`. Roll back the container image if anything fails.

## ⚠️ State note (important)
The merged `main` tree is **already extracted into `/opt/vocotable`** (working
tree only). The **running container is unchanged** (no source bind-mount). **Do
NOT run `docker compose ... up -d --build` until steps 1–4 are done**, or you'll
deploy the expanded API onto the unhardened/dev config. To abort entirely, the
prior container keeps running regardless until an explicit rebuild.

## Recommended follow-up (separate)
The dev-mode prod + file-copy deploys + disabled org deploy-keys are deploy-hygiene
debt. Plan: CI builds the image on merge → push to Artifact Registry → VM
`docker compose pull && up -d`. Removes building/git/file-copy from prod.
