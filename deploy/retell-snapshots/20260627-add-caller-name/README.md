# 20260627-add-caller-name — capture the caller's name in post-call analysis

## Why
The dashboard Live Feed only ever showed the literal "Caller" because no name
was stored on `call_logs`. We now surface a name from two sources:

1. **Booking calls** — the name the caller gave to `create_booking` (already in
   `customers.name`). The API JOINs it in as `customer_name`. **No Retell change
   needed for this** — it works the moment the backend ships.
2. **Non-booking calls** (info, no-availability, abandoned) — there is no
   booking, so the name has to come from Retell's post-call analysis. That is
   what this snapshot adds: a new `caller_name` field in `post_call_analysis_data`.

The backend already reads `custom_analysis_data.caller_name` into the new
`call_logs.caller_name` column (`extractCallAnalysis` in `retellService.ts`), and
the API exposes it. Until this agent change is applied, that column simply stays
null for non-booking calls and the feed falls back to the phone number — nothing
breaks.

## What changed vs `20260529-busy-fix`
**`agent.json`** — added one field to `post_call_analysis_data`:

```json
{
  "type": "string",
  "name": "caller_name",
  "description": "The caller's name as they gave it on the call ..."
}
```

(The standalone object is also in `caller-name-field.json` for easy copy-paste.)
Nothing else in the agent changed.

## Apply (do NOT blindly PATCH the whole file)
The live agent may have drifted since `20260529-busy-fix` (the intern edits the
Retell config directly). **Reconcile first.** Safest path — append only the new
field, don't replace the array:

1. Fetch the live agent's current `post_call_analysis_data`.
2. Append the `caller_name` object from `caller-name-field.json` to that array.
3. PATCH it back:
   ```
   PATCH /update-agent/agent_7b7a5f6c21c9968ee88afd3bac
   body: { "post_call_analysis_data": [ ...existing fields..., <caller_name> ] }
   ```
4. **Publish** the agent version in the Retell dashboard and confirm the phone
   number points at the published version — a draft won't take live calls.

The full `agent.json` here is the *expected* end state (busy-fix + caller_name);
use it only to diff against live, not as a wholesale overwrite.

## Verify
After a live or test call where the caller says their name on an **info** call
(no booking), check the row:
```sql
SELECT caller_phone, caller_name, intent, booking_outcome
FROM call_logs ORDER BY created_at DESC LIMIT 5;
```
`caller_name` should be populated. The Live Feed should show the name instead of
"Caller".

## Rollback
Remove the `caller_name` field from the live agent's `post_call_analysis_data`
and re-publish. The backend tolerates its absence (column stays null). No DB
rollback needed — the `caller_name` column is additive and nullable.
