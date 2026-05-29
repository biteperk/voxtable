# Staged rollout runbook — multi-tenant onboarding (Phases 0–5)

Turnkey, reversible procedure to ship `feat/stripe-billing` to production once
the VM git is reconciled (see `onboarding-vm-assessment.md`). Everything ships
**inert** behind kill-switches; the only always-on change is the multi-tenancy
foundation, which is protected by `MULTITENANCY_LEGACY_FALLBACK=true`.

Migrations are **additive and non-destructive** (new tables, nullable columns, a
status column defaulted then back-filled to `live` for existing rows, one
trigger). The cutover is code + migrations together; there is no safe
frontend-only or backend-only half-deploy.

## Pre-conditions (do first — see assessment doc)
- VM git reconciled to a clean checkout of `main` with `feat/stripe-billing`
  merged, `npm run check` green, `._*` junk removed, repo creds working.
- Fresh `pg_dump` backup taken and copied OFF the VM. (Tonight's:
  `~/vocotable-ops/vm-snapshot-20260529/…`.)
- Maintenance window / Sam watching; a phone ready for the live test call.

## Step 0 — one-time VM git remediation (do ONCE, before first deploy)

The VM is 81 commits behind, file-copy-deployed (AppleDouble `._*` junk), and has
no GitHub creds so it can't `git pull` (see `onboarding-vm-assessment.md`). The
config audit proved the box holds **nothing to salvage except `.env` and
`docker-compose.override.yml`**. Fix the box to a clean `git pull` deploy:

**0a. Give the VM read access to the repo (deploy key — recommended).**
```
# On the VM:
ssh-keygen -t ed25519 -C "core-central-vm deploy" -f ~/.ssh/vocotable_deploy -N ""
cat ~/.ssh/vocotable_deploy.pub      # add this in GitHub → repo Settings → Deploy keys (read-only)
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/vocotable_deploy
  IdentitiesOnly yes
EOF
# Point the repo at SSH (was HTTPS, which had no creds):
sudo git -C /opt/vocotable remote set-url origin git@github.com:biteperk/vocotable.git
sudo git -C /opt/vocotable ls-remote origin -h refs/heads/main   # verify access
```

**0b. Resync the working tree to a clean `origin/main` (safe — audit confirmed no
novel source on the box).** Back up the two VM-only files first:
```
sudo cp /opt/vocotable/.env /opt/vocotable.env.bak
sudo cp /opt/vocotable/docker-compose.override.yml /opt/dco.override.bak
sudo git -C /opt/vocotable fetch origin
sudo git -C /opt/vocotable reset --hard origin/main     # discards the stale file-copy drift
sudo find /opt/vocotable -name '._*' -delete            # remove AppleDouble junk
# .env, node_modules (gitignored) and the untracked override file survive reset; verify:
ls -la /opt/vocotable/.env /opt/vocotable/docker-compose.override.yml
sudo git -C /opt/vocotable log --oneline -1             # should be the PR #41 merge (ebbd892)
sudo git -C /opt/vocotable status --short | grep -v '^??' ; echo "(clean tracked tree expected)"
```
From here on, deploys are a clean `sudo git -C /opt/vocotable pull` — no file copies.

> Future hardening (recommended, not required now): build the image in CI on merge
> to `main`, push to Artifact Registry, and have the VM `docker compose pull && up -d`
> — removes building/git from prod entirely. Out of scope for this first rollout.

## Step 1 — env (VM `/opt/vocotable/.env`), feature flags OFF
```
MULTITENANCY_LEGACY_FALLBACK=true   # existing allowlisted users keep working pre-backfill
MENU_OCR_ENABLED=false
STRIPE_BILLING_ENABLED=false
NOTIFICATIONS_ENABLED=false
PROVISIONING_AUTO_ENABLED=false
```
Env is baked at container creation — a plain restart won't pick it up (per the
RETELL_VERIFY_SIGNATURE incident). Force-recreate in Step 4.

## Step 2 — apply migrations 007–012 via psql (avoids node-pg 08P01)
Back up first (above), then for each file in order:
```
for f in 007_multitenancy 008_onboarding_profile 009_menu_ingestion \
         010_billing_webhook 011_provisioning_jobs 012_notifications_events; do
  sudo docker exec -i vocotable-postgres-1 psql -U vocotable -d vocotable \
    -v ON_ERROR_STOP=1 -f - < apps/backend/db/migrations/${f}.sql \
  && sudo docker exec -i vocotable-postgres-1 psql -U vocotable -d vocotable \
    -c "INSERT INTO schema_migrations (filename) VALUES ('${f}.sql') ON CONFLICT DO NOTHING;"
done
```
Verify: `SELECT count(*) FROM schema_migrations;` should be 12.
(If using `npm run db:migrate:prod` instead and it hits `08P01`, fall back to the
psql-per-file loop above — see CLAUDE.md migration note.)

## Step 3 — backfill memberships + Natalia's numbers
```
sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm api npm run db:seed:prod
```
Creates `users` + `restaurant_members` for `DASHBOARD_ALLOWED_EMAILS`, sets the
existing restaurant's `twilio_phone_number`/`retell_phone_number` from env, marks
it `live`. Verify: `SELECT count(*) FROM restaurant_members;` ≥ 1.

## Step 4 — rebuild + force-recreate
```
sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build --force-recreate api
```

## Step 5 — smoke test (BEFORE announcing done)
- `GET /health` 200.
- Log in to the dashboard as an existing allowlisted user → reservations,
  call-logs, menu all load (proves tenant resolution + legacy fallback).
- `GET /api/me` → returns the membership.
- **Live voice test**: call Natalia's number, make a test booking end-to-end →
  confirm a `reservations` row + `call_logs` row with the correct `restaurant_id`
  (proves the new dialed-number voice routing). THIS is the highest-risk check.
- Frontend (Firebase Hosting): rebuild with `VITE_API_BASE_URL=https://vocotable.algorythmos.com.au`
  → `firebase deploy --only hosting`. Confirm existing live restaurant lands on
  the dashboard (status `live`), not the wizard.

## Step 6 — enable features one at a time (later, after creds verified)
Flip ON and smoke each independently, in test mode first:
`STRIPE_BILLING_ENABLED` (needs price + webhook secret + `stripe listen` →
prod webhook), `MENU_OCR_ENABLED` (vision-LLM key), `NOTIFICATIONS_ENABLED`
(SendGrid key), `PROVISIONING_AUTO_ENABLED` (`RETELL_TEMPLATE_AGENT_ID`).
`DASHBOARD_ADMIN_EMAILS` for the admin provisioning console.

## Rollback
- **Code**: `docker compose ... up -d --force-recreate` the previous image tag
  (or revert the merge + rebuild). Target ≤5 min (see `rollback.md`).
- **Migrations**: additive — safe to leave in place even on code rollback (old
  code ignores the new tables/columns). Do NOT drop them reactively.
- **Auth regression** (existing users 403'd): confirm `MULTITENANCY_LEGACY_FALLBACK=true`
  is set AND the Step-3 backfill ran. Either alone keeps existing users working.
- **Data**: if a migration left the DB wrong, restore from the Step-0 `pg_dump`
  (see `backup-restore.md`).
