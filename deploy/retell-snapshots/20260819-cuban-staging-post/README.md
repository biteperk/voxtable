# Cuban Corner Parramatta (STAGING) — after the golden polish, 19 Aug 2026

First real application of the `retell-agent-quality` skill. Read back from the API:

- Prompt replaced with the golden (Mazcina-proven) prompt — de-venued, so reusable
  verbatim — with two adaptations: the licensed-drinks refusal section KEPT (Cuban
  Corner serves alcohol; wording made venue-agnostic, aligned with the backend
  `is_restricted`/`create_order` contract), and the party-size edge GENERALIZED to
  rely on `check_availability`'s `party_too_large` reason instead of Mazcina's
  hard-coded "seats six" (a golden-prompt improvement worth backporting).
- Golden greeting; `default_dynamic_variables` {}; every functional tool
  speak_during/after true; golden menu_lookup three-mode description; all tool URLs
  asserted staging-host.
- Agent: `stt_mode fast`, `interruption 0.6`, `enable_expressive_mode false`
  (explicit), `fallback_voice_ids ["cartesia-Maren"]` (custom-voice requirement),
  `boosted_keywords` rewritten to 30 real Cuban Corner terms (empanadas, Cubano,
  mojito, fajita, churros…). Voice kept: the venue's custom AU ElevenLabs voice.
- `assert-agent.mjs` ALL CHECKS PASSED (VENUE_NAMES=cuban,parramatta,havana).

⚠️ This agent has NO phone number (staging's one DID belongs to Mazcina — THE ONE
RULE), so /retell/inbound never fires for it: dashboard/web tests must supply test
dynamic variables, and {{venue_faq}}/{{today_status}} only resolve for real once the
venue is seeded and bound in an environment with its own number.

Rollback: re-apply the sibling `-pre/` snapshots (one PATCH per object).

## Addendum — static default_dynamic_variables added for dashboard testing

Dashboard tests don't fire `/retell/inbound`, so Bella was speaking the placeholder
("thanks for calling restaurant name"). Set as defaults, deliberately limited to what
cannot go wrong on this venue's own agent:

```json
{"restaurant_name":"Cuban Corner Parramatta","owner_name":"the team",
 "restaurant_timezone":"Australia/Sydney","today_status":"OPEN today, 7 AM to 9 PM."}
```

`today_status` is weekday-free on purpose: Cuban Corner trades 07:00–21:00 seven days, so
that sentence stays true on any future date.

**EXCLUDED, and they must stay excluded**: `today`, `tomorrow`, `weekday_local`,
`now_local` (frozen dates — the exact "months-old dates" fallback failure in NUMBERS.md §6)
and `caller_phone` (would book a stranger under someone else's number). `venue_faq` is also
excluded: the venue's `faq_json` is empty in the database and a default here would hide that
rather than fix it.

For a full rehearsal (dates, closed-day behaviour), paste the volatile values into the
dashboard's `{ }` test-variable panel instead — per-test, never persisted.

## Addendum — unresolved-date guard

Same guard as the Mazcina snapshot's addendum: a 20:45 web test made the agent invent
`2024-06-12` for "tonight" when `{{today}}` was unresolved. The Time anchor now forbids
guessing a date and requires asking for it (year included) or taking a message.
