# VocoTable GCP VM Deployment

This is the current deployment guide for the backend stack. The older generic `api.vocotable.com` / `vocotable-api` VM instructions have been removed because production now runs on the `core-central-vm` VM and the public API URL used by the app is `https://vocotable.algorythmos.com.au`.

## Current Production Shape

- GCP project: `vocotable-497209`.
- VM: `core-central-vm`.
- Backend runtime: Docker Compose.
- Backend port inside host: `3050`.
- Reverse proxy: nginx + certbot.
- API URL: `https://vocotable.algorythmos.com.au`.
- Database: PostgreSQL container from `docker-compose.yml`.
- Frontend: Firebase Hosting target `app`.
- KDS: Firebase Hosting target `kds`.
- Production Firebase Admin credentials: mounted read-only into the backend container.

## Files That Matter

- `Dockerfile`: builds the backend image.
- `docker-compose.yml`: postgres and API services.
- `docker-compose.prod.yml`: production-only Firebase Admin credential mount.
- `.env.example`: complete env reference.
- `deploy/nginx/vocotable.conf`: nginx reverse proxy template.
- `firebase.json`: Firebase Hosting targets for app and KDS.
- `deploy/runbooks/rollback.md`: rollback procedures.
- `deploy/runbooks/backup-restore.md`: database backup/restore.
- `deploy/runbooks/onboarding-rollout.md`: onboarding rollout checklist.
- `deploy/runbooks/kds-kiosk.md`: KDS deployment and kiosk setup.

## First-Time Host Setup

Install Docker, Docker Compose plugin, nginx, and certbot on the VM.

```bash
gcloud compute ssh core-central-vm --zone us-central1-a

sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg nginx certbot python3-certbot-nginx

sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Create the app directory:

```bash
sudo mkdir -p /opt/vocotable
sudo chown "$USER:$USER" /opt/vocotable
```

## Production Environment

Copy `.env.example` to `.env` on the VM and fill real production values.

Required production posture:

- `APP_ENV=production`
- `PUBLIC_API_BASE_URL=https://vocotable.algorythmos.com.au`
- `DASHBOARD_VERIFY_AUTH=true`
- `DASHBOARD_ALLOWED_EMAILS` non-empty
- `RETELL_VERIFY_SIGNATURE=true`
- `TWILIO_VALIDATE_SIGNATURE=true`
- `DATABASE_URL` points at the compose postgres service when running in Docker
- `GOOGLE_APPLICATION_CREDENTIALS=/secrets/firebase-admin.json`

Feature flags stay off until their credentials and runbooks are ready:

- `CALCOM_SYNC_ENABLED`
- `STRIPE_BILLING_ENABLED`
- `MENU_OCR_ENABLED`
- `NOTIFICATIONS_ENABLED`
- `PROVISIONING_AUTO_ENABLED`
- `MULTITENANCY_LEGACY_FALLBACK`

When a flag is enabled in production, `config/env.ts` enforces the matching credentials.

## Firebase Admin Credential

Production compose mounts Firebase Admin credentials read-only:

```yaml
GOOGLE_APPLICATION_CREDENTIALS: /secrets/firebase-admin.json
volumes:
  - ./firebase-admin.json:/secrets/firebase-admin.json:ro
```

Keep `firebase-admin.json` out of git.

## Build and Start Backend

On the VM:

```bash
cd /opt/vocotable

docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f api
```

Run migrations:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec api npm run db:migrate:prod
```

Do not run seed data in production. Production restaurants, menu items, users,
and memberships should be created through the application/admin flow or targeted
operational SQL reviewed for that deployment.

## nginx and TLS

Install the nginx site config:

```bash
sudo cp deploy/nginx/vocotable.conf /etc/nginx/sites-available/vocotable
sudo ln -sf /etc/nginx/sites-available/vocotable /etc/nginx/sites-enabled/vocotable
sudo nginx -t
sudo systemctl reload nginx
```

Issue or renew TLS with certbot for `vocotable.algorythmos.com.au`.

Cloudflare DNS must allow Let's Encrypt HTTP-01 challenges. If proxying causes certificate or webhook issues, set the record to DNS-only while issuing/renewing.

## Verify Backend

```bash
curl -fsS https://vocotable.algorythmos.com.au/health
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs --tail 100 api
```

For local or staging smoke checks against a running backend:

```bash
PUBLIC_API_BASE_URL=https://vocotable.algorythmos.com.au npm run smoke:backend
```

Only run provider-specific smoke scripts against production when you understand the side effects.

## Frontend Deploy

Build the main app with the production API URL baked into the Vite bundle:

```bash
VITE_API_BASE_URL=https://vocotable.algorythmos.com.au npm run build:frontend
firebase deploy --only hosting:app
```

Build and deploy KDS:

```bash
VITE_API_BASE_URL=https://vocotable.algorythmos.com.au npm run build:kds
firebase deploy --only hosting:kds
```

`firebase.json` defines both hosting targets and cache headers.

## Webhook URLs

Configure providers to use the production API URL:

Retell:

```text
https://vocotable.algorythmos.com.au/retell/webhook
https://vocotable.algorythmos.com.au/retell/inbound
https://vocotable.algorythmos.com.au/retell/tools/check-availability
https://vocotable.algorythmos.com.au/retell/tools/create-booking
```

Twilio:

```text
https://vocotable.algorythmos.com.au/twilio/voice
https://vocotable.algorythmos.com.au/twilio/status
```

Cal.com:

```text
https://vocotable.algorythmos.com.au/cal/webhook
```

Stripe:

```text
https://vocotable.algorythmos.com.au/stripe/webhook
```

## Common Operations

Restart API:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart api
```

View logs:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f api
```

Check containers:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
```

Stop stack:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml down
```

Do not use `down -v` in production unless you intentionally want to destroy the database volume.

## Rollback and Backups

Use the active runbooks:

- [`../../../deploy/runbooks/rollback.md`](../../../deploy/runbooks/rollback.md)
- [`../../../deploy/runbooks/backup-restore.md`](../../../deploy/runbooks/backup-restore.md)

Before risky deploys, tag the previous good image as described in the rollback runbook.
