# Retell config update: Bella pre-ordering branch + KDS tools

This snapshot folder is the **delta** to apply on top of whatever's currently
live in Retell. It adds two custom function tools and a prompt branch for
pre-ordering food.

## What's in this folder

| File | What it is |
|---|---|
| `tools-new.json` | Two NEW custom function defs (`menu_lookup`, `create_order`). Append to the live agent's `general_tools` array. |
| `prompt-bella.txt` | Full replacement prompt — same Bella v2 base + a new `## Pre-ordering food (NEW)` section after the booking flow and error-handling rules. |
| `README.md` | This file. |

## Apply via the Retell dashboard (recommended)

The Retell console at https://app.retellai.com/ is the path of least pain.

1. **Snapshot the current state first** so you can roll back:
   - Open the agent — for Natalia's Bistro it's the one with phone number `{{caller_to_number}}`.
   - Open its LLM. Copy the **General prompt** into a file `prompt-current.txt` in this folder.
   - Save the agent + llm JSON to `agent-live.json` / `llm-live.json` (View > Export, or use the API — see "Apply via API" below).

2. **Add the two new tools** to the LLM:
   - In the LLM editor → "Functions" → "Add Function" → Custom function.
   - Copy the first object from `tools-new.json` (the `menu_lookup` one) into the fields.
   - Repeat for `create_order`.
   - Save.

3. **Replace the prompt**:
   - In the LLM editor → "General prompt" → paste the contents of `prompt-bella.txt`.
   - Save.

4. **Smoke-test live**:
   - Use the "Test" panel in Retell to dial the LLM with a scripted scenario:
     ```
     "Hi, table for two tomorrow at 7pm, name's Sam."
     [Bella confirms booking]
     [Bella offers pre-ordering]
     "Yeah let's do fish and chips large with a Coke."
     ```
   - Verify the dashboard `/manage-menu` / `/kitchen-overview` / KDS all show the order.
   - Use the test panel transcript to verify Bella did NOT auto-pick the drink.

5. **Real-call smoke**: place a real phone call to the Twilio AU number. Cancel the order from the dashboard afterwards.

## Apply via API (alternative)

If you'd rather script it (e.g. via the existing `PATCH /update-retell-llm/{llm_id}` endpoint on the backend):

```bash
# Set these
RETELL_API_KEY=key_...
LLM_ID=llm_2cad4da643f2beb4d07dd0b311d1  # from the latest snapshot

# 1. Fetch current state
curl -H "Authorization: Bearer $RETELL_API_KEY" \
  https://api.retellai.com/get-retell-llm/$LLM_ID \
  > /tmp/llm-pre.json

# 2. Merge new tools into existing general_tools
jq --slurpfile new tools-new.json \
   '.general_tools = (.general_tools + $new[0])' \
   /tmp/llm-pre.json > /tmp/llm-tools.json

# 3. Replace prompt
jq --rawfile p prompt-bella.txt \
   '.general_prompt = $p' \
   /tmp/llm-tools.json > /tmp/llm-post.json

# 4. Push
curl -X PATCH -H "Authorization: Bearer $RETELL_API_KEY" \
  -H "Content-Type: application/json" \
  -d @/tmp/llm-post.json \
  https://api.retellai.com/update-retell-llm/$LLM_ID
```

(The actual `llm_id` and `agent_id` change occasionally — check the latest
snapshot in `deploy/retell-snapshots/` to be sure.)

## Rollback

If something feels off after rollout:

1. Go to the LLM editor → "General prompt" → paste `prompt-current.txt`
   (the snapshot you captured in step 1).
2. Delete the two new functions (`menu_lookup`, `create_order`) from the
   tools list.
3. Save.

Backend keeps working — the new endpoints just stop receiving traffic.

## Things to verify after rollout

- [ ] A booking-only call still ends cleanly (the new ordering offer doesn't break the existing flow).
- [ ] A booking + order call writes to the `orders` table (check `/api/ops/kds-health` → `active_orders > 0`).
- [ ] Same call replayed (Retell retries) does NOT create a duplicate order (idempotency on `call_id`).
- [ ] Ambiguous item → Bella asks "did you mean X or Y" instead of guessing.
- [ ] Required drink modifier → Bella asks "which drink" instead of auto-picking.
- [ ] Order shows on https://vocotable-kds.web.app within 2 seconds of the LLM completing `create_order`.
