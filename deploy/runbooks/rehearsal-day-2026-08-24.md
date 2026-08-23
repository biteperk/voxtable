# Rehearsal day — Mazcina, 24 Aug 2026

The venue's staff call `+61 468 202 846` and use the dashboard. **The number is not
publicised** — NUMBERS.md's "do NOT publicise" stands until §E of the launch plan closes the
7.6 s drop. This file is the operator sequence; every step names where it came from.

Environment for everything below: **production** — VM `core-central-vm`, Retell workspace
**Biteperk** (key only from the VM's `/opt/vocotable/.env`), Twilio `Biteperk-production`.

## What is already true (done 23 Aug)

| | Proof |
|---|---|
| Bella knows the time and the venue's hours | #240, verified by a real call 20 Aug |
| Bella's greeting discloses AI + recording | `deploy/retell-snapshots/20260823-prod-mazcina-disclosure-post/` — read-back matched; `assert-line.mjs` layer 14 green |
| Floor view is honest during service (multi-sitting orders, venue-clock "Now", per-booking seat/done, modal date, clicked-table honesty, 30 s refresh) | #243, in `integration`; staging deploy of `7a296d6` |
| Production line health runs off-laptop and is green | `voice-line-health.yml` run `32631947070`, Production job ✓ (layer 15 skipped — no AU1 key yet) |
| Fork-PR deploy hole closed; greeting assertion cannot regress | #244 |

## Morning: put production on current code (≈45 min, do in this order)

Why the order: migrations ship inside the image, the VM does **not** migrate on restart, and
the api refuses to boot without the legal-manifest variable. Sequence recorded in
`deploy/retell-snapshots/20260819-prod-mazcina-post/README.md` §"Open follow-ups".

1. **Merge #247** (release 0.2.0) into `integration`. Without it `main` rebuilds `api:0.1.1`
   in place and there is no distinct image to roll back to.
2. **Promote**: open a PR `integration` → `main`, merge. Wait for CI on `main` to push
   `api:0.2.0` / `worker:0.2.0` (the "Push semantic version images from main" step).
   `deploy-backend.yml` on `main` will run against Cloud Run prod and **fail at startup until
   step 3 is mirrored into Terraform** — expected; it is not the VM.
3. **VM env** — add one line to `/opt/vocotable/.env` (keep the file `0644`):
   ```
   LEGAL_DOCUMENTS_MANIFEST_URL=https://storage.googleapis.com/bp-voxtable-prod-legal-documents/current/manifest.json
   ```
   The manifest does not need to exist for boot (`services/legalDocuments.ts:68` reads it at
   agreement time only). Do **not** publish `SAMPLE-2026-08` to production and do **not** set
   `TERMS_ALLOW_UNPUBLISHED_DOCS` there — the agreement step 503s cleanly until #164 publishes
   the real CSA, and Mazcina is hand-onboarded so the rehearsal never reaches it.
4. **Copy the compose file** (`docker-compose.deploy.yml` now pins `0.2.0`):
   ```bash
   gcloud compute scp docker-compose.deploy.yml core-central-vm:/tmp/ --zone us-central1-a --project vocotable-497209
   ```
   then on the VM `sudo install -m 0644 /tmp/docker-compose.deploy.yml /opt/vocotable/`.
5. **Backup first** — `deploy/runbooks/backup-restore.md` (pg_dump off-VM). Migrations
   025–035 add an exclusion constraint and a unique index; if either fails on existing data
   the job aborts and nothing is changed, but have the dump anyway.
6. **Pull → migrate from the NEW image → verify → start**, on the VM in `/opt/vocotable`:
   ```bash
   C="sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.deploy.yml"
   $C pull api worker
   $C run --rm api node apps/backend/dist/db/migrate.js      # NOT `exec` — exec hits the OLD container
   sudo docker compose exec postgres psql -U vocotable -Atc "select filename from schema_migrations order by filename desc limit 12"
   ```
   Expect `035_…` at the top and 025–034 present. Then:
   ```bash
   $C up -d api worker
   for i in $(seq 1 10); do sudo docker inspect vocotable-api-1 --format '{{.State.Health.Status}}'; sleep 3; done
   ```
   If the api is not `healthy`: `sudo docker compose logs api | grep -i refusing` — a boot-gate
   message names the missing variable. Rollback: `deploy/runbooks/rollback.md` failure mode 1
   (re-pin `0.1.1` in the compose file, `up -d`). Migrations are additive; the old image runs
   against the new schema.
7. **Prove the line, not the deploy**: from the laptop
   ```bash
   npm run check:voice-lines
   ```
   Layers 1–14 green. Layer 5 should now show `today_status` and `venue_faq` among served
   variables (the new backend serves them).
8. **Trim the agent** — now the backend serves `today_status`/`venue_faq`, delete the
   temporary "This venue's details" section from the Mazcina prompt: snapshot → PATCH →
   read-back → `assert-agent.mjs` (it accepts either form) → snapshot. One lever; do it
   *after* step 7 is green, not before.
9. **Frontend**: the `main` CI deploys the dashboard to Firebase Hosting (`app`). The **KDS is
   deployed by no pipeline**: `npm run build:kds && firebase deploy --only hosting:kds`.
10. Mirror `LEGAL_DOCUMENTS_MANIFEST_URL` into `biteperk-cloud-platform`
    `roots/products/voxtable/prod` so the Cloud Run prod target stops dying at boot (not
    needed for today; it is what makes the `main` deploy go green).

## Before the first call

- **OpenTable**: Mazcina is live on OpenTable. Settle with the owner which of the three
  outcomes in `venue-onboarding.md` §"Double booking" applies — other system off for the
  rehearsal, split inventory, or risk accepted **in writing**. Not after.
- **Twilio console** (`Biteperk-production` — check the account picker): arm **auto-recharge
  + low-balance alert** (NUMBERS.md §8 item 1; a zero balance is how the pilot line died and
  it looks like a code bug); set a **Disaster Recovery URL** on the number (a TwiML `<Say>`:
  "Sorry, we can't take calls right now — please call back shortly") so a Retell outage is a
  message, not dead air; create the **AU1 API key** and store it as
  `voxtable-prod-twilio-au1-key-{sid,secret}` so layer 15 becomes checkable. Leave Secure
  Trunking **off** today — changing media config with the drop incident open confounds it.
- Have the dashboard open on Live Tables for today, and the KDS on a tablet.

## The battery (the go/no-go gate)

Run the ten legs of `deploy/runbooks/staging-call-battery.md` **against the production line**
with a staff member dialling. Record each in that file's results table — it has never had a
row. Specific to today:

- Leg 1: you must **hear** "an AI assistant" and "this call's recorded". If not, stop — the
  23 Aug PATCH is the only thing that put it there and a dashboard publish can erase it.
- Leg 2: the ticket must reach the KDS **and** the order must appear on the table's page in
  Live Tables within 30 s (the #243 per-table fetch).
- Leg 4 remains blocked (no licensed items imported) — record "blocked", not "pass".
- Leg 6 (SMS) is not part of today: production has never sent an SMS and the sender isn't
  wired (NUMBERS.md §8 items 8–9).
- Any call that ends at ~7.6 s with `user_hangup` is the open trunk incident — log the
  call id in `incident-7600ms-call-drops.md` and redial. Expect roughly one in three.

Go/no-go: legs 1, 2, 3, 5, 7, 8, 9, 10 pass → `POST /api/admin/restaurants/44444444-4444-4444-8444-444444444444/go-live`
(platform admin, audited). Anything else → the venue keeps forwarding to its current line.

## After

- Fill the results table; tick NUMBERS.md §8 items 1, 3 (DR URL half), 5a as done.
- The public go-live list is §E of the launch plan: the TLS→TCP trunk experiment and Twilio
  ticket, recording exposure (#173), Secure Trunking, hostname move, sender ID + first SMS,
  publish the agent. None of those are tonight's work; all of them are before the number is
  printed anywhere.
