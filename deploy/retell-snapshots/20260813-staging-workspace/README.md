# Staging Retell workspace — first build (13 Aug 2026)

Both venue agents in the **Staging** workspace of the BitePerk Retell account
(`biteperk@gmail.com`), so changes can be rehearsed before they touch the
production workspace.

| Venue | Agent | LLM |
|---|---|---|
| Natalia's Bistro (STAGING) | `agent_b9087333b7030f0cee06a19ffc` | `llm_7c0a5c84498b81a5c723521038ef` |
| Cuban Corner Parramatta (STAGING) | `agent_a9c17694d805908f4b9a7bd4b9` | `llm_472328dafafd697a3c8e67230457` |

**Every URL points at staging**, not production:

```
https://voxtable-stg-api-naed3dbhna-ts.a.run.app/retell/webhook
https://voxtable-stg-api-naed3dbhna-ts.a.run.app/retell/tools/*
```

This is the whole point of the copy and the thing most likely to be got wrong.
Cloning the production payloads verbatim would leave staging agents calling the
production API — a staging test call would then write bookings into the
production database. The build rewrites every hostname and then **asserts** that
the string `algorythmos` appears nowhere in either object; 15 read-back checks
cover that, the six tools, the empty `default_dynamic_variables`, the AI +
recording disclosure, and that the two venues hold different LLMs.

## Wired and verified end-to-end (13 Aug 2026)

Everything short of real audio is proven:

| Step | Result |
|---|---|
| Staging secret holds the Staging workspace key | ✅ version 4 of `voxtable-stg-retell-api-key` |
| Cloud Run picked it up | ✅ `voxtable-stg-api-00031-qps`, `voxtable-stg-worker-00027-9pl` |
| Signed request verifies | ✅ **204** signed with the Staging key |
| Wrong key rejected | ✅ **401** |
| `+61 468 203 234` imported to the Staging workspace | ✅ webhook mode, no static agent binding |
| Venue row exists and resolves | ✅ `VoxTable Staging Venue` `33333333-…`, 4 tables, 09:00–23:00 daily |
| Dialled number → venue | ⚠️ **see the correction below** — returns `override_agent_id: agent_b9087333…` with **fresh** dynamic variables (correct venue name, timezone, today's dates) |
| Unknown number fails closed | ✅ `restaurant_unconfigured: true`, no agent override |

> ## ⚠️ Correction, 18 Aug 2026 — that row was not a pass
>
> `agent_b9087333b7030f0cee06a19ffc` is **`Natalia's Bistro (STAGING)`** (see the table at
> the top of this file). Returning it for a call to `+61 468 203 234` — the **VoxTable
> Staging Venue** number — is the bug, not the proof.
>
> The check was self-consistent rather than correct: it asserted that the webhook returned
> *the agent the venue row named*, and the venue row named the wrong agent. Both halves
> agreed, and both were wrong. The verification that was missing is whether the agent belongs
> to the venue at all.
>
> On a live call this presented as the right venue's data underneath the wrong venue's voice:
> correct `restaurant_name` in the dynamic variables, correct booking written to the correct
> restaurant, and a caller told they had reached Natalia's Bistro — because that agent's
> prompt hard-codes it, and the greeting ignores `{{restaurant_name}}` entirely.
>
> **Do not use this snapshot as a reference for a venue build.** Its prompts still carry
> Natalia's venue name and owner name in prose. `deploy/runbooks/venue-onboarding.md` §1
> trap 3 already warned about exactly this.

That the dynamic variables come back computed per call — not the frozen
`default_dynamic_variables` — is the specific thing worth re-checking after any
change, because the failure is silent: the caller simply hears a stale venue
name and wrong dates.

⚠️ **The `termination_uri` on the imported number is a placeholder.** It was set
to `voxtable-staging-au1.pstn.twilio.com`, inferred from the trunk's friendly
name rather than read from Twilio — and NUMBERS.md §3a records trunk termination
as *deliberately unconfigured* on both trunks, because VoxTable is inbound-only.
The field is inert for inbound calls (inbound is driven by the trunk's
*origination* URI pointing at Retell), so it does not affect anything today. But
do not trust it: if outbound SIP is ever needed, configure a real termination
domain in Twilio first. DNS cannot confirm it either way — `*.pstn.twilio.com`
is a wildcard and resolves for any invented subdomain.

## Re-seeding a staging venue

The staging Cloud SQL instance is **private-only**, so it cannot be reached from
a laptop even with the Cloud SQL proxy. The route that works is a throwaway
Cloud Run job cloned from `voxtable-stg-migrate`'s network settings —
`--network voxtable-stg-private --subnet voxtable-stg-cloud-run`,
`--vpc-egress private-ranges-only`, the `cloudsql-instances` annotation, the
`voxtable-stg-runtime` service account and the `voxtable-stg-database-url`
secret. Pass SQL base64-encoded through an env var and use a custom `--args`
delimiter (`^@^`), because gcloud splits `--args` on commas and any real script
is full of them. Delete the job afterwards; it is not Terraform-managed.
