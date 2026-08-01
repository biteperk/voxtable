# Menu corpus

Real menus, with what they actually say written down by a person. `npm run smoke:menu-ocr`
reads them with the live parser and fails if the result drifts.

This exists because unit tests can prove the *plumbing* — that a missed page is detected
and reported — but not that the model reads the page. Only real calls can. The first
fixture is the import that started it: five pages, page 3 came back empty, six priced
dishes lost, and the owner was told "everything looked clear".

It is also the only honest way to evaluate a cheaper or different model. `MENU_OCR_PROVIDER`
already accepts any OpenAI-compatible host, and open-weight vision models are 10–20× cheaper
— but swapping one in without a corpus means gambling on live customers.

## Running it

```bash
npm run smoke:menu-ocr                    # everything
npm run smoke:menu-ocr -- --menu=<slug>   # one menu
npm run smoke:menu-ocr -- --json          # machine-readable
```

Needs `MENU_OCR_API_KEY` (plus `MENU_OCR_PROVIDER` / `BASE_URL` / `MODEL`) in your `.env`.
Deliberately **not** in `npm run check` — it costs real money and needs a key, and the
gate on every branch must do neither.

## What it asserts, worst-first

1. **No page that should have items comes back empty.** This is the incident, and it is
   assertion one.
2. **Every named dish is present at exactly the printed price.** Names match loosely
   (case, punctuation, substring); prices must be exact. A wrong price is worse than a
   missing dish — it is what Bella reads aloud.
3. **The item total sits between a floor and a ceiling.** A floor because a model
   splitting "Tea / Coffee" into two rows is not a regression. A ceiling because
   over-extraction — inventing rows, promoting variants to dishes — is also a wrong menu,
   and a floor-only test is blind to it.
4. **Page accounting is complete**, and no page is left unaccounted for.
5. **No dish priced at $0.** Bella would tell callers it is free.
6. **Confidence is not constant across the corpus.** Costs nothing, and is exactly what
   would have caught "every one of the 59 rows reported confidence 1.0".

## Adding a menu

1. **Permission and redaction.** A real customer's menu is their property. Get written
   permission, or redact the venue name, phone, address and logo and rename the fixture.
   Say which in `expected.json.source`.

2. **Render through the production path.** 1800px long edge, JPEG quality 0.82 — the exact
   settings the browser uses (`MENU_IMPORT_LIMITS` in `apps/frontend/src/lib/menuImportPlan.js`).
   A fixture rendered at a different resolution tests something we never ship.

   ```bash
   pdftoppm -png -r 300 menu.pdf /tmp/p
   for f in /tmp/p-*.png; do
     n=$(basename "$f" .png | sed 's/p-//')
     sips -Z 1800 -s format jpeg -s formatOptions 82 "$f" --out "pages/0$n.jpg"
   done
   ```

   About 325 KB per page. Images are committed to git on purpose: a corpus whose inputs
   can drift is not a golden corpus.

3. **Write `expected.json` by reading the printed menu.** Not by running the parser and
   saving what it said. This is the one rule that keeps the corpus honest — a bootstrap
   from today's output bakes today's misses in as the definition of correct, and the
   corpus becomes a machine for certifying the bug. The harness refuses to run a fixture
   with `null` expectations for exactly this reason.

4. **Pick 3–8 dishes for `must_include`**, favouring: the cheapest and the most expensive,
   one with an awkward price format, one on the last page, and one on a page with photos
   or two columns.

## Coverage to aim for

One menu can satisfy several. Listed so the gaps are visible:

- [x] landscape multi-column layout
- [x] every item on a page priced identically (a trap for "that looks wrong" heuristics)
- [x] an item page styled like a cover — wordmark, welcome line, photos, contact footer
- [x] handwritten/script type
- [x] prices without a currency symbol (`99.-`)
- [ ] a single phone photo — skewed, shadowed, hand-held
- [ ] a 12+ page designed PDF (multi-batch: exercises merge and carry-forward)
- [ ] a genuine cover page and a full-page-photo page (guards against false alarms)
- [ ] a category heading straddling a page break
- [ ] a chalkboard / specials board
- [ ] a bilingual menu (the no-multilingual rule governs the voice agent, not the print)
- [ ] variants with negative deltas (kids portions — once failed an entire import)
