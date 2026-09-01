# Evaluation rubric — declared BEFORE any run

Three scenarios, each run twice: **baseline** (own knowledge, no skill) vs **treatment** (skill
invoked). Same task text both times. Scored against the criteria below, fixed in advance.

A criterion scores only if the response states it substantively — naming the risk and what to do.
A passing mention of a related word does not score.

## S1 · Payment confirmation design (8 points)
1. Reads payment state from the primary, not a replica
2. At least three states — an in-flight payment is neither success nor failure
3. Announce-once enforced by an atomic claim / datastore, not by prompt instruction
4. Selects the most recent attempt, not "the active one"
5. A bounded check ceiling, then a graceful alternative
6. Server-side reconciliation when the call ends — a hang-up reaches no prompt
7. The check counter is logged and asserted
8. A refund path (or written manual procedure) before real money

## S2 · Transcript diagnosis (6 points)
1. Counts/notices the repetition explicitly
2. Attributes it to **multiple existing instructions**, not a missing "don't repeat" rule
3. Recommends **deleting/merging** instructions rather than adding one
4. Links the long turn to the talking-over (one incident, not two)
5. Flags the wasted turn / lost momentum
6. Proposes a measurable check rather than a stylistic note

## S3 · Takeaway flow design (6 points)
1. Pickup consumes no table capacity
2. Dine-in duration must not apply to pickup
3. Party size is not a pickup field
4. "Now" is validated against opening hours, and refusal cites the real reason
5. An explicit procedure exists so the model cannot improvise the gap
6. Ready-by time derived from preparation time

## Reporting rules
- Report the honest score even where the skill wins narrowly or loses.
- Note anything the **baseline** produced that the skill lacks — that is a gap to fix, not noise.
- A win only counts if the treatment's extra criteria are ones that caused real incidents.
