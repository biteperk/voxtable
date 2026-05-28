# Bella v3 real-call test script

Verifies the full voice → booking → pre-order → KDS chain after the Bella v3 prompt was pushed live (PR #39). Takes ~10 minutes if you run the full battery, or ~3 minutes if you just run the Happy Path.

## Before you call

Open these three tabs side-by-side on a single screen so you can watch all three react in real time:

1. https://vocotable.biteperk.com.au/live-feed — confirms the call is in progress and shows the transcript
2. https://vocotable.biteperk.com.au/kitchen-overview — manager's view of orders
3. https://kitchen.vocotable.biteperk.com.au — the actual kitchen wall display

The Natalia phone number you'll dial:

- Get it from the Twilio console (https://console.twilio.com/) → **Phone Numbers** → **Active numbers**, OR
- From the Retell console → **Phone Numbers** tab.
- It's the AU number that forwards via SIP trunk `algorythmos` to Retell.

Optional helpers if you also want to watch from a terminal:

```bash
# Stream just the Retell function calls in real time
gcloud compute ssh core-central-vm --zone us-central1-a --project vocotable-497209 \
  --command='sudo docker logs vocotable-api-1 --tail 0 -f 2>&1 | grep -E "evt|menu_lookup|create_order|create_booking"'
```

---

## 1. Happy path — book + pre-order (the canonical test)

### What you say

> **You**: Hi, I'd like to book a table for two tomorrow at 7 pm.
>
> **Bella** should: confirm the date Bella resolved (the actual day name + DD/Month/YYYY), then ask for your name.
>
> **You**: Sam Kalaliya — S-A-M.
>
> **Bella** should: confirm "table for two at 7 pm on [date], under Sam — is that right?"
>
> **You**: Yes.
>
> **Bella** should: confirm the booking, then ask **"would you like to pre-order anything so the kitchen has it ready when you arrive?"** ← if she skips this, **the v3 prompt didn't activate** — stop and check the Retell console.
>
> **You**: Yes please.
>
> **You**: Fish and chips, large, with a Coke.
>
> **Bella** should: read back "one Large Fish & Chips with Coke — is that right?", then confirm with the order number and total ($26).
>
> **You**: Perfect, thanks. Bye.
>
> **Bella** should: warm closing ("Cheers Sam, see you tomorrow"), then hang up.

### What to verify

| Tab | Should show within 2 seconds |
|---|---|
| live-feed | The call card with a green "Booking confirmed" pill, and the call transcript visible |
| kitchen-overview | A new "Order #N" card, source = `voice`, status = `pending`, payment = `unpaid`, "1× Fish & Chips — Large, + Coke" |
| **KDS wall display** | Same order in the **PENDING** column, audio chime plays (if you tapped the unlock banner earlier), age ticker counting up from 0s |

### Pass criteria

- All three tabs reflect the order within 2 seconds.
- Order total = **$26.00** (base $22 + Large $4 = $26; Coke is $0 within the F&C bundle).
- The `reservation_id` on the order matches the booking_id from the call_log. (You can cross-check this on `kitchen-overview` — the order card shows a `voice` source pill + the table assignment from the booking.)
- The audio ding fires on KDS within 1 second of the order appearing.

---

## 2. Edge: ambiguity — Bella should ask, not guess

Tests the `AMBIGUOUS_ITEM` error path. **Adult Fish & Chips and Kids Fish & Chips both exist** in the seed.

### What you say (place a second call)

> **You**: Hi, can I book a table for one at 8 pm tomorrow under Drew?
>
> [booking flow as above]
>
> **You**: Yes please pre-order.
>
> **You**: One fish and chips.   ← *deliberately ambiguous: no size, no drink, no adult/kids*
>
> **Bella** should: ask which one — "did you mean Fish & Chips or Kids Fish & Chips?". She must NOT auto-pick.
>
> **You**: The adult one, large.
>
> **Bella** should: now ask the next required thing — the drink.

### Pass criteria

- Bella asked the ambiguity question. (Failure mode: she silently picks one — bad LLM behaviour, fixable by tweaking the prompt.)
- After your "adult, large" reply she STILL asks for the drink. (Failure mode: defaults to Coke without asking.)

---

## 3. Edge: required modifier — Bella should not let you skip the drink

Tests `MODIFIER_REQUIRED`.

### What you say (third call OR continue from #2)

> **You**: Fish and chips large, that's all.   ← *skipping the drink*
>
> **Bella** should: ask "which drink — Coke, Lemonade, Fanta, or Sparkling Water?".

### Pass criteria

- Bella prompts for the drink rather than silently defaulting.
- Once you give a drink ("Lemonade"), the order goes through and shows on KDS.

---

## 4. Edge: item not on menu — graceful redirect

Tests `MENU_ITEM_NOT_FOUND`.

### What you say

> **You**: I'd like to pre-order a margarita pizza.   ← *Margherita exists; "margarita" is a drink. pg_trgm should catch the typo.*
>
> **Bella** should: confirm "did you mean Margherita Pizza?" (trgm threshold > 0.2 should match)
>
> OR if you push it:
>
> **You**: Sorry, I meant a phoenix soup.   ← *intentionally nonexistent*
>
> **Bella** should: apologise and offer to read what's available — "We don't have that. We do have mains, salads, kids meals, and drinks. Want one of those?".

### Pass criteria

- For a typo (Margherita / margarita), she resolves and confirms.
- For a real miss (phoenix soup), she does NOT invent a price/dish; she falls back to category overview.

---

## 5. Edge: Bella idempotency under Retell retries

You can't trigger this manually — it's automatic. But you can VERIFY it happened correctly:

- After a successful order, hang up.
- Re-call the same number and place ANOTHER order immediately.
- Check `kitchen-overview`: there should be **two distinct orders** (one per call), each with a different `call_id` as the idempotency key.
- If Retell automatically retries `create_order` mid-call (e.g. transient network blip), the backend dedupes by `call_id` → only one row.

### Pass criteria

- Two calls = two orders. ✓
- Within a single call, even if you say "yes confirm the order" twice, only one order appears (idempotent).

---

## After all tests pass — KDS lifecycle

Now you (or kitchen staff) drive the orders through the lanes on the wall display:

1. Tap **Start** on one order → moves to PREPARING lane.
2. Tap the per-item ✓ next to "Fish & Chips Large" → green check.
3. Tap **Mark Ready** → moves to READY lane.
4. From the manager dashboard `kitchen-overview` → toggle the payment pill to PAID.
5. Tap **Served** on the KDS → card fades and disappears.

If you have a second tablet (or open the KDS in a second browser tab), you'll see the optimistic-UI conflict path: tab A taps Start, then tab B taps Start before refresh → tab B shows "Updated by another tablet — refreshing".

---

## What to capture if anything fails

For Bella misbehaviour, grab the **Retell call ID** from the live-feed page transcript header and run on the VM:

```bash
gcloud compute ssh core-central-vm --zone us-central1-a --project vocotable-497209 \
  --command='sudo docker exec vocotable-postgres-1 psql -U vocotable -d vocotable -c \
   "SELECT created_at, status, summary, special_requests FROM call_logs WHERE provider_call_id = '"'"'<CALL_ID>'"'"';"'
```

For backend errors during the call, look at the api logs for the timeframe:

```bash
gcloud compute ssh core-central-vm --zone us-central1-a --project vocotable-497209 \
  --command='sudo docker logs vocotable-api-1 --since 10m 2>&1 | grep -E "error|retell|order" | tail -30'
```

## Rollback (worst case)

If Bella v3 is misbehaving badly:

```bash
# On the VM:
gcloud compute ssh core-central-vm --zone us-central1-a --project vocotable-497209
cd /opt/vocotable/deploy/retell-snapshots/20260529-bella-v3-live/
RETELL_API_KEY=$(sudo grep "^RETELL_API_KEY=" /opt/vocotable/.env | cut -d= -f2-) python3 << 'PY'
import json, os, urllib.request
pre = json.load(open('llm-pre.json'))
req = urllib.request.Request(
  f"https://api.retellai.com/update-retell-llm/{pre['llm_id']}",
  method='PATCH',
  headers={'Authorization': f"Bearer {os.environ['RETELL_API_KEY']}",
           'Content-Type': 'application/json'},
  data=json.dumps({'general_tools': pre['general_tools'],
                   'general_prompt': pre['general_prompt']}).encode())
print(urllib.request.urlopen(req).read().decode())
PY
```

This reverts Bella to v2 (booking-only) in <2 seconds. The KDS + dashboard keep working — they just won't get new voice orders until you re-push v3.
