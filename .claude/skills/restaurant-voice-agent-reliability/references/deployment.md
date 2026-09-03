# Deployment

## Contents
- [Environment safety](#environment-safety)
- [Deployment checklist](#deployment-checklist)
- [Acceptance checklist](#acceptance-checklist)
- [Regression checklist](#regression-checklist)
- [Launch checklist](#launch-checklist)
- [Post-launch monitoring](#post-launch-monitoring)

---

## Environment safety

Four rules. Each cost a working day.

### 1 · Every identifier belongs to its own environment
> A production account identifier was hardcoded into a non-production seed. It had never existed in
> that environment, so the person it was meant to grant access to could never sign in. Nothing could
> notice: identifiers are opaque strings and no check compared them against the environment they
> were deployed into.

**Rule:** assert that every identifier in an environment's data resolves **in that environment's**
identity system, with a matching subject. Automate it — the gap is invisible to review, because a
wrong id looks exactly like a right one.

**Why it survived:** the same file held a *machine* identifier that was correct, because an
automated test exercised it and would have failed. The *human* identifier was never exercised until
a human tried. **Untested config is unverified config.**

### 2 · No cross-environment value may be a silent default
> Redirect URLs defaulted, in code, to production. Any environment that did not override them sent
> its users to production. A non-production flow completed and dropped the operator on the
> production site, where they could not sign in.

**Rule:** defaults are safe-by-construction (local, or absent-and-required). A default that is
*correct for one environment* is a trap for every other.

### 3 · Ship the value before the gate
> A fail-closed startup check shipped before the configuration it required. The deployment refused
> to boot. The gate was right; the ordering was wrong.

**Rule:** deploy the configuration, verify it, then deploy the check that requires it. Fail-closed
gates are correct and will happily take an environment down if introduced out of order.

### 4 · A register records intent; only a probe records reality
> A change register marked several entries "done". A probe found none of them in effect — they had
> been applied to a similar-looking object elsewhere. The sign-in path had been broken since.

**Rule:** anything recorded as done is verified by something that can **fail**. Where no read API
exists, a behavioural probe works: attempt the operation and classify the error. Include a
**negative control** — a deliberately invalid case that must fail — or you cannot distinguish "all
good" from "not actually checking".

---

## Deployment checklist

**Before**
- [ ] Every new configuration key exists in **every** environment, or is optional by design
- [ ] No new default points at another environment
- [ ] Any new fail-closed gate ships **after** its value
- [ ] Migrations are backward compatible with the running version
- [ ] New state keys have retention registered
- [ ] Feature flags default **off**; the kill switch is tested in both positions

**During**
- [ ] Configuration applied before the code that requires it
- [ ] Watch the rollout to a **ready** state — not merely "created"

**After — the verification that catches the most**
- [ ] **Latest created revision == latest ready revision.** If they differ, the new version failed
      to boot and the platform is still serving the old one. *This looks exactly like health.*
- [ ] Health endpoint responds
- [ ] The deployed build identifier matches the commit you intended
- [ ] Background workers announced themselves at startup, including any disabled ones
- [ ] Read back the configuration from the running service; do not trust the write

---

## Staging acceptance checklist

Run every item below in staging before promotion:
- [ ] Every automated suite green
- [ ] Every identifier resolves in this environment ([rule 1](#1--every-identifier-belongs-to-its-own-environment))
- [ ] No production hostname anywhere in a non-production config
- [ ] Webhook endpoints point at **this** environment and carry every required event type
- [ ] Sign-in works — with a **real** sign-in, not a config read
- [ ] One end-to-end call: book, order, pay, confirm
- [ ] Messages arrive on a real handset
- [ ] The voice battery has **rows**

---

## Regression checklist

After any change to agent behaviour, prompt, or tool contracts:
- [ ] Full automated suite
- [ ] The voice battery, re-run — prompt changes have non-local effects
- [ ] Latency measured and compared to the previous baseline
- [ ] Configuration snapshotted before and after, with the read-back **pasted**, not summarised
- [ ] One lever per change, or attribution is lost

---

## Launch checklist

- [ ] The complete acceptance and regression checklists passed in staging
- [ ] Production health/readiness is green and configuration was read back without mutation
- [ ] No dummy, fixture, synthetic, rehearsal or seed data exists in production
- [ ] Refund path implemented **or** a written manual procedure that reverses both legs
- [ ] Legal review where money or recording is involved — jurisdictional, needs long lead time
- [ ] Required disclosures present in the greeting, verified **by listening on staging**
- [ ] Rollback rehearsed on staging, with a known duration
- [ ] Alerting proven on staging and confirmed configured in production by read-back
- [ ] Someone owns the first day, by name
- [ ] Payment limits and fees confirmed with a staging/test-mode transaction

---

## Post-launch monitoring

**First 24 hours:** review **every** call transcript. Not a sample — the first day's calls are the
cheapest information you will ever get.

**First week, daily:** unresolved payment watchers · amount mismatches · refused-as-unavailable rate
(a spike means the menu is stale) · no-match rate on item search · latency trend · abandoned calls.

**Ongoing, automated and off-laptop:** production uses non-mutating configuration checks,
health/readiness and monitoring. Synthetic calls and any checks that create state run only in
staging; alerts are routed where someone reads them.

> A check that runs only when someone remembers is a check that finds the problem after the customer
> does.
