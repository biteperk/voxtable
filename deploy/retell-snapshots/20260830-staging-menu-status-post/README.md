# Staging agent learns which menu is on — `{{menu_status}}` wired

**30 Aug 2026.** Follows PR #329's backend deploy. Order honoured: backend first (probe showed
`menu_status` served — `""` for Mazcina, the correct value for a venue with no windowed
items), prompt second. One PATCH to `llm_c1d40dbe180e737dd2ce1309ed3f`:

- Prompt gains the "## What's on the menu right now" section referencing `{{menu_status}}`,
  inserted before the honesty section: speak it verbatim, never guess menu times, and for a
  `menu_lookup` match with `available_now = false` say when it IS served and redirect —
  never start the order.
- `menu_lookup`'s tool description gains the same contract. Retell caps tool descriptions at
  **1024 chars** (the first PATCH 400'd on this — new gotcha for api-operations.md); the
  description was trimmed to fit with the contract line kept whole.

## Read-back (pasted)

```
readback: prompt references {{menu_status}}: True
readback: menu_lookup desc carries available_now: True
readback: fillers still on: True
```

`assert-line +61468203234 --strict`: **All checks passed** — including the NEW
`can answer which menu is on right now (via {{menu_status}})` check, which arms itself only
when the live probe sees the backend serving the variable.

## Deliberately not yet done

Production's agent is untouched: the VM backend (`api:0.2.0`) does not serve `menu_status`,
and a prompt reference against it would render as spoken curly braces. The production PATCH
is step 9 of the plan, gated on the cutover deploy + a production probe. The interim on
production is the `Menu times` venue_faq entry (verified live by signed probe, 30 Aug).

## The incident this closes

`call_4e871f4bc` (30 Aug): haloumi fries requested for a 2 PM pickup; three variants offered
with no serving times; order refused only at `create_order`; caller: "I'll call you back."

## Rollback

Re-apply `../20260830-staging-menu-status-pre/llm.json` via `PATCH /update-retell-llm/llm_c1d4…`.
