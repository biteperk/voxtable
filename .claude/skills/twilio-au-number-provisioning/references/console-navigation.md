# Where the Twilio console fights you

Observed hands-on. None of these produce a useful error message, which is why they're worth
writing down — each one looks like something else.

## Don't guess URLs

Several plausible paths 404 (`/elastic-sip-trunking/trunks`, `/sip-trunking/trunks`,
`/messaging/services`). The console is a shell around iframed legacy apps and the routes are not
what you'd expect.

**Use the console search** (magnifier, top bar) and type the product name — "Elastic SIP",
"Messaging Services". It returns navigable results reliably. Faster than guessing, and much
faster than clicking through the left nav, where Elastic SIP Trunking does *not* appear under
Voice despite living there.

Working paths, for reference:

```
/account/{AC}/us1/senders-hub/list/phone-numbers/inventory
/account/{AC}/us1/senders-hub/phone-numbers/{PN}/configure/routing?tab=active-region
/account/{AC}/{region}/voice/sip-trunking/trunks
/account/{AC}/{region}/sip-trunking/{TK}/sip-trunking-{general|termination|origination|numbers}
/account/{AC}/us1/messaging/messaging-services/{MG}/senders
/account/{AC}/us1/phone-numbers/regulatory-compliance/bundles
/account/{AC}/us1/trusthub/compliance-addresses
```

## Sticky footers hide form fields

Legacy pages render inside an iframe with a sticky Save/Cancel bar pinned to the bottom. When the
panel is short, that bar **covers the last form field** and no amount of page scrolling moves it —
the footer scrolls with the content.

`find` and `read_page` don't help: the accessibility tree doesn't reach into the iframe, so
element refs are unavailable and you're stuck with coordinates.

What works: make the browser window taller (but note that resizing narrower makes it worse — the
viewport letterboxes). What doesn't: zooming with cmd+minus is typically blocked. If a field
remains unreachable, ask whether you actually need it — the Termination URI turned out to be
unnecessary for an inbound-only architecture, so the blocker was moot.

## Region selectors are per-product and sticky

Elastic SIP Trunking, Messaging and the number's own configuration each have their own region
selector. A trunk's region is fixed at creation. Set the region **before** creating anything.

The number's active region is the one that gates trunk visibility. See the main SKILL.md — this
is the highest-cost trap in the whole workflow.

## "Session paused"

> *"We've paused your session while you used a different account SID in another tab."*

Having two Twilio tabs open on different accounts pauses whichever you return to. Harmless —
click *Reload current page* — but it interrupts multi-step flows. Close other Twilio tabs before
a provisioning run.

## Empty filters throw

The trunk's "Add a number" picker throws *"Invalid Pattern Provided: ."* on an empty filter.
Type the E.164 digits before clicking Filter.

## Banners that aren't true

- *"No saved addresses?"* appears even when the account has several validated addresses. It's a
  static help prompt, not a check. Open the dropdown before creating a duplicate.
- *"We'll use this number to queue up required compliance registration. After registration is
  approved you'll be able to purchase this number."* is boilerplate on the review screen and
  appears even when your registration is already approved.
- The notification email says **"Approved"**; the console says **"Accepted"**. Same state.

## The number search index is stale

Search results include numbers that are already sold, and nothing is reserved between selection
and payment. Combined with a multi-step compliance checkout, this means a number can vanish
mid-flow — twice in one session, on vanity patterns.

Mitigation: search the unfiltered pool, take the first available result, and move quickly. Treat
any specific pattern as best-effort.

## The search form jams after a lost number

Confirmed on both accounts. After *"has been purchased by another customer"*, the search form
enters a disabled state: Number type greyed out, Search Criteria reverted to a greyed "Locality".
No error is shown and no amount of clicking recovers it.

**Fix:** reload `…/senders-onboarding?setupGuide=true` fresh. Account-level compliance persists,
so the retry costs ~30 seconds.

**Then wait for the form to render before typing.** The fresh wizard loads with Destination
country defaulted to United States and silently discards input sent before hydration — you'll
type "Australia", it will still say United States, and the search will return US numbers.

## Feedback pop-ups overlay the table

"Help us improve your regional experience" appears over the inventory list and intercepts clicks.
Dismiss it before interacting with rows.
