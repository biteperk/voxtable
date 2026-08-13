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

## Not yet usable for a live call

Staging's `RETELL_API_KEY` / `RETELL_WEBHOOK_SECRET` come from the Secret
Manager secret `voxtable-stg-retell-api-key` in `bp-voxtable-stg`, last updated
**7 Aug 2026** — before this workspace's key existed. Until that secret holds the
Staging workspace key **and** the Cloud Run service picks it up on a new
revision, every call from these agents will be rejected 401 by the signature
gate. The staging API itself is healthy (`/health` → 200) and the gate is
confirmed on (unsigned `POST /retell/webhook` → 401).

A staging call also needs a `restaurants` row bound to `+61 468 203 234`, which
is data rather than configuration.
