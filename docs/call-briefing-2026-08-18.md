# Call briefing — Sam ↔ Abhishek, Mon 18 Aug 2026

> Historical meeting record. References to a "production VM" describe an abandoned assumption.
> `core-central-vm` is sandbox-only; current production is Cloud Run/Cloud SQL and receives no VM data.
> Any production test, rehearsal, dummy-data or seed instruction below is also superseded:
> all testing runs in staging, and production verification is non-mutating only.

Context: Abhishek's messages of 16–17 Aug — Stripe key + legal docs fixed on staging (PR #195),
onboarding a new restaurant now sticks at "provisioning in progress", and "what is the admin
dashboard and how is it deployed on staging".

> **Updated Sun 17 Aug, evening.** Since the morning version of this briefing, three PRs merged
> to `integration` and deployed to staging: [#201](https://github.com/biteperk/voxtable/pull/201)
> (legal-ledger hardening), [#202](https://github.com/biteperk/voxtable/pull/202) (platform admin
> API) and [#203](https://github.com/biteperk/voxtable/pull/203) (the `/admin` console). Staging
> serves image `api:6a429af…`, migrations ran, frontend deployed. §1 and §3 are updated to match.

> **Updated Mon 18 Aug, midday.** The §2 blocker is **gone** — platform PR #23 merged and the
> staging Terraform apply ran on 17 Aug, both verified against the running service. Five more PRs
> merged this morning (#211, #212, #213, #214, #182); staging now serves `api:c61740b…`. §1, §2
> and §3 updated; two new items in §4.

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
  with `503 ADMIN_ROLE_NOT_CONFIGURED`. That **was** staging's state; the §2 apply has since run,
  the allowlist is populated, and the console is usable on staging today.

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

### Fix — DONE, verified 18 Aug

This section previously read "Remaining (Sam, ~2 min): merge PR #23, then run the apply."
Both happened on 17 Aug and the console is usable on staging now. Nothing is outstanding here.

- Platform PR [#23](https://github.com/biteperk/biteperk-cloud-platform/pull/23) — **merged**.
- The manual `terraform.yml` apply — **`Deploy voxtable stg apply` succeeded, 17 Aug 17:31**.
- Read back off the running `voxtable-stg-api` service (not from the Terraform plan):

  | Variable | Value on staging |
  |---|---|
  | `DASHBOARD_ADMIN_EMAILS` | `skalaliya@gmail.com,biteperk@gmail.com` |
  | `LEGAL_DOCUMENTS_MANIFEST_URL` | set (the stg legal-documents bucket manifest) |
  | `TERMS_ALLOW_UNPUBLISHED_DOCS` | `true` |

- Behavioural check: `/api/admin/funnel`, `/venues`, `/ops-health` and `/provisioning-queue`
  all return **`401 MISSING_BEARER_TOKEN`** unauthenticated — i.e. the routes are live and the
  admin gate is configured. A `503 ADMIN_ROLE_NOT_CONFIGURED` would have meant the allowlist
  was still empty; we no longer get one.
- Staging is serving `api:c61740b…` and `worker:c61740b…` — the current `integration` tip.

**Abhishek on the allowlist — DECIDED AND DONE, 18 Aug.** He was on *neither* list; he is
now on both, as `sales@biteperk.com`. The variables live in the **platform** repo
(`biteperk/biteperk-cloud-platform`, `staging` environment) — not in `biteperk/voxtable`,
which is where the previous wording implied — and are read by `terraform.yml` as
`vars.DASHBOARD_ADMIN_EMAILS` / `vars.DASHBOARD_ALLOWED_EMAILS`. Both were edited and the
`voxtable stg apply` re-run; read back off the running `voxtable-stg-api`:

  | Variable | Value on staging |
  |---|---|
  | `DASHBOARD_ADMIN_EMAILS` | `skalaliya@gmail.com,biteperk@gmail.com,sales@biteperk.com` |
  | `DASHBOARD_ALLOWED_EMAILS` | `biteperk@gmail.com,skalaliya@gmail.com,sales@biteperk.com` |

He was added to `DASHBOARD_ALLOWED_EMAILS` as well as the admin list even though staging runs
`SELF_SERVE_SIGNUP_ENABLED=true` (which stops that list gating sign-in): if that flag ever
flips off, an admin-only entry would lock him out with a confusing `403`.

⚠️ **The grant is only real if he signs in with a Google identity for that exact address.**
Sign-in is Google-only (`signInWithPopup`), the match is exact-string, and `biteperk.com`
resolves to Microsoft 365 mail — so the mailbox existing is not the same as a Google account
existing. If `/admin` still refuses him, that is the reason, not the deploy.

⚠️ **Historical status only.** The current production environment is `bp-voxtable-prod` on
Cloud Run/Cloud SQL; the VM discussed in this dated briefing is sandbox-only.

### How to finish a STAGING TEST tenant (the apply has landed — this works now)

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
  Update 18 Aug: both `LEGAL_DOCUMENTS_MANIFEST_URL` and `TERMS_ALLOW_UNPUBLISHED_DOCS=true`
  **are now set on `voxtable-stg-api`**, so the verification is live on staging — an acceptance
  there is now checked against the published manifest rather than trusted from the browser.
  ⚠️ Caveat worth raising: the production gate only demands that variable when
  `SELF_SERVE_SIGNUP_ENABLED=true` (default `false`), so an **invite-only production would boot
  without it and fall back to recording browser-supplied hashes** with only a log warning. A fix
  is in flight to require it in production unconditionally.
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

1. Fix Abhishek's stuck tenant **live, through the new `/admin` console** (§2) — the apply has
   landed, so this works now and doubles as the admin-dashboard demo.
2. Admin dashboard (§1) — tour of what shipped (#202/#203), including that #151 (his issue) is
   implemented in it; agree any follow-ups.
3. PR #195 feedback (§3) — walk the merged hardening PR #201, note the verification is now live
   on staging, and agree the invite-only-production gap is worth closing before real onboarding.
4. Who produces the real `CSA-2026-08` document text (#164) — the pipeline is ready for it; the
   text is a Sam/legal task, not code.
5. ~~Abhishek on the admin allowlist: yes/no.~~ **Done 18 Aug** — added as
   `sales@biteperk.com` to both staging lists; see §2 for the Google-identity caveat.
6. Demo scope for the wider demo he proposed.
7. **Staging SMS is not switchable yet.** `NOTIFICATIONS_ENABLED` and `NOTIFICATIONS_SMS_FROM`
   are unset on the staging *worker*, so leg 6 of `deploy/runbooks/staging-call-battery.md`
   (insert an outbox row, expect an SMS) will leave the row pending. That is issue #185 — a
   Terraform change, not a bug. Decide whether it goes in before the phone battery is run.
8. **Backlog hygiene.** #196, #197 and #198 were fixed by the merged PR #201, and #200 was
   delivered by #203, but all four are still open — no recent PR used closing keywords. Worth
   agreeing who closes them so the board reflects reality.
