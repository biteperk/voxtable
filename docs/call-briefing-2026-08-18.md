# Call briefing — Sam ↔ Abhishek, Mon 18 Aug 2026

Context: Abhishek's messages of 16–17 Aug — Stripe key + legal docs fixed on staging (PR #195),
onboarding a new restaurant now sticks at "provisioning in progress", and "what is the admin
dashboard and how is it deployed on staging".

> **Updated Sun 17 Aug, evening.** Since the morning version of this briefing, three PRs merged
> to `integration` and deployed to staging: [#201](https://github.com/biteperk/voxtable/pull/201)
> (legal-ledger hardening), [#202](https://github.com/biteperk/voxtable/pull/202) (platform admin
> API) and [#203](https://github.com/biteperk/voxtable/pull/203) (the `/admin` console). Staging
> serves image `api:6a429af…`, migrations ran, frontend deployed. §1 and §3 are updated to match.

## 1. The admin dashboard: it exists as of today

- When Abhishek asked, the honest answer was "there isn't one — admin is five curl-only API
  endpoints". **That changed today**: issue [#200](https://github.com/biteperk/voxtable/issues/200)
  is built and merged.
- **Backend** ([#202](https://github.com/biteperk/voxtable/pull/202)): cross-tenant admin API under
  `/api/admin/*` — venues list/detail (with terms-drift + billing presence), guarded unbind,
  provisioning queue + bind + go-live (pre-existing), stuck-jobs list + safe re-enqueue (issue
  #151 — **note: #151 was assigned to Abhishek; flag on the call that it's implemented**), ops
  health, support-request inbox, kill-switch flags readout, and an `admin_actions` audit table so
  every admin mutation records who did it. `GET /api/me` now returns `is_admin`.
- **Frontend** ([#203](https://github.com/biteperk/voxtable/pull/203)): `/admin` in the existing
  dashboard SPA (BitePerk-branded), sidebar link visible only to platform admins.
- Deployment: nothing separate — the API ships in the api image, the page ships with the normal
  dashboard deploy. Both are already on staging.
- Auth: Firebase ID token + the `DASHBOARD_ADMIN_EMAILS` allowlist. Empty allowlist fails closed
  with `503 ADMIN_ROLE_NOT_CONFIGURED` — which is staging's state until the Terraform apply in §2
  lands. That apply is the only thing between us and using the console.

## 2. Why onboarding sticks at "provisioning in progress" — by design, plus one missing env var

Two independent facts:

1. **Deliberate design (Phase 4a — admin-assisted).** Staging runs `PROVISIONING_AUTO_ENABLED=false`,
   so paying the trial invoice moves the tenant to `provisioning` and then *nothing* happens
   automatically: no `provisioning_jobs` row, worker is a no-op, and because staging runs
   `APP_ENV=production` posture the dev "Finish setup locally" button is hidden too. A human is
   supposed to bind a phone number + Retell agent through the admin API. The wizard's phone step
   polls `GET /api/onboarding/phone-setup` and stays put until **both**
   `restaurants.twilio_phone_number` **and** `restaurants.retell_agent_id` are set.
2. **The admin API was unusable on staging** because `DASHBOARD_ADMIN_EMAILS` was never set on
   `voxtable-stg-api` — every admin call 503s, so nobody could bind even deliberately.

### Fix in flight (platform repo)

- Platform PR [#23](https://github.com/biteperk/biteperk-cloud-platform/pull/23) (from 14 Aug,
  checks green) plumbs `DASHBOARD_ADMIN_EMAILS` through Terraform for stg + prod, empty default.
- The staging GitHub Environment variable is now set:
  `DASHBOARD_ADMIN_EMAILS=skalaliya@gmail.com,biteperk@gmail.com`.
- **Remaining (Sam, ~2 min): merge PR #23, then run the manual `terraform.yml` apply for
  voxtable/staging.** Verify afterwards: `GET /api/admin/funnel` with an allowlisted Firebase
  token returns 200, not 503.
- Open question for the call: should Abhishek's email go on the admin allowlist too? (Env change
  only — edit the GitHub Environment variable and re-apply.)

### How to finish a STAGING TEST tenant once the apply lands

Easiest path (from today): sign in on the staging dashboard as an allowlisted admin, open
**`/admin`** → Provisioning queue → **Bind…** (both fields) → **Go live**. The same steps via
the raw API:

```
# 1. Find the stuck restaurant
GET /api/admin/provisioning-queue          (Authorization: Bearer <Firebase ID token>)

# 2. Bind placeholders — BOTH fields, see gotcha below
PATCH /api/admin/restaurants/<id>/provisioning
{ "twilio_phone_number": "+61400000000", "retell_agent_id": "agent_staging_test_dummy" }

# 3. Go live (the self-serve path needs a real inbound call within 15 min, so for
#    test tenants use the admin override)
POST /api/admin/restaurants/<id>/go-live
```

- ⚠️ **Never bind the real staging number `+61 468 203 234` to a test tenant.** It resolves to the
  proven staging venue row; dialled-number → restaurant resolution must stay unambiguous
  (NUMBERS.md). Placeholder numbers are fine — they're never dialled.
- ⚠️ **Gotcha:** PATCHing only one of the two fields leaves the wizard silently stuck —
  `number_ready` needs both, and the PATCH keeps existing values for omitted fields
  (COALESCE), so a half-bind produces no error anywhere.
- Real venue onboarding (real number, real agent) follows
  `deploy/runbooks/venue-onboarding.md` instead — regulatory bundle, per-venue LLM, dress
  rehearsal, then go-live.

## 3. PR #195 (legal documents) — good pipeline, one serious gap to fix together

The publishing pipeline (versioned GCS bucket + immutable versions + manifest + workflow with
branch↔env enforcement) is the right shape, and it unblocked the agreement step on staging.
Four follow-ups are filed; the first one matters most:

- **[#196](https://github.com/biteperk/voxtable/issues/196) — the ledger records whatever the
  browser sends.** The backend writes client-supplied `document_set_version` + SHA-256 digests
  into the append-only `agreement_acceptances` ledger with shape-only validation. Before #195
  these were pinned server-side. Fix: backend fetches the same manifest and verifies before
  writing; mismatch → 409, manifest unreachable → 503 (fail closed). PR
  [#201](https://github.com/biteperk/voxtable/pull/201) implements this (closes #196/#197/#198)
  and **is merged + on staging as of 17 Aug** — walk Abhishek through the change on the call.
  Note: the verification only becomes active on staging once Terraform sets
  `LEGAL_DOCUMENTS_MANIFEST_URL` + `TERMS_ALLOW_UNPUBLISHED_DOCS=true` there (follow-up to
  platform #23).
- [#197](https://github.com/biteperk/voxtable/issues/197) — `csa_url`/`schedule_url` are
  validated then discarded; add columns + store them.
- [#198](https://github.com/biteperk/voxtable/issues/198) — the DRAFT/production guards were
  removed with nothing replacing them; only `SAMPLE-2026-08` exists, and production could record
  acceptances against it. Fix restores a guard behind a staging-only flag. (Also: dead DRAFT
  banner in `AgreementStep.jsx`, stale runbook text.)
- [#199](https://github.com/biteperk/voxtable/issues/199) — publish workflow and frontend derive
  the bucket name from two different variables (`VOXTABLE_PROJECT_ID` vs
  `VITE_FIREBASE_PROJECT_ID`); if they diverge the agreement step hard-fails.
- Commented on [#188](https://github.com/biteperk/voxtable/issues/188): stays open until #196/#197
  land — recorded-but-unverifiable isn't the evidence it asks for.

Note: the Stripe fixes Abhishek mentioned aren't in #195 — they were the earlier commits already
on both branches (payment-link rejection fix, Connect accounts API fix).

## 4. Suggested agenda

1. Merge + apply platform PR #23 live on the call, then fix Abhishek's stuck tenant **through the
   new `/admin` console** (§2) — it doubles as the admin-dashboard demo.
2. Admin dashboard (§1) — tour of what shipped (#202/#203), including that #151 (his issue) is
   implemented in it; agree any follow-ups.
3. PR #195 feedback (§3) — walk the merged hardening PR #201 and the two staging env vars it
   still needs.
4. Who produces the real `CSA-2026-08` document text (#164) — the pipeline is ready for it; the
   text is a Sam/legal task, not code.
5. Abhishek on the admin allowlist: yes/no.
6. Demo scope for the wider demo he proposed.
