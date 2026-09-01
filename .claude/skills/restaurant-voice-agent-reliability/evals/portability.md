# Portability dry-run — a second, larger venue

Method: deploy an already-installed venue **on paper, using only `assets/new-restaurant-intake.md`**,
then diff the completed form against what the install actually required (runbook, venue SQL, menu
import CSVs, talk-track, and a code patch written for that venue).

## Headline

**Of ~25 template fields, 9 are cleanly answerable. 7 are placeholders the install pack itself
flags as unverified. 9 are absent.** The template covers the *conversation*. It does not cover the
*installation*.

## The five-input claim is false as stated

`SKILL.md` claims a new venue needs only menu, hours, ordering rules, payment rules, policies.
The real install also required, with **no template field for any of it**:

| Missing | Evidence it was needed |
|---|---|
| **Venue record** — legal name, address, owner, contact email, and the **transfer number** | The template asks *whether* to escalate; never asks **to what number**. That number is a real column. |
| **Telephony chain** — buy the number, regulatory bundle, SIP trunk, duplicate agent+LLM, import in webhook mode, bind | Four runbook steps → zero template fields. The framework's own tenancy doctrine depends on data the intake never collects. |
| **Call forwarding and who controls the venue's line** | *"If nobody in the building can log in, the install stops."* The hardest dependency of the whole install; the template does not know forwarding exists. |
| **Competing booking channels** | *"Is the online booking page off? If it is still live, she will double-book against bookings she cannot see."* Our entire double-booking test matrix is **void** if this is unasked. |
| **Access and identity** — who gets an owner seat, in which environment, which notifications are suppressed until go-live | Contact email deliberately NULL to stop go-live emails firing mid-install. |
| **Commercial terms** — plan, trial window, first charge, usage cap | §4 covers the *guest* paying the venue. The venue paying us is absent. |
| **Rollback, both sides, rehearsed** | The runbook has one. The sign-off does not ask for one. |
| **Greeting and disclosure wording, with the date it was verified by listening** | The talk-track flags the disclosure as not yet shipped. The template never asks for the greeting. |
| **Menu provenance** — source system, how same-named sections across menus are reconciled, duplicate policy | 6 rename/merge rulings, 31 duplicates skipped, 161 items with no description. All decided off-form. |

## Hidden first-venue assumptions the template smuggles in

1. **A table is the container for everything.** Strongest evidence: `ORDER_REQUIRES_BOOKING` was in
   shipped code, and a venue needing pickup-without-a-booking required a **code patch**. §3 lists
   tables and party size as unconditional rows with no "does this venue seat guests at all?" gate.
   Our own warning that *"a pickup is not a table"* is undone at intake.
2. **One menu.** Windows are a per-item afterthought. This venue has **six named menus**, each with
   its own hours and **the same section names recurring with different items** — which is exactly
   what forced the rename/merge rulings.
3. **A menu you can recite.** With **55 sections**, the unasked question is not "in what order" but
   **"which sections are voice-sellable at all"** — so 14 alcohol sections and a cigar menu entered
   the data with only a prompt sentence between them and a sale.
4. **Choices are required, small, and free.** Real structure: *optional* modifier groups, up to 21
   selectable, each carrying a price delta. No template row for a paid option or an optional one.
5. **One price per item.** Beer has three sizes plus a bucket; coffee has two. Venue #1 did not.
6. **Hours belong to the venue.** Kitchen, bar, late-night menu and the online ordering system imply
   four different closing times. The pack shipped a guess. **There is no provenance or confidence
   field, so a guess and a verified fact look identical in a completed form.**
7. **Restriction is a short list of items.** Here it is category-wide, regulatory, covers ~a fifth of
   the menu, and the correct behaviour is refuse **plus note it on the order**. We ask for wording,
   not for the compensating action.
8. **One phone number, and we control it.** This venue had **three in circulation and the wrong one
   published on its own website**.
9. **We are the only booking channel.**
10. **The platform already does what the venue needs.** No field records a capability gap — so a
    completed intake would never have surfaced "this venue needs pickup and the code refuses it."
11. **One schema version.** A second, cut-down menu file exists precisely because that was false.
12. **Payment exists.** `deployment.md`'s acceptance line — "book, order, pay, confirm" — **cannot be
    satisfied** by a venue that takes no phone payment.

## The reverse gap, which matters most

**Several template fields have nowhere to land.** Preparation time, closed dates, minimum notice,
maximum days ahead, caller words and section synonyms have **no column** in the settings table. A
diligently completed intake produces answers that can only become prompt prose — which our own
principle 1 calls a request, not a guarantee.

## Verdict

Portable for the **conversation design**. Not portable for **installation**. And the intake form is
currently the weakest artefact in the framework: it is the one file a new deployment starts from,
and it is the one that most assumes the first venue's shape.
