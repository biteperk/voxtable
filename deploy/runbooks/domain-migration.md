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

**Order matters, and the obvious order does not work.** Certbot cannot validate
`api.biteperk.com.au` until nginx has a server block that answers for that name
on port 80 — but `vocotable.conf` cannot be installed first, because it points
`ssl_certificate` at a lineage that does not exist yet, so `nginx -t` fails.
Break the cycle with a minimal port-80 edit first.

Two facts about `core-central-vm` that the rest of this phase depends on:

- The live config is the **regular file** `/etc/nginx/sites-enabled/vocotable`.
  It is *not* a symlink into `sites-available/`. Editing `sites-available/`
  changes nothing — nginx loads it as a duplicate and discards it with
  `conflicting server name ... ignored`.
- The port-80 block is Certbot-generated and ends in a bare, server-level
  `return 404;`. Server-level `return` runs in the **rewrite** phase, before
  location matching, so simply adding the hostname to `server_name` is not
  enough: the 404 still pre-empts the ACME location. The `return 404` has to
  become `location / { return 404; }`.

### 2a — minimal port-80 edit

Back up first; `nginx -t` must pass before any reload.

```bash
sudo cp -a /etc/nginx/sites-enabled/vocotable \
  /root/nginx-backups/vocotable.pre-api.$(date +%Y%m%d-%H%M%S)
```

Rewrite only the port-80 server block so it reads:

```nginx
server {
    if ($host = vocotable.algorythmos.com.au) {
        return 301 https://$host$request_uri;
    } # managed by Certbot

    listen 80;
    server_name vocotable.algorythmos.com.au api.biteperk.com.au;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 404;
    }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Prove the challenge path actually routes before spending a rate limit — drop a
probe file in the webroot and fetch it with each Host header:

```bash
echo probe-ok | sudo tee /var/www/certbot/.well-known/acme-challenge/probe-test
for h in api.biteperk.com.au vocotable.algorythmos.com.au; do
  curl -s -o /dev/null -w "$h %{http_code}\n" -H "Host: $h" \
    http://127.0.0.1/.well-known/acme-challenge/probe-test
done
sudo rm -f /var/www/certbot/.well-known/acme-challenge/probe-test
```

Expect `api.biteperk.com.au 200` and `vocotable.algorythmos.com.au 301` — the
legacy 301 is fine, Let's Encrypt follows redirects and the 443 block serves the
same webroot.

### 2b — issue the certificate

Always dry-run first; the staging CA has no meaningful rate limit.

```bash
sudo certbot certonly --webroot -w /var/www/certbot \
  --cert-name api.biteperk.com.au \
  -d api.biteperk.com.au -d vocotable.algorythmos.com.au --dry-run
```

Only when that reports `The dry run was successful`, repeat without `--dry-run`.

Note this creates a **new** lineage named `api.biteperk.com.au` covering both
names. The old `vocotable.algorythmos.com.au` lineage keeps renewing separately
— leave it as the rollback path until Phase 6.

### 2c — install the full config

```bash
sudo cp -a /etc/nginx/sites-enabled/vocotable \
  /root/nginx-backups/vocotable.pre-fullconf.$(date +%Y%m%d-%H%M%S)
sudo cp vocotable.conf /etc/nginx/sites-enabled/vocotable   # NOT sites-available
sudo nginx -t && sudo systemctl reload nginx
```

Verify **both** still answer:
```bash
curl -sf https://api.biteperk.com.au/health
curl -sf https://vocotable.algorythmos.com.au/health
```

Reload is graceful, but a request issued in the same instant can still fail —
re-test once before concluding anything is broken.

> **Do not diagnose TLS or port 80 from a sandboxed shell.** An intercepting
> egress proxy can rewrite the certificate chain, upgrade `http://` to
> `https://`, and return its own 503. During this migration it produced a
> fabricated `*.biteperk.com.au` certificate, a phantom 301 on the ACME path and
> a spurious 503 — three separate false readings. Verify from the VM itself, or
> with `curl -v`, which reports the true origin certificate.

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

## Record — Phases 1-3 completed 3 Aug 2026

- **Phase 1.** `api.biteperk.com.au A 136.113.35.88`, DNS-only, added to the
  `biteperk.com.au` zone. Confirmed on 1.1.1.1, 8.8.8.8 and 9.9.9.9 with no
  proxy addresses.
- **Phase 2.** Port-80 block rewritten per 2a; stale `sites-enabled/vocotable.bak`
  symlink removed, clearing both `conflicting server name` warnings. Certificate
  issued covering both names, expires 2026-11-01, auto-renew registered. Full
  `vocotable.conf` installed to `sites-enabled/vocotable`, verified byte-identical
  to the repo by sha256. Both hostnames serve HTTP/2 200.
- **Phase 3.** `PUBLIC_API_BASE_URL=https://api.biteperk.com.au` in
  `/opt/vocotable/.env`; `api` and `worker` force-recreated. Both containers
  report the new value, zero errors since boot, both hostnames still 200.
- Backups: `/root/nginx-backups/vocotable.pre-api.*`,
  `/root/nginx-backups/vocotable.pre-fullconf.*`,
  `/root/vocotable-backups/env.pre-domain.*`.

**Phase 4 has not started.** No vendor has been repointed; Stripe, Cal.com,
Retell and Twilio all still call `vocotable.algorythmos.com.au`, which serves
normally.
