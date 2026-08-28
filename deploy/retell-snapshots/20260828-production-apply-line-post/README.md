# Cuban Corner's line went live on the plumbing — `+61 485 071 140`

**28 Aug 2026.** Written by `apply-line.mjs --apply`. Only what the read-back printed.

## What changed

| Layer | Action | Read-back |
|---|---|---|
| Agent `agent_2892d65ceace4e68d8a3f3e80c` | none needed — already matched the declaration | ✅ |
| `restaurants` row `22222222-…` | bound `twilio_phone_number` + `retell_agent_id` | ✅ `UPDATE 1` |
| Retell number import | imported webhook-only → `https://api.biteperk.com.au/retell/inbound` | ✅ confirmed, no static `inbound_agents` |

Before this, the menu was loaded (54 categories, 414 items, 125 variants, 1,411 modifiers —
including 164 `is_restricted` and 109 time-windowed, which is how you know the 031-column file
was used and not the legacy one). Menu first was deliberate: binding is what makes the line
answer, and a line that answers with an empty menu sounds like a broken agent rather than
missing data.

## Verification

`assert-line.mjs +61485071140 --strict` — **16 of 17 layers pass**, including Twilio checks
15–17, which had never run against a production line before (no API key existed for the
Biteperk-production account until yesterday).

The backend resolves the venue as "Cuban Corner Parramatta" and hands out the right agent, so
the registry row is proven transitively.

## The one failure: [14] golden agent config

Not plumbing — agent quality. This agent was built on 13 Aug and never received the naturalness
and honesty upgrades that Mazcina and the staging pair have:

- `stt_mode = fast`, `begin_message_delay_ms = 500`
- prompt sections `## Sound human`, `Open or closed?`, `be honest, never fake it`
- **no `{{venue_faq}}` or `{{today_status}}`** — and check [5] confirms the production backend
  *does* serve both. So Bella cannot answer "are you open now?" or general venue questions on
  this line, though the data is being handed to her every call. On a restaurant line that is a
  common question, not an edge case.

⚠️ **The filler rule is genuinely contested and needs a human decision.** `assert-agent.mjs` on
`integration` requires `speak_during_execution = true` on every functional tool. The version on
the unmerged `pipeline-environment-checks` branch requires the opposite — fillers only on
`send_payment_link` — with a written rationale that `speak_after_execution` was the real cure and
"the filler kept running". This agent was set to fillers-off on 27 Aug, following the newer
rationale. Whichever is right, the two checkers disagree, and that branch should be merged or
abandoned before anyone treats [14] as authoritative.

## Still open before the venue forwards its line

- **No Disaster Recovery URL on the trunk** — a Retell outage gives callers silence.
  `/twilio/disaster` is merged to `integration` (#293) but production runs `api:0.2.0`.
- **Floor and hours are placeholders** — 10 invented tables, 07:00–21:00 inferred from menus.
- **161 menu items have no description** — Bella can name and price them, not describe them.
- **`contact_email` is NULL** deliberately; backfill after the rehearsal.
- **Twilio auto-recharge off**, balance $20.
- **Voice is `11labs-Grace`, `en-US`** — American accent on a Sydney venue.

## Rollback

Unbind with `UPDATE restaurants SET twilio_phone_number = NULL, retell_agent_id = NULL WHERE
id = '22222222-…'` — the line then resolves nothing and callers are rejected at Retell.
The Retell **import has no clean undo**: deleting the number is one-way and re-importing can
need a 24–48h support ticket. The pre-snapshot beside this one is the agent's prior state.
