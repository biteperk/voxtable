# Menu Matching and Price Presentation

One principle, two applications: **never let the model do work the system can do.** Matching is a
search problem, not a judgement call. A price is a formatting problem, not an arithmetic one.

## Contents
- [The model-facing data contract](#the-model-facing-data-contract)
- [Matching strategy](#matching-strategy)
- [The lookup contract](#the-lookup-contract)
- [Availability](#availability)
- [Failure modes](#failure-modes)
- [Required tests](#required-tests)

---

## The model-facing data contract

Everything the model receives is **speakable as-is**. If reading a field aloud verbatim would be
wrong, the field must not be in the payload.

| Never expose | Expose instead | Why |
|---|---|---|
| Price in minor units | Formatted price string | *An integer in minor units was read aloud literally — a $1.50 item quoted at fifteen cents, a $9.00 item as "nine hundred cents"* |
| Internal ids | Nothing, or an opaque handle it only echoes back | Ids get spoken aloud |
| Enum codes | The sentence for that state | Codes get spoken aloud |
| Payment URLs | Nothing | The model cannot leak what it never sees |
| Raw errors | A line the agent can say | *Otherwise a caller hears a stack-shaped apology* |
| Similarity scores | The decision | Scores invite the model to re-litigate the match |

**Why removal beats instruction.** The model converted minor units correctly *most* of the time.
That is worse than never: an arithmetic step it *can* skip is one it eventually will, on a call you
are not listening to. Removing the possibility is not defensive coding — it is the only kind that
holds.

**Formatting rule.** One helper formats money and every path uses it — payload, summary line,
confirmation and receipt. A second formatter is a second answer.

---

## Matching strategy

**Containment first, similarity second.**

```
query
  │
  ├── generic word for the menu itself ("menu", "food", "options")?
  │      └──► category overview. Never a name search — it can never match
  │
  ├── a category name, or a synonym for a group of categories?
  │      └──► that section's items
  │
  └── otherwise: item search
         │
         ├── query appears INSIDE an item name? ──────► match, any score
         │
         ├── similarity ≥ THRESHOLD? ─────────────────► match
         │
         └── neither ─────────────────────────────────► NO MATCH
                                                        say so plainly,
                                                        offer real sections
```

**Why containment first, with evidence.** A pure threshold cannot separate these two cases:

| Query | Item | Score | Verdict |
|---|---|---|---|
| a sandwich type | an unrelated beverage | **0.200** | must NOT match — they share three letters |
| a drink style | a long drink name containing it | **0.269** | must match |

Raising the threshold to exclude the first also excludes the second. **Containment resolves it
cleanly**: the honest near-miss is a substring of the item name; the nonsense match is not.

> The nonsense match also slipped past a strict `> 0.2` comparison at *exactly* 0.200 — floating
> point. Never let a correctness boundary rest on an exact float comparison.

**Choose the threshold against a real menu, not by intuition.** Compute scores for realistic queries
against actual item names and pick a value that keeps every genuine hit. Record the table; it is the
evidence for the number.

**Ambiguity:** when the top two matches are close, ask which — do not guess. Deduplicate identical
names first, or you produce the unanswerable "did you mean X or X?".

---

## The lookup contract

One tool, three modes. **Every mode must be implemented** — a declared-but-ignored parameter is
worse than an absent one, because the model uses it and is quietly given the wrong answer.

| Mode | Input | Returns |
|---|---|---|
| Overview | nothing | Section names |
| Browse | a category | Items in that section |
| Search | a query | Matching items, or an explicit miss |

*A category parameter existed in the schema and its description from day one but was silently
ignored. The agent browsing drinks received the generic food overview and told callers the drinks
list was broken.*

**Bound every list.** Name two or three things, stop, and ask. *An overview that read a couple of
items from each section produced a 17-second monologue that still failed to mention half the menu.*
The bound belongs in the **tool description as well as the prompt** — the model reads both.

**Never hardcode fallback content.** *A hardcoded list of section names — from a test fixture — was
spoken verbatim to every venue's callers.* Fallbacks are derived from that venue's data or are
absent.

**Group synonyms deliberately.** Callers ask for "drinks"; venues name sections things that contain
no such word. Map the caller's word to the set of sections, and answer from all of them — answering
from whichever sorts first is how a whole section becomes invisible. Beware substrings when building
synonym lists: short words hide inside unrelated item names.

---

## Availability

Two different rules, and getting either backwards causes a distinct failure:

| Surface | Unavailable items | Why |
|---|---|---|
| **Overview / browse** — what the agent offers | **Excluded** | Never offer what cannot be sold |
| **Search / resolve** — what the caller named | **Included** | So it can be recognised and *refused by name* |

> **This is the whole fix, and it is counter-intuitive.** Filtering unavailable items out of the
> *search* is exactly what produced the silent substitution: the exact match vanished from the
> result set and the next-best remaining row was taken as if it were what the caller asked for.
> The matcher must see the item to be able to say "that one's off tonight."

Add a **margin** so a genuinely different item with a vaguely similar name does not block a
legitimate order — refuse only when the unavailable item is the clear best match.

**A substitution nobody agreed to is worse than a refusal.** The refusal is corrected on the call;
the substitution is discovered at the counter, after the money.

---

## Failure modes

### F1 · Silent substitution
**What broke:** a premium dish was switched off; a cheaper item whose name was a substring of it was
still on. The overview offered the premium dish, the caller ordered it, and the order silently
became the cheap side at **41% of the price**, while the agent said the premium dish's name
throughout.
**Two bugs, one incident:** the overview offered something unsellable, *and* the resolver
substituted instead of refusing. Fixing either alone leaves the other.
**Rules:** exclude unavailable from offers; include them in search; refuse by name.

### F2 · Nonsense match
See [Matching strategy](#matching-strategy). **Rule:** containment first, similarity second, no
exact float boundary.

### F3 · Internal representation spoken
See [the data contract](#the-model-facing-data-contract). **Rule:** the payload is speakable.

### F4 · Query that can never match
**What broke:** callers ask for "the menu" as a thing; the model passed it as an item search, which
cannot match any item name, producing a nonsense miss.
**Rule:** route generic queries to the overview before searching.

### F5 · Ignored parameter
**Rule:** implement every declared mode, and test each one through the tool boundary.

---

## Required tests

| # | Objective | Setup | Execution | Expected | Failure signal |
|---|---|---|---|---|---|
| 1 | Unavailable refused, not swapped | Premium item off; cheap substring item on | Order the premium item | Refused **by name**, no order | Cheaper item ordered |
| 2 | Unavailable not offered | Same | Ask what's available | Premium item absent | Offered then refused |
| 3 | Nonsense rejected | Menu with a beverage sharing letters with a common dish word | Search that dish word | No match, sections offered | Beverage offered |
| 4 | Near-miss kept | Item whose name contains a common style word | Search that word | Matches | Genuine hit dropped |
| 5 | Threshold has margin | Realistic query set | Score all | Nonsense below, genuine above | Bands overlap |
| 6 | Generic routed | — | Search "menu" | Overview | "Couldn't find menu" |
| 7 | Browse works | Multiple categories | Browse each | That section only | Generic overview |
| 8 | Prices speakable | Items across magnitudes | Read payload | Formatted money, no minor units | Integer present |
| 9 | No internals | Any lookup | Inspect payload | No ids, enums, URLs, scores | Any present |
| 10 | Bounded list | Menu with many sections | Overview | ≤3 named, then a question | Long recital |
| 11 | Ambiguity asked | Two similar names | Search | Asks which | Guesses |
| 12 | Duplicate names | Same name in two sections | Search | One question, distinguishable | "X or X?" |
