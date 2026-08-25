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

1. **Stripe** — Workbench → the `vocotable-billing` destination → Edit
   destination → endpoint URL → `https://api.biteperk.com.au/stripe/webhook`.
   **Done 3 Aug 2026.** Confirm afterwards that the destination is still
   `Active`, still listening to the same 6 events, and that the signing secret
   was **not** rolled — rolling it would break `STRIPE_WEBHOOK_SECRET`.

   **There is no "send test event" in live mode** — synthetic triggers are a
   test-mode feature, and the `...` menu offers only Disable / Roll secret /
   Delete. So verification is indirect:

   ```bash
   # From the VM. 400 invalid_signature proves the route is reachable AND the
   # signature check is active (200 here would mean the check is off).
   curl -s -X POST https://api.biteperk.com.au/stripe/webhook \
     -H 'Content-Type: application/json' -d '{}'

   # Publicly resolvable, and the chain an external client will see.
   dig +short api.biteperk.com.au        # → 136.113.35.88
   echo | openssl s_client -connect 136.113.35.88:443 \
     -servername api.biteperk.com.au 2>&1 | grep 'Verify return code'
   ```

   End-to-end delivery is only proven by a **real** event — the next trial
   checkout. Check it under Event deliveries; expect a 200. A synthetic event
   would be safe to send if one were possible: `handleBillingWebhook` returns
   `"unattributed"` (200, no state change) when the customer matches no tenant.
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

> **Renamed 25 Aug 2026:** the dashboard's new hostname is
> **`voxtable.biteperk.com.au`** (product-named subdomains, NAMES.md §2/§5) —
> the earlier `app.biteperk.com.au` plan was superseded before any DNS, cert or
> traffic existed. **Do not create `app.biteperk.com.au`.** Two pre-flight
> facts that post-date the original text: `VITE_API_BASE_URL` is a
> **per-GitHub-Environment** variable (not a repo variable — no repo-level
> fallback exists by design), and the KDS is pipeline-deployed in both
> environments (`FIREBASE_ONLY=hosting:app,hosting:kds`).

1. **Firebase Hosting** (production Firebase project `vocotable`) → add custom
   domain `voxtable.biteperk.com.au` to the site behind target `app`, and
   `kds.biteperk.com.au` to the site behind target `kds`. Follow the TXT/A
   records Firebase issues; add them in the `biteperk.com.au` Cloudflare zone
   **DNS-only (gray cloud)**. Wait until the console shows **Connected** (cert
   issued) before any step below.
2. **Firebase Auth → Settings → Authorized domains**: add
   `voxtable.biteperk.com.au`. **Miss this and Google sign-in breaks on the new
   hostname.** Also add the OAuth web client entries (GCP → Credentials,
   console-only — no API exists): JS origin `https://voxtable.biteperk.com.au`
   and redirect URI `https://voxtable.biteperk.com.au/__/auth/handler`, or
   sign-in fails with `redirect_uri_mismatch` (exactly what happened on
   `vocotable.biteperk.com.au`, 25 Aug 2026).
3. **Production GitHub environment variables**: `VITE_API_BASE_URL` →
   `https://api.biteperk.com.au`, `VITE_KDS_URL` → `https://kds.biteperk.com.au`,
   and the manual legacy-site build's `VITE_FIREBASE_AUTH_DOMAIN` →
   `voxtable.biteperk.com.au` (first-party auth — see `resolveAuthDomain()` in
   `apps/frontend/src/lib/firebaseConfig.js`).
4. **`/opt/vocotable/.env`**: add `https://voxtable.biteperk.com.au` to
   `CORS_ALLOWED_ORIGINS` (**the VM list is the live one — Terraform's copy
   only feeds the future Cloud Run stack**), and set
   `STRIPE_CHECKOUT_SUCCESS_URL`, `STRIPE_CHECKOUT_CANCEL_URL`,
   `STRIPE_PORTAL_RETURN_URL` (and `PUBLIC_ORDER_RETURN_BASE_URL` if set) to
   `voxtable.biteperk.com.au` paths. Force-recreate api+worker.
5. **Google Maps key** → add `voxtable.biteperk.com.au/*` to the HTTP-referrer
   restrictions, or address autocomplete 403s on the new host.
6. Re-deploy both frontends so the bundles carry the new API base and auth
   domain (the legacy `vocotable` site deploys by hand; CI covers the
   `bp-voxtable-*` sites).
7. **Reserved product hosts** (NAMES.md §2): `voxorder.` / `voxconcierge.` /
   `voxstay.biteperk.com.au` are Cloudflare **proxied** records with 301
   redirect rules to their biteperk.com.au pages — verify each target returns
   200 before creating its rule.

Verify: sign in at `https://voxtable.biteperk.com.au`, load the dashboard and
the onboarding wizard, confirm the console shows no CORS or auth errors, and
confirm the legacy hostnames now redirect path-preserving.

## Phase 6 — Grace period

Keep the legacy hostnames serving for **at least 90 days** (301 redirect for the
dashboard; the API keeps answering on both `server_name`s). Only then consider
trimming the legacy entries from `app.ts` CORS and the nginx `server_name`.

`vocotable.web.app` already redirects to the branded dashboard hostname
preserving the path (a head-of-document client-side redirect in
`apps/frontend/index.html` — host-conditional server-side redirects are not
possible while all hostnames share one Firebase Hosting site), so Stripe
return URLs survive even before Phase 5 step 4. After the rename ships,
`vocotable.biteperk.com.au` joins the redirecting set and
`voxtable.biteperk.com.au` is the destination.

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

## Record — Phase 4 status, verified 25 Aug 2026

This section previously said "Phase 4 has not started. No vendor has been
repointed", which contradicted §Stripe's "Done 3 Aug 2026" above. Both were
resolved by reading each vendor's live config (read-only, from the VM so keys
never left it):

- **Stripe — DONE.** `GET /v1/webhook_endpoints` (live key): exactly one
  destination, `https://api.biteperk.com.au/stripe/webhook`, `enabled`,
  livemode, 6 enabled events. The "not started" line was the stale one.
  End-to-end delivery still gets proven by the next real event (no synthetic
  events in live mode — see above).
- **Retell — DONE** (during the 24 Aug Mazcina production work).
  `assert-line.mjs +61468202846` (25 Aug): `inbound_webhook_url` is
  `https://api.biteperk.com.au/retell/inbound`, and the golden-config check
  asserts every tool URL sits on the same host. Verified by real calls on the
  line since 20 Aug.
- **Cal.com — DONE 25 Aug 2026.** The single webhook (`657ef7dc-…`) was
  PATCHed from the VM: subscriber URL now
  `https://api.biteperk.com.au/cal/webhook`, read back with triggers
  (`BOOKING_CREATED/RESCHEDULED/CANCELLED`), `active: true` and the signing
  secret all unchanged. Pre-change snapshot on the VM at
  `/tmp/calcom-webhooks-pre-repoint.json`; rollback is pointing the URL back.
  Note discovered while verifying: **`/cal/webhook` returns 410 on BOTH
  hostnames** — production runs without `CALCOM_SYNC_ENABLED`, so the flag
  defaults false and the mirror is off. The repoint is correct and identical
  either side of it; whether production *should* run the mirror is a separate
  decision (the Mazcina venue has no `calcom_event_type_id` bound).
- **Twilio — MOOT for the live line, verified 25 Aug 2026.** The production
  number `+61 468 202 846` routes via the Elastic SIP trunk straight to
  Retell — no `/twilio/voice` TwiML webhook in the path — and it lives on the
  `Biteperk-production` account created 13 Aug, which never carried a legacy
  hostname anywhere. The `/twilio/voice`+`/twilio/status` step above belongs
  to the legacy pilot architecture on the Algorythmos account, whose numbers
  were listed via the API the same day: none reference either of our API
  hostnames (they point at `demo.twilio.com` / a Twilio handler). Nothing to
  cut over. Two residuals, both NUMBERS.md actions rather than Phase 4 work:
  the Disaster Recovery URL is still unset on both BitePerk numbers, and
  **the VM `.env`'s `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` are still the
  legacy Algorythmos account's** — swap them for Biteperk-production before
  any production SMS goes live.

**Phase 4 is complete.** All four vendors verified against their live config,
each on `api.biteperk.com.au` or confirmed to have no legacy-hostname
dependency. End-to-end proof continues to accrue from real traffic: Retell
via live calls since 20 Aug, Stripe on the next billing event, Cal.com on the
next web booking once the mirror is enabled.
