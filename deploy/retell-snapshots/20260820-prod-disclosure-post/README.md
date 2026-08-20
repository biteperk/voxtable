# Production greeting: restore the AI + recording disclosure

**20 Aug 2026.** All three production agents, one field each: `begin_message`.

## Why

An owner cannot finish onboarding without ticking this (`AgreementStep.jsx:303`):

> "I understand Bella **announces on every call** that she's an AI and that the
> call is recorded — and that this can't be switched off."

Mazcina's greeting made no such announcement. The prompt does carry a reactive
rule — answer honestly *if asked* — but answering when asked is not announcing on
every call, and under the Surveillance Devices Act 2007 (NSW) the disclosure has
to precede the recording, so it belongs in `begin_message`.

`agreement_acceptances` is append-only. A venue certifying something the software
does not do writes a false warranty that cannot be corrected, only annotated. This
had to be true before any CSA is published (#164).

## What the estate actually looked like

Three agents, two greetings, neither right:

| Agent | Before | Disclosure |
|---|---|---|
| Mazcina (production) | 12 words | ❌ none |
| Cuban Corner Parramatta | 50 words | ✅ present |
| Natalia's Bistro | 50 words | ✅ present |

The 19 Aug humanize pass cut Mazcina's greeting from 50 words to 12 — correct
instinct, 50 words is fifteen seconds before a caller can speak — but it cut the
two *required* facts along with the two optional ones (a human-transfer offer and
a call-back-hours note, neither legally needed and both most of the bulk).

## After — all three identical, 24 words

> "Thanks for calling {{restaurant_name}} — this is Bella, an AI assistant. This
> call's recorded so I can take your booking. How can I help?"

Both required facts, plus purpose (APP notification), at half the old length. The
purpose clause is deliberate: "recorded" alone states the fact but not why.

⚠️ **Wording is open to review.** It was proposed, not signed off. Changing it is
one PATCH per LLM.

## Not done here, and needed

**The ear test.** No call has been placed. Nothing proves a greeting except
hearing it, and the skill is explicit that config which "should" work counts for
nothing until measured.

Complicating that: the only number bound in this workspace is `+61275011140` (the
legacy pilot line → Natalia's agent), on the Algorythmos account `NUMBERS.md`
records as suspended for funds. **`+61 468 202 846` is NOT in this workspace**,
contradicting `CLAUDE.md:71`, which claims it was wired end to end on 19 Aug.
So the Mazcina agent is currently unreachable by phone — the compliance gap was
latent, not live.

## Pre-existing violations, deliberately NOT touched

`assert-agent.mjs` after the change (all identical before it — verified against
the pre-snapshots):

| Agent | Violations | Notable |
|---|---|---|
| Mazcina | 2 | missing `{{venue_faq}}`, `{{today_status}}` |
| Cuban Corner | 10 | **legacy Algorythmos hostname in tool URLs**, no golden prompt, wrong `begin_message_delay_ms` |
| Natalia's | 12 | same, plus more |

Cuban Corner and Natalia's are far behind the golden config and still call back to
`vocotable.algorythmos.com.au`. That is its own change with its own test calls —
one lever per change.

## Rollback

Re-apply `begin_message` from `../20260820-prod-disclosure-pre/<venue>/llm.json`,
one PATCH per LLM. No other field moved; the diff is exactly one key on each.
