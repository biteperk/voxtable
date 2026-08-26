# 2026-08-26 — staging: send_payment_link tool + payment prompt section (+ modifier-options fix)

On the 11:08 call (`call_a7e9e9436fa96014aa4d72b56bf`) the caller asked "can I pay you now?"
and Bella had to say we don't take payment over the phone. The backend for voice-order
payment links (PR #154) has existed since 12 Aug but nothing registered the tool on the
agent — this PATCH closes that gap, plus one defect from the same call.

## What changed (`PATCH /update-retell-llm/llm_c1d40dbe180e737dd2ce1309ed3f`)

1. **`send_payment_link` appended to `general_tools`** (7 tools now): URL
   `…voxtable-stg-api…/retell/tools/send-payment-link`, `speak_during_execution` +
   `speak_after_execution` true, `order_id` required in the tool schema (the LLM must pass
   create_order's id; the backend's spoken 400 remains the net), optional `phone`.
2. **`## Paying by phone` prompt section** — the rollout doc's non-negotiables: offer ONCE
   after create_order confirms, never push; never read the link or any URL aloud; the link
   is good for forty-five minutes (shipped default, not the plan text's 30); any failure or
   `PAYMENTS_NOT_CONFIGURED` → "you can pay when you arrive", never dead air; resend =
   call the tool again (backend replays the same link, zero new sessions).
3. **Modifier-options fix** (11:08 defect: she confirmed "veggies", a side the kitchen
   doesn't have): required choices are read VERBATIM from the tool result; never confirm
   an option the tool hasn't listed, even if the caller suggested it.

Prompt 11,498 → 12,476 chars. Agent object untouched.

## Read-back evidence (pasted, not summarised)

```
READ-BACK: prompt 12476 chars | tools: ['check_availability', 'create_booking', 'modify_booking', 'end_call', 'menu_lookup', 'create_order', 'send_payment_link']
  ok: ## Paying by phone / forty-five minutes / NEVER read the link / pay when you arrive /
      never confirm an option the tool has not listed / ONLY time in the whole call…
ddv: {} | model: gpt-4.1
```

`ALLOW_NO_DISCLOSURE=1 assert-agent.mjs`: **ALL CHECKS PASSED** (all 7 custom tools carry
both speak flags).

## Safe while the flags are off

Until the staging Terraform apply flips `ORDER_PAYMENTS_ENABLED`/`STRIPE_CONNECT_ENABLED`
and the venue completes Connect onboarding, the tool refuses gracefully with the spoken
fallback — no error, no dead air. Environment PR: biteperk-cloud-platform #51.

## Verification still owed

F6 battery (staging number): happy path pay-by-link, decline, withheld number, order change
after link, "read me the link" refusal, resend.

## Rollback

Re-apply `../20260826-payment-link-pre/llm.json` (`general_prompt` + `general_tools`) in one PATCH.
