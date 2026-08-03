# Domain migration — `vocotable.*` → `*.biteperk.com.au`

Moves the production surfaces onto company-native, product-agnostic hostnames.
The API currently answers on **`vocotable.algorythmos.com.au`** — the old agency
domain under the retired product name — which is the main thing this fixes.

| Surface | From | To |
|---|---|---|
| Client dashboard | `vocotable.biteperk.com.au` (+ `vocotable.web.app`) | **`app.biteperk.com.au`** |
| Backend API | `vocotable.algorythmos.com.au` | **`api.biteperk.com.au`** |
| Kitchen display | `kitchen.vocotable.biteperk.com.au` (+ `vocotable-kds.web.app`) | **`kds.biteperk.com.au`** |

**The governing rule: this is additive, never a cutover.** Old hostnames keep
serving throughout. Each vendor is migrated one at a time and verified before
the next. At no point should there be a window where an inbound call can fail.

## Do NOT

- **Do not orange-cloud the Cloudflare records.** They must be **DNS-only (gray
  cloud)** — proxying breaks Let's Encrypt HTTP-01 and rewrites the request host
  that Retell/Twilio signature verification depends on.
- **Do not change `bookings.vocotable.algorythmos.com.au`** (`SYNTH_EMAIL_DOMAIN`,
  `services/calcomService.ts:56`). It is baked into the attendee identity of every
  existing Cal.com booking; changing it orphans them. It is internal-only and
  never shown to customers.
- **Do not remove the legacy `server_name` / CORS entries** until every vendor in
  Phase 4 is migrated and verified, plus a grace period.

## Phase 1 — DNS (additive, zero impact)

In Cloudflare, zone `biteperk.com.au`, add **DNS-only (gray cloud)**:

```
api.biteperk.com.au   A   136.113.35.88
```

`app.` and `kds.` records are created by Firebase Hosting in Phase 5 — don't
pre-create them.

Verify:
```bash
dig +short api.biteperk.com.au
```
Must return `136.113.35.88` and nothing Cloudflare-proxied (no `104.21.*` /
`172.67.*`).

## Phase 2 — TLS + nginx (additive)

One certificate covering both hostnames, so the vendor cutover has no gap:

```bash
sudo certbot certonly --webroot -w /var/www/certbot \
  --cert-name api.biteperk.com.au \
  -d api.biteperk.com.au -d vocotable.algorythmos.com.au
```

Then copy `deploy/nginx/vocotable.conf` (already updated for both hostnames) to
the VM, and:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Verify **both** still answer:
```bash
curl -sf https://api.biteperk.com.au/health
curl -sf https://vocotable.algorythmos.com.au/health
```

## Phase 3 — Backend env

In `/opt/vocotable/.env` set `PUBLIC_API_BASE_URL=https://api.biteperk.com.au`.
Env is baked at container creation — a plain restart will not pick it up:

```bash
cd /opt/vocotable && sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  -f docker-compose.deploy.yml up -d --force-recreate api worker
```

`config/env.ts` keys the three security gates off this URL, so confirm it is not
localhost and that the containers came up healthy (a bad value refuses to boot).

## Phase 4 — Vendors, ONE at a time, least → most critical

Migrate, verify, then move on. **Rollback for every step is identical:** point
the vendor URL back at `vocotable.algorythmos.com.au`, which is still serving.

1. **Stripe** — Workbench → the `vocotable-billing` destination → endpoint URL →
   `https://api.biteperk.com.au/stripe/webhook`.
   Verify: send a test event; expect 200 and a delivery row.
2. **Cal.com** — webhook URL → `https://api.biteperk.com.au/cal/webhook`.
   Verify: `GET /api/ops/calcom-health` (inbox failures must stay flat).
3. **Retell** — `/retell/inbound`, `/retell/webhook`, and the two
   `/retell/tools/*` custom-function URLs. Signature verification is
   **URL-sensitive**. Snapshot the current config into
   `deploy/retell-snapshots/` first.
   Verify: **place a live test call** and confirm a `call_logs` row lands.
4. **Twilio** — `/twilio/voice` and `/twilio/status`. Signature validation uses
   the **full request URL**, so a host mismatch rejects every inbound call.
   This is the highest-risk step — do it when you can watch it.
   Verify: **place a live test call immediately**; confirm the booking completes
   end-to-end and `logger` shows no `twilio_signature_invalid`.

## Phase 5 — Frontend

1. **Firebase Hosting** → add custom domain `app.biteperk.com.au` to target
   `app`, and `kds.biteperk.com.au` to target `kds`. Follow the TXT/A records
   Firebase issues (these are the `app.`/`kds.` DNS records).
2. **Firebase Auth → Settings → Authorized domains**: add `app.biteperk.com.au`.
   **Miss this and Google sign-in breaks on the new hostname.**
3. **GitHub repo variable** `VITE_API_BASE_URL` → `https://api.biteperk.com.au`.
4. **`/opt/vocotable/.env`**: `STRIPE_CHECKOUT_SUCCESS_URL`,
   `STRIPE_CHECKOUT_CANCEL_URL`, `STRIPE_PORTAL_RETURN_URL` → `app.biteperk.com.au`
   paths (they currently default to `vocotable.web.app`). Force-recreate again.
5. **Google Maps key** → add `app.biteperk.com.au/*` to the HTTP-referrer
   restrictions, or address autocomplete 403s on the new host.
6. Re-run the frontend deploy so the bundle points at the new API.

Verify: sign in at `https://app.biteperk.com.au`, load the dashboard and the
onboarding wizard, and confirm the browser console shows no CORS or auth errors.

## Phase 6 — Grace period

Keep the legacy hostnames serving for **at least 90 days** (301 redirect for the
dashboard; the API keeps answering on both `server_name`s). Only then consider
trimming the legacy entries from `app.ts` CORS and the nginx `server_name`.

`vocotable.web.app` already 301s to the branded dashboard hostname preserving the
path, so Stripe return URLs survive even before Phase 5 step 4.

## Not covered here

The Firebase **project id** (`vocotable` / `vocotable-497209`), the Artifact
Registry path, the `vocotable_number` API field and event/storage keys stay as
they are — renaming those is a far larger migration with no customer-visible
benefit. This runbook only moves the hostnames customers and vendors touch.
