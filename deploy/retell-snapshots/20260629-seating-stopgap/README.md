# 20260629 — seating preference stopgap (Option A)

> Historical snapshot only. VM commands below apply only to the sandbox and must never be used as
> a production deployment, rollback or data-migration procedure.

Applied live to the **Natalia's Bistro** Retell agent on 2026-06-29.

- **agent_id:** `agent_7b7a5f6c21c9968ee88afd3bac`
- **llm_id:** `llm_2cad4da643f2beb4d07dd0b311d1`

## What changed

Stopgap so voice seating requests ("can I get a window table?") are acknowledged
and recorded, ahead of full zone-aware allocation (Option B, to be built around
Natalia's real floor plan). Pairs with backend PR #45 (`seating_preference` →
booking notes).

1. **`create_booking` tool** — added an optional `seating_preference` string param
   (not required). The six original params are unchanged.
2. **Prompt** — added a `## Seating preferences` section (between the booking flow
   and pre-ordering): Bella acknowledges a preference warmly without promising it,
   never guarantees a table, passes it as `seating_preference`, and does not
   proactively ask every caller.

Table allocation is still capacity-only — no over-promise. `general_tools` count
unchanged (6); model `gpt-4.1`.

## Rollback (< 1 min)

Re-apply the pre-change config. On the VM:

```bash
# llm-pre.json is this folder's pre-change snapshot — scp it to the VM first, then:
K=$(sudo grep ^RETELL_API_KEY= /opt/vocotable/.env | cut -d= -f2-)
curl -s -X PATCH \
  -H "Authorization: Bearer $K" -H "Content-Type: application/json" \
  -d @/tmp/llm-pre.json \
  https://api.retellai.com/update-retell-llm/llm_2cad4da643f2beb4d07dd0b311d1
```

(`update-retell-llm` accepts the full LLM body; the meaningful fields to restore
are `general_prompt` + `general_tools`.)
