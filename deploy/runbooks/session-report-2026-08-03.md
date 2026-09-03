# Ops session report — 3 August 2026

> Historical report. The `core-central-vm` environment described below is classified as sandbox,
> not production. It is not a production traffic, credential, backup, rollback or migration source.
> Any production test, rehearsal, dummy-data or seed instruction below is superseded. Testing runs
> only in staging; production verification is non-mutating.

Domain migration Phases 1–3, Stripe rebrand, and the Week-2 gate.
Two GCP accounts, four vendor surfaces, five repo documents.

---

## Summary

| Track | Outcome |
|---|---|
| Domain migration Phases 1–3 | **Live.** `api.biteperk.com.au` serving, legacy hostname unaffected throughout |
| Stripe | Destination rebranded; endpoint verified functional on the new host |
| Week-2 item 1 — staging project | **Done.** Cloud SQL live, APIs on, Artifact Registry granted |
| Week-2 item 2 — `.env` durability | **Done, hash-verified.** Single point of failure closed |
| Week-2 item 3 — backups | **Premise was wrong.** Chain already healthy; documented instead |
| Week-2 item 4 — vendor hardening | Runbook written — execution is Sam's |
| Week-2 item 5 — legal pack | Volumes measured, brief and outreach email drafted |

No production outage at any point. Every change was taken with a backup and an
auto-rollback path.

---

## 1. GCP — `skalaliya@gmail.com` (project `vocotable-497209`, no organisation)

This is where production actually runs. Billing account `Main-Billing`
(`01EB99-B62F0E-268080`), **not** under any organisation.

### Changed

| Change | Detail | Rollback |
|---|---|---|
| nginx port-80 block rewritten | Added `api.biteperk.com.au` to `server_name`; added ACME location; converted server-level `return 404` into `location / { return 404; }` | `/root/nginx-backups/vocotable.pre-api.20260803-020807` |
| Stale symlink removed | `sites-enabled/vocotable.bak` → cleared both `conflicting server name` warnings | recreate symlink |
| TLS certificate issued | Lineage `api.biteperk.com.au`, covers `api.biteperk.com.au` + `vocotable.algorythmos.com.au`, expires **2026-11-01**, auto-renew registered. Dry-run passed first | old lineage `vocotable.algorythmos.com.au` still renewing |
| Full nginx conf installed | To `/etc/nginx/sites-enabled/vocotable` (sha256 `1a8c5dab…`), matching repo byte-for-byte | `/root/nginx-backups/vocotable.pre-fullconf.20260803-021556` |
| Backend env | `PUBLIC_API_BASE_URL` → `https://api.biteperk.com.au`; `api` + `worker` force-recreated | `/root/vocotable-backups/env.pre-domain.20260803-022045` |
| Secret Manager API | Enabled | — |

### Verified

- Both hostnames return **HTTP/2 200** on `/health` from the public internet.
- Port 80 → 301 to HTTPS for both hosts.
- Certificate presented is `CN=api.biteperk.com.au`, Let's Encrypt.
- Rate limiter sane: 25 rapid hits to `/api/reservations` → all 401 (auth), zero 503.
- Containers healthy, **zero errors** since boot; both report the new base URL.

### Learned (not changed)

- **VM OAuth scopes are `devstorage.read_only`** plus logging/monitoring/trace only. The
  VM cannot write to GCS or Secret Manager regardless of IAM. Changing this needs a
  stop/start.
- Live config is the **regular file** `sites-enabled/vocotable`, not a symlink into
  `sites-available/`. The repo's own install header was wrong about this.

---

## 2. GCP — `biteperk@gmail.com` (organisation `biteperk-org`, id `581699153029`)

Billing account `Biteperk-Main` (`01A790-3BE130-F3F172`).

### Estate as it now stands

| Project | Status |
|---|---|
| `bp-voxtable-stg` | Pre-existing (created 4 days ago) |
| `bp-shared-artifacts` | Pre-existing — holds the container images |
| **`bp-voxtable-prod`** | **Created this session** |
| `vocotable-497209`, `vocotable` | Outside the org — production and Firebase |

### Changed

| Project | Change |
|---|---|
| `bp-voxtable-prod` | Project created under `biteperk-org` / `Biteperk-Main`; Secret Manager API enabled; `skalaliya@gmail.com` granted `roles/secretmanager.admin`; secret **`voxtable-prod-env`** created (v1) and labelled `source=core-central-vm,captured=20260803` |
| `bp-voxtable-stg` | Compute Engine API enabled; **Cloud SQL `voxtable-stg`** created |
| `bp-shared-artifacts` | `service-198624206590@serverless-robot-prod.iam.gserviceaccount.com` granted `roles/artifactregistry.reader` |

### Cloud SQL `voxtable-stg`

PostgreSQL **16.14** · Enterprise · `australia-southeast1` (Sydney) · `db-g1-small`
(1 vCPU / 1.7 GB) · 10 GB SSD autoscaling · single zone · automated backups + PITR ·
deletion prevention on · SSL-only.

**~US$0.05/hour ≈ US$37/month.** The console's default config was US$0.19/hour
(~US$139/mo) — Enterprise Plus, 8 vCPU, 250 GB, multi-zone, us-central1, Postgres 18.
The saving came mostly from the machine *family*: the "Sandbox" preset still provisions a
dedicated 2-core box; switching to *General purpose – Shared core* is what made it cheap.

Connection name: `bp-voxtable-stg:australia-southeast1:voxtable-stg`

### Not verified

The Artifact Registry binding was **in place, not proven** at the time. Under the current
policy, prove cross-project pulls on staging. A production deployment receives only
non-mutating revision/readiness verification.

---

## 3. `.env` → Secret Manager

The item flagged as "it exists nowhere else, and losing that VM means losing production's
config."

Done via Cloud Shell, piped VM → Secret Manager, so **no value was written to disk,
printed, or seen by anyone**:

```
gcloud compute ssh core-central-vm --command="sudo cat /opt/vocotable/.env" \
| gcloud secrets create voxtable-prod-env --project=bp-voxtable-prod --data-file=-
```

Verified by hash only — both sides returned:

```
b4dd93e19a932b49cfc95425779092df915e0d00cc006602b3b08b7f152ec048
```

**Caveat:** this is a point-in-time copy. Rotate a key or change a vendor URL in
`/opt/vocotable/.env` and the secret goes stale silently. Re-run with `versions add`.

---

## 4. Stripe

Account `acct_1TyrziLxTLo7m41V`. Destination `we_1Tyu2hLxTLo7m41VfCfsCu98`.

| Field | Before | After |
|---|---|---|
| Name | `vocotable-billing` | **`biteperk-billing`** |
| Description | "VoxTable billing webhook … the vocotable backend …" | "Biteperk billing webhook … the Biteperk backend …" |

Unchanged: destination ID, endpoint URL, API version `2026-06-24.dahlia`, all six events,
status Active. **Because the destination ID didn't change, the signing secret is
unchanged** — `STRIPE_WEBHOOK_SECRET` is still valid and no redeploy was needed.

Endpoint smoke-tested from outside:

```
POST /stripe/webhook      → 400 {"error":"invalid_signature"}
POST /stripe/nonexistent  → 404
```

Correct pair: route live, signature verification active, no catch-all. Formal Phase-4
verification (a signed test event producing a 200 and a delivery row) is still outstanding
— deliveries remain at zero.

---

## 5. Cloudflare

Zone `biteperk.com.au`, one record added:

```
api.biteperk.com.au   A   136.113.35.88   DNS only (gray cloud)   TTL Auto
```

Verified on **three independent resolvers** (1.1.1.1, 8.8.8.8, 9.9.9.9): all return
`136.113.35.88`, none return a Cloudflare proxy address. Zone went 16 → 17 records;
nothing existing was touched.

---

## 6. Findings

### The backup chain — item 3's premise was wrong

`gs://vocotable-backups-497209/` is **healthy**: australia-southeast1 (Sydney), 31 daily
objects, newest `db-20260803-062501.sql.gz`, schema verified identical to the live
database. Roughly 30-day rolling retention.

What was actually broken was the **documentation**: `backup-restore.md` restored from
`gs://vocotable-backups/`, which does not exist. Every command in it failed. Now fixed.

The writer is `vocotable-backups@vocotable-497209.iam.gserviceaccount.com`, holding a
**user-managed key created 2026-05-25**, from a machine outside GCP — not the VM, which
can't write to GCS at all. Audit logs show the key and the bucket were both created by
**Skalaliya@gmail.com** on 25 May from a residential IPv6, so it is Sam's own setup that
was simply never written down.

Still worth doing: the key holds `objectAdmin`, meaning it can **delete** every backup.
`objectCreator` is sufficient to write new ones.

### A second data location the legal inventory was missing

The Track L inventory listed Postgres but not backups. Those nightly dumps contain full
transcripts and caller phone numbers. So "delete the corpus" is not one action — it is
Retell, plus Postgres, plus up to 30 days of rolling backups, offsite and on-VM. Added as
§1a and referenced from question 2.

### Track L volumes

| Measure | Value |
|---|---|
| Total calls | 41 |
| With transcript | 22 |
| With recording | 22 |
| Earliest call | 2026-05-25 |

The affected corpus is **22 recorded calls** over ten weeks — small enough that deletion
remains practical whatever counsel advises. Worth saying in the meeting, because it widens
the range of advice that's actionable.

### Three of my own calls were wrong

All three were caught by checking rather than reasoning, which is the transferable lesson
on this estate — documentation and reality have drifted enough that verifying is
consistently cheaper than inferring.

1. **"Backups are broken."** They weren't — only the runbook was.
2. **"Stripe still points at the legacy host."** It was already migrated.
3. **"The Terraform deployer has downloadable keys."** `--managed-by=user` returned zero;
   both keys are Google-managed and it uses Workload Identity Federation.

Separately, the cloud sandbox's TLS-intercepting egress proxy produced **three false
readings** — a fabricated `*.biteperk.com.au` certificate, a phantom 301 on the ACME path,
and a spurious 503. Diagnose TLS and port 80 from the VM, or with `curl -v`, never from a
sandboxed shell.

---

## 7. Repository

Three unpushed branches, all off `integration`:

| Branch | Contents |
|---|---|
| `chore/domain-migration-prep` | The original prep commit (`5e43b6d`) — still unmerged |
| `fix/nginx-conf-corrections` | nginx conf defects + Stripe cutover record — **builds on the prep branch** |
| `docs/week2-ops` | Backup truth, vendor hardening runbook, Week-2 scripts, Track L brief |

**Dependency to remember:** `fix/nginx-conf-corrections` sits on top of
`chore/domain-migration-prep`, so it merges after it or carries it along.

Documents produced: `backup-restore.md` (corrected), `vendor-hardening.md`,
`week2-scripts.sh`, `recording-data-inventory.md` (§4 filled, §1a added),
`legal-brief-call-recording.md`, plus corrections to `vocotable.conf` and
`domain-migration.md`.

Four nginx conf defects fixed and committed but **not yet deployed** — the VM still runs
the pre-fix config (`1a8c5dab`), the branch has `6ecff193`.

---

## 8. Outstanding, in priority order

1. **Twilio authenticator 2FA.** Still SMS-only, on the account that owns the phone line.
   A SIM-swap path into your telephony. Ten minutes, highest value.
2. **The backup key.** Downgrade `objectAdmin` → `objectCreator`; identify which machine
   runs the 06:25 job; enable bucket versioning.
3. **Retell's `algorythmos.com.au` login.** The last production dependency on the retired
   agency domain — and unlike the API hostname, it can't be fixed with a DNS record.
4. **Deploy the corrected nginx conf**, closing the repo-vs-VM drift that caused today's
   surprises.
5. **Historical Phase 4 note for Cal.com, Retell, Twilio.** Current policy tests
   signatures and calls in staging only; production uses configuration read-back
   and monitoring of genuine traffic.
6. **`GCP_VM_NAME` / `GCP_VM_ZONE`** are unset in the `production` GitHub environment. The
   first promotion of `integration` to `main` will fail its deploy.
7. **Knowledge Catalog** is auto-enabled on the new Cloud SQL instance, sending metadata to
   a Google discovery service. Worth an explicit decision given Track L.

---

## Reference

| | |
|---|---|
| Sandbox VM (historically mislabelled production) | `core-central-vm`, `us-central1-a`, `vocotable-497209`, `136.113.35.88` |
| Staging DB | `bp-voxtable-stg:australia-southeast1:voxtable-stg` |
| Prod secret | `voxtable-prod-env` in `bp-voxtable-prod` |
| Backups | `gs://vocotable-backups-497209/` (Sydney), daily 06:25 UTC |
| Backup SA | `vocotable-backups@vocotable-497209.iam.gserviceaccount.com`, key `67dfba83…` (2026-05-25) |
| Stripe destination | `we_1Tyu2hLxTLo7m41VfCfsCu98` → `https://api.biteperk.com.au/stripe/webhook` |
| Cert expiry | 2026-11-01, auto-renew registered |
| Staging project number | `198624206590` |
