# Cutover day — VM → Cloud Run for api.biteperk.com.au

Ordered, copy-paste steps with a verification gate and an abort line after each. Written so
cutover day is execution, not research. Prereqs: PR #323 merged to `main`; platform #62
resolved (migrate job on an owner-role URL); a person on a phone.

**Who runs what:** `[agent]` = Claude with Sam's gcloud session · `[sam]` = Sam only
(DNS, phones, consoles) · `[abhi]` = Abhishek (Terraform applies).

**The honest sequencing caveat:** Retell and Twilio call `api.biteperk.com.au`, so live calls
exercise Cloud Run **only after the DNS flip** (step 7). Steps 1–6 prove the stack by direct
`.run.app` URL; step 7 is the moment of truth and has a 60-second revert.

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
Gate: dump >500KB, ~32 COPY blocks. Record row counts to reconcile in step 3:
```bash
gcloud compute ssh core-central-vm --zone us-central1-a --project vocotable-497209 \
  --command "sudo docker exec vocotable-postgres-1 psql -U vocotable -t -c \"SELECT 'restaurants',count(*) FROM restaurants UNION ALL SELECT 'reservations',count(*) FROM reservations UNION ALL SELECT 'menu_items',count(*) FROM menu_items UNION ALL SELECT 'call_logs',count(*) FROM call_logs\""
```
**From this moment the VM is read-only in spirit: no bookings should land between dump and
flip, so do steps 2–7 inside one quiet window (early morning).**

### 3. Restore into Cloud SQL + reconcile `[agent]`
Restore via the Cloud SQL proxy or an import bucket (whichever the prod root provisioned), into
the database the prod `DATABASE_URL` secret names — **check the secret first, do not assume**:
```bash
gcloud secrets versions access latest --secret voxtable-prod-database-url --project bp-voxtable-prod | sed -E 's#//([^:]+):[^@]+@#//\1:***@#'
```
Gate: the four row counts match step 2 exactly. Abort: drop and re-restore; nothing else has
happened yet.

### 4. Migrate from the NEW image `[agent]`
```bash
gcloud run jobs execute voxtable-prod-migrate --project bp-voxtable-prod --region australia-southeast1 --wait
```
Gate — both, as the app role:
```
SELECT max(filename) FROM schema_migrations;   -- expect 039_phone_number_single_owner.sql
SELECT count(*) FROM restaurants;              -- connects and reads as the runtime role
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
# AU1 trunk (Mazcina) — same, against TK6fcd3c96ea8317181d4049ce6f938f10 via the AU1 endpoint:
curl -s -X POST https://trunking.sydney.au1.twilio.com/v1/Trunks/TK6fcd3c96ea8317181d4049ce6f938f10 \
  -u "$TWILIO_AU1_KEY_SID:$TWILIO_AU1_KEY_SECRET" \
  --data-urlencode "DisasterRecoveryUrl=https://api.biteperk.com.au/twilio/disaster" \
  --data-urlencode "DisasterRecoveryMethod=POST"
```
Gate: read each trunk back and see the URL. Then update `deploy/voice-lines.json` in the same
change and run `npm run check:voice-lines`.

### 10. Post-cutover watch `[agent]`
48h: voice-line-health green on all three lines, zero unexplained 5xx in Cloud Run logs, daily
call-log review for a week. Then the full rehearsal battery
(`deploy/runbooks/cuban-corner-rehearsal-call-script.md`) gates go-live.
