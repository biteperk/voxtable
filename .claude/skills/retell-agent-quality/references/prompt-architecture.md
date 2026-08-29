# Prompt architecture — the de-venued contract

The prompt is venue-agnostic BY DESIGN. One prompt serves any venue; everything
venue-specific arrives per call as a dynamic variable injected by `/retell/inbound`. This is
a guardrail, not a style: an agent whose prompt names a venue answers in that venue's voice
even when bound to a different restaurant (the 18 Aug wrong-venue call), and it cannot be
cloned safely. `createVenueLlm` refuses templates without `{{restaurant_name}}`.

**The verbatim golden prompt lives in the latest `deploy/retell-snapshots/*/llm.json`**
(`general_prompt`). Copy from there — never retype from this file, which describes the
contract, not the text.

## The dynamic variables (backend: `services/retellService.ts` → `handleRetellInbound`)

| Variable | Semantics | Trap |
|---|---|---|
| `restaurant_name` | Venue display name, cached 60 s/process | SQL renames take up to 60 s to be spoken |
| `owner_name` | Callback name ("I'll have {{owner_name}} ring you") | Falls back to "the manager" — never a hard-coded person |
| `venue_faq` | The venue's own answers, formatted from DB `faq_json` by `services/venueFaq.ts` | Budget **16 entries / 1200 chars**, entries over budget are dropped WHOLE in alphabetical key order (logged at error). The `hours` entry is load-bearing: the prompt's open/closed logic reads it. |
| `today` / `tomorrow` | YYYY-MM-DD in the venue TZ, computed per call | DST-safe calendar arithmetic — never "+24 h" |
| `now_local` / `weekday_local` | "HH:MM" and lowercase weekday | |
| `today_status` | **One sentence to speak verbatim**: "CLOSED today (Wednesday). Next open tomorrow (Thursday) from 12 PM." Computed from `opening_hours_json` by `utils/time.ts::formatTodayStatus` (unit-tested incl. multi-day closures) | `""` when a venue has no hours — the prompt must then make no claims |
| `menu_status` | **One short paragraph to speak verbatim**: "Menu right now: the all-day menu is serving. Items served between 7 AM and 12 PM are NOT available now." Built per call from the venue's distinct item windows by `menuService.ts::formatMenuStatus` (unit-tested: half-open, midnight-wrap, cap at 4 windows / 320 chars) | `""` when the venue has no windowed items — the prompt must then make no menu-time claims. Never name items here (that's `menu_lookup`, whose matches carry `available_now` + `served`). Added after call_4e871f4bc (30 Aug 2026). |
| `caller_phone` | E.164, or `""` for withheld/anonymous IDs | **Never the literal "anonymous"** — that string reached `create_booking` once (400). `""` triggers the ask-digit-by-digit rule. The call LOG keeps the raw value; only the agent gets "". |
| `restaurant_id` | For tools; the backend ignores agent-supplied ids anyway (dialled-number resolution is the trust anchor) | |

**A variable must exist in the backend BEFORE the prompt references it** — Retell renders a
missing `{{name}}` literally. Order: backend change → deploy → probe (`probe-inbound.mjs`)
→ then wire into the prompt.

## Testing in the dashboard, where NO webhook fires

Dashboard "Run Test" / web calls do not call `/retell/inbound`, so every variable is unset
and Bella speaks the placeholder aloud ("…calling restaurant name"). Two ways to test:

1. **Per-test, no config change**: the `{ }` panel beside Test Audio takes a JSON object of
   dynamic variables. Best for rehearsing dates and closed-day behaviour, since you can set
   `today`/`weekday_local`/`today_status` to whatever scenario you want.
2. **Persisted, for the venue's own agent**: put ONLY the static identity in
   `default_dynamic_variables` — `restaurant_name`, `owner_name`, `restaurant_timezone`,
   and (for a venue trading every day) a weekday-free `today_status`. Every dashboard test
   then greets correctly with no setup.

⚠️ **Never persist `today`, `tomorrow`, `weekday_local`, `now_local` or `caller_phone` as
defaults.** Nothing refreshes them, and they are the fallback when the webhook fails — a
frozen date or a stranger's phone number is the "confidently wrong" failure NUMBERS.md §6
was written about. `assert-agent.mjs` hard-fails on those five keys and merely notes the
static ones.

## Section map of the golden prompt (~10k chars) and each section's non-negotiables

1. **Identity** (2 sentences): who Bella is, "never like anyone reading a script". De-venued.
2. **Sound human — this is the whole job** (top of prompt deliberately): one/two SHORT
   sentences per turn; react before acting; **instant-open** (a tiny first word — "Yep!",
   "Sure —" — so TTS starts sooner); vary wording; spoken dates read like a person AND the
   **day-of-month read off the resolved YYYY-MM-DD, never from memory** (a live call said
   "the twenty-second" for the 20th); ONE aside while tools run; honest one-sentence answer
   if asked "are you an AI / is this recorded"; warm handover offer if they want a person.
3. **Time anchor** — absolute-date computation rules anchored on `{{today}}`; never pass a
   past date to tools.
4. **Open or closed? Check BEFORE you answer** — `{{today_status}}` spoken directly; check
   the Hours entry FIRST for any other day; lead with the conclusion (never "yes… actually");
   **NEVER call a tool to learn whether the venue is open**.
5. **Taking a booking** — collect date/time/party; **closed-day gate before the tool**: a
   closed date gets an instant refusal + nearest open day, no `check_availability`; ask the
   booking name explicitly (a mentioned name may be a friend); confirm once; `create_booking`
   with `{{caller_phone}}` (if `""`, ask digit-by-digit FIRST); read the confirmation back;
   pre-order offer once.
6. **Seating preferences** — acknowledge, never promise, pass `seating_preference`, don't ask
   proactively.
7. **Pre-ordering** — offer ONCE post-confirmation; per-dish `menu_lookup`; ask for sizes and
   REQUIRED choices (never auto-pick); repeat the whole order; the four `create_order` error
   codes each with a spoken recovery; never invent items or prices. Examples stay
   menu-agnostic — the old prompt taught fixture dishes (Fish & Chips sizes, Coke/Fanta)
   that didn't exist on the real menu.
8. **Menu questions — three modes**: general ask → NO query and NO category (returns
   sections); one section → `category`; a named dish → `query` verbatim. Speak two or three
   things then ask — **never recite a full `speakable_summary`**.
9. **Corrections after create_booking** → `modify_booking` immediately with only the changed
   fields.
10. **When a tool doesn't work — be honest, never fake it.** The most load-bearing text in
    the product. Never claim a booking/availability/order without a returned success; the
    graceful degraded script (take name + number, team will text); pre-order failure never
    un-books the table. Keep verbatim.
11. **Edge cases** — party ≥7 (largest table seats 6) → warm callback via `{{owner_name}}`;
    hours/parking/venue facts ONLY from `{{venue_faq}}`; the Aria-rename one-time correction;
    never invent a booking ID.
12. **Ending the call** — one goodbye then `end_call` immediately; pre-confirmation goodbyes
    get pulled back once.
13. **Venue questions** — `{{venue_faq}}` block + the boundary: not covered → take a message,
    never guess (wheelchair/dietary wrong answers cause real harm).

## Greeting (`begin_message`) variants

- **Staging (current)**: `Thanks for calling {{restaurant_name}} — this is Bella. How can I help?`
  (~3 s). **No disclosure — deliberate, staging-only, per Sam 19 Aug.**
- **Production / any line real callers reach**: must carry the AI + recording disclosure until
  legal advice says otherwise — `deploy/runbooks/legal-brief-call-recording.md`. The long
  form is preserved in `20260819-humanize-pre/llm.json`. A compressed compliant middle
  ground ("…this is Bella, our AI assistant, on a recorded line…") was drafted 19 Aug but
  not adopted; wording is a legal call, not an engineering one.

## Tool definitions (on the LLM object, not the prompt)

- Every functional tool: `speak_during_execution: true` + `speak_after_execution: true`,
  with a natural `execution_message`.
- `menu_lookup` description carries the three-mode contract AND the never-recite rule —
  the model obeys tool descriptions at the call site more reliably than distant prompt text.
- `boosted_keywords` (agent level) is part of the language system: the venue's name + the
  dishes callers actually say. A clone inherits the previous venue's list (found live:
  Mazcina's clone still boosted "Natalia's Bistro" and "fish and chips").
