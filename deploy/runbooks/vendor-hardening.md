# Vendor account hardening — Track V

Ordered by blast radius, not by convenience. Each step is yours to perform:
enrolling authenticator 2FA, entering auth codes and inviting admins are
credential actions, so they cannot be automated or delegated.

Estimated total: 45–60 minutes.

---

## Why this order

Every incident this project has had so far has the same shape: **something
production depends on lives under an identity the company does not control.**
The API answered on the retired agency's domain. The Retell login is an
`algorythmos.com.au` mailbox. Production GCP bills to a personal account with no
organisation. A 70-day-old JSON key on an unidentified machine dumps the
production database nightly.

So harden in the order of *what breaks the business if it is lost*, not the
order things appear in a list.

---

## 1. Twilio — ✅ authenticator enrolled 3 Aug 2026

Twilio owns the phone line. If it is lost, every inbound booking call stops and
no amount of code fixes it.

**Status:** authenticator app enrolled and set as the **default 2FA method**
(3 Aug 2026). Phone verification on the mobile ending 1140 remains present and
`Verified` — Twilio offers no delete on that card, only *Reset*, so a phone factor
appears to be mandatory for account recovery.

Settings live at `console.twilio.com/user/user-settings/security` — note this is
**User Settings**, not Account settings. Searching the console for "two-factor"
returns documentation, not the page.

### Still open on Twilio

- [ ] **Forget all remembered browsers.** On the same page. Remembered browsers
      bypass 2FA entirely, so any pre-existing session still gets in without a
      code — enrolling TOTP does not retroactively apply to them. This is the step
      that most often leaves the work half-done.
- [ ] **Confirm whether SMS can still be *chosen* at the login prompt.** Sign out,
      sign back in, and see whether a "try another way" option appears. If it does,
      the SIM-swap path is de-prioritised rather than closed, and that is worth
      knowing precisely rather than assuming either way.
- [ ] **Store the TOTP setup key** (the string, not just the scanned QR) in the
      vault alongside the password.

1. Console → avatar (top right) → **Account settings → Security**.
2. Under two-factor authentication, choose **Authenticator app**.
3. Scan the QR with your authenticator. **Also save the TOTP setup key itself**
   into the password vault — that is what lets you enrol a second device later
   without resetting 2FA entirely.
4. Confirm the six-digit code.
5. Only once the authenticator works, **remove SMS as a factor** if Twilio lets
   you. Leaving it enabled leaves the SIM-swap path open.
6. Download recovery codes → password vault, not email.

**Verify:** sign out fully, sign back in, confirm it prompts for the
authenticator and not SMS.

---

## 2. Retell — the one with a structural problem

**Current state:** login `retellai@algorythmos.com.au` (Auth0, email + MFA or
"Continue with Google"), org `org_f0DPXgKIQTMJL4je`, Pay As You Go. MFA codes
and "action required" notices are delivered to `skalaliya@gmail.com`.

The login identity is a mailbox on the **retired agency domain**. If that Google
Workspace lapses, is reclaimed, or the relationship ends, you lose the ability
to authenticate to the service that answers your customers' phone calls. This is
the same failure mode as the API hostname — and unlike the hostname, you cannot
fix it with a DNS record.

1. Confirm in the Retell console who the org owner actually is — do not infer it
   from which inbox the mail lands in.
2. Add a **second owner** on a `biteperk.com.au` address.
3. Enrol authenticator MFA on that new owner.
4. Only then decide whether to retire the `algorythmos.com.au` login. Do not
   remove it until the new owner is proven to work — losing both leaves nobody.
5. While you are in there, Track L needs the agent's data-storage / retention
   setting and whether recordings are downloadable and deletable via their API.

**Verify:** sign in as the new `biteperk.com.au` owner in a private window and
confirm you can edit agent `agent_7b7a5f6c21c9968ee88afd3bac`.

---

## 3. Google Cloud — the backup key

Before touching vendor logins further, deal with the finding from today.

- `vocotable-backups@vocotable-497209.iam.gserviceaccount.com` holds a
  user-managed key created **2026-05-25**, never rotated.
- **Provenance resolved 3 Aug 2026.** Admin Activity logs show the bucket, its IAM
  bindings and the key were all created by `Skalaliya@gmail.com` on 25 May from a
  residential IPv6 address. This is Sam's own setup that was never documented —
  not an agency artefact and not a third party. The risk is reduced accordingly,
  but the key is still a downloadable credential on a machine outside GCP.
- It has **Storage Object Admin** on `gs://vocotable-backups-497209` — meaning
  the key holder can delete every backup you have, not just add new ones.
- It is not on `core-central-vm`; that VM has `devstorage.read_only` scope and
  cannot write to GCS at all.

1. Identify the machine holding the key (see the logging query in
   `week2-scripts.sh`). **Do not delete the key first** — it is your only
   offsite backup path.
2. Once identified: downgrade the binding from `storage.objectAdmin` to
   `storage.objectCreator`.
3. Rotate the key and record where the new one lives.
4. Add bucket **retention policy / object versioning** so a compromised key
   cannot erase history.

---

### Checked and clear — no action needed

`github-terraform-deployer@bp-shared-artifacts` holds Artifact Registry Admin,
Cloud Run Admin, Cloud SQL Admin, Firebase Admin and Workload Identity Pool Admin,
which looks alarming at a glance. It was checked on 3 Aug 2026:

```
gcloud iam service-accounts keys list --managed-by=user \
  --iam-account=github-terraform-deployer@bp-shared-artifacts.iam.gserviceaccount.com
→ Listed 0 items.
```

Zero user-managed keys. Both keys on the account are Google-managed and cannot be
downloaded; it authenticates via Workload Identity Federation from GitHub Actions.
The roles are broad but nothing is exfiltratable. **Recorded here so the next
person does not re-open it.**

## 4. Stripe

**Current state:** account `acct_1TyrziLxTLo7m41V`, live mode, destination
`biteperk-billing` → `https://api.biteperk.com.au/stripe/webhook`.

1. Settings → Team and security → add a second **Administrator** on a
   `biteperk.com.au` address.
2. Enforce 2FA for the account; enrol authenticator on both admins.
3. Save recovery codes to the vault.

---

## 5. Cal.com, Cloudflare, GitHub

- **Cloudflare** — holds `biteperk.com.au`. Losing it loses every hostname we
  migrated today. Second admin + authenticator, and confirm the registrar
  account is separately protected.
- **Cal.com** — second admin; note that `SYNTH_EMAIL_DOMAIN` still points at
  `bookings.vocotable.algorythmos.com.au` by design, so agency-domain exposure
  persists here deliberately.
- **GitHub** — `biteperk-ai` already has TOTP enrolled (2 Aug 2026) and the
  setup key is vaulted. Confirm recovery codes are stored and that a second org
  owner exists in their own right.

---

## Recovery codes — where they go

Not email. Not a Google Doc. Not this file. The password vault entry for each
vendor, next to the TOTP setup key. Recovery codes bypass 2FA entirely, so
treat them exactly as you would the password.

---

## Completion check

| Vendor | Authenticator | 2nd admin | Recovery codes vaulted |
|---|---|---|---|
| Twilio | ✅ 3 Aug 2026 (default method) | ☐ | ☐ |
| Retell | ☐ | ☐ | ☐ |
| Stripe | ☐ | ☐ | ☐ |
| Cloudflare | ☐ | ☐ | ☐ |
| Cal.com | ☐ | ☐ | ☐ |
| GitHub | ✅ 2 Aug 2026 | ☐ | ☐ |

Google Cloud backup key: identified ✅ (Sam's own, 25 May) · host machine located ☐ ·
downgraded to objectCreator ☐ · rotated ☐ · bucket versioning on ☐

Twilio follow-ups: remembered browsers cleared ☐ · SMS fallback behaviour confirmed ☐ ·
TOTP setup key vaulted ☐
