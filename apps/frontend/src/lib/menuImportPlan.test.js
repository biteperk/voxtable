import assert from "node:assert/strict";
import test from "node:test";

import {
  classifySelection,
  describeAddLimit,
  describeCommitBlock,
  describeFailure,
  describeImportSummary,
  describeJobFailure,
  describeReviewConcerns,
  describeStartOverConfirm,
  formatBytes,
  MENU_IMPORT_LIMITS,
  nextEncodeAttempt,
  orderFiles,
  pageListSentence,
  planPageBudget,
  progressCopy,
  scaleForViewport,
  summarisePages,
  validateSelection
} from "./menuImportPlan.js";

/**
 * The first frontend tests in this repo.
 *
 * They exist because the menu-import bug was not a crash — it was a chain of
 * decisions that were quietly wrong (a 20-second timeout on a six-minute
 * upload, a message that named the wrong cause). None of that needs a browser
 * to test, so none of it should have gone untested.
 */

const file = (name, size, type) => ({ name, size, type });
const MB = 1024 * 1024;

// ---------------------------------------------------------------------------
// What we accept — every rejection must fire before any network call
// ---------------------------------------------------------------------------

test("a normal menu PDF is accepted", () => {
  const r = validateSelection([file("menu.pdf", 12 * MB, "application/pdf")]);
  assert.equal(r.ok, true);
  assert.equal(r.kind, "pdf");
});

test("the incident file is accepted — 413 MB is our problem to solve, not the owner's", () => {
  // Rejecting it would just be the old behaviour with better wording. We render
  // it down instead; 600 MB is where the device genuinely can't cope.
  const r = validateSelection([file("COMIDAS 2026 FULL.pdf", 414 * MB, "application/pdf")]);
  assert.equal(r.ok, true);
});

test("a file too big to open is refused with its real size", () => {
  const r = validateSelection([file("huge.pdf", 700 * MB, "application/pdf")]);
  assert.equal(r.ok, false);
  assert.equal(r.code, "SOURCE_TOO_LARGE");
  assert.match(r.message, /700 MB/, "tell them how big it actually is");
  assert.match(r.message, /editor/, "and always offer the way out");
});

test("an unsupported type names the extension the owner picked", () => {
  const r = validateSelection([file("menu.docx", 2 * MB, "application/vnd.openxmlformats")]);
  assert.equal(r.ok, false);
  assert.equal(r.code, "UNSUPPORTED_TYPE");
  assert.match(r.message, /\.docx/);
  assert.match(r.message, /PDF/);
});

test("too many photos says how many and what to do", () => {
  const files = Array.from({ length: 20 }, (_, i) => file(`IMG_${i}.jpg`, MB, "image/jpeg"));
  const r = validateSelection(files);
  assert.equal(r.ok, false);
  assert.equal(r.code, "TOO_MANY_FILES");
  assert.match(r.message, /20 photos/);
});

test("mixing a PDF with photos is refused clearly", () => {
  const r = validateSelection([file("a.pdf", MB, "application/pdf"), file("b.jpg", MB, "image/jpeg")]);
  assert.equal(r.ok, false);
  assert.equal(r.code, "MIXED_SELECTION");
});

test("an empty selection never crashes", () => {
  assert.equal(validateSelection([]).ok, false);
  assert.equal(validateSelection(null).ok, false);
  assert.equal(validateSelection(undefined).ok, false);
});

test("files without a MIME type fall back to the extension", () => {
  // iOS share sheets and some Android pickers hand over an empty `type`.
  assert.equal(classifySelection([file("menu.pdf", MB, "")]).kind, "pdf");
  assert.equal(classifySelection([file("photo.HEIC", MB, "")]).kind, "single-image");
});

// ---------------------------------------------------------------------------
// Ordering — a wrong order silently scrambles the menu
// ---------------------------------------------------------------------------

test("photos are ordered the way a person numbered them", () => {
  const names = ["IMG_10.jpg", "IMG_2.jpg", "IMG_1.jpg"].map((n) => file(n, MB, "image/jpeg"));
  assert.deepEqual(orderFiles(names).map((f) => f.name), ["IMG_1.jpg", "IMG_2.jpg", "IMG_10.jpg"]);
});

// ---------------------------------------------------------------------------
// Page budgeting
// ---------------------------------------------------------------------------

test("a 12-page menu renders every page with room to spare", () => {
  const plan = planPageBudget({ pageCount: 12 });
  assert.equal(plan.pagesToRender, 12);
  assert.equal(plan.truncatedFrom, null);
  // Measured on the real menu: ~325 KB/page at 150 DPI. The budget must not
  // force degradation on an ordinary menu.
  assert.ok(plan.perPageBudgetBytes > 400 * 1024, "a normal page should never need degrading");
});

test("a 48-page menu still gives each page a workable budget", () => {
  const plan = planPageBudget({ pageCount: 48 });
  assert.equal(plan.pagesToRender, 48);
  assert.ok(plan.perPageBudgetBytes >= MENU_IMPORT_LIMITS.MIN_PAGE_BUDGET_BYTES);
  assert.ok(plan.perPageBudgetBytes > 325 * 1024, "still above what a real page measures");
});

test("a menu longer than the cap is truncated and reported, never silently", () => {
  const plan = planPageBudget({ pageCount: 60 });
  assert.equal(plan.pagesToRender, MENU_IMPORT_LIMITS.MAX_PAGES);
  assert.equal(plan.truncatedFrom, 60);
  assert.match(progressCopy({ phase: "truncated", truncatedFrom: 60 }), /60 pages/);
  assert.match(progressCopy({ phase: "truncated", truncatedFrom: 60 }), /editor/);
});

test("the page cap matches the backend's", () => {
  // Drift here means the client uploads pages the server then refuses.
  assert.equal(MENU_IMPORT_LIMITS.MAX_PAGES, 48);
});

test("a single page is handled without dividing by zero", () => {
  const plan = planPageBudget({ pageCount: 1 });
  assert.equal(plan.pagesToRender, 1);
  assert.ok(plan.perPageBudgetBytes > 0);
  assert.equal(planPageBudget({ pageCount: 0 }).pagesToRender, 0);
});

// ---------------------------------------------------------------------------
// The degradation ladder
// ---------------------------------------------------------------------------

test("a page inside budget is accepted immediately", () => {
  const r = nextEncodeAttempt({ attempt: 1, bytes: 300 * 1024, budgetBytes: 500 * 1024, longEdgePx: 1800, quality: 0.82 });
  assert.equal(r.done, true);
  assert.equal(r.quality, 0.82, "no needless quality loss");
});

test("quality is sacrificed before resolution", () => {
  const r = nextEncodeAttempt({ attempt: 1, bytes: 900 * 1024, budgetBytes: 500 * 1024, longEdgePx: 1800, quality: 0.82 });
  assert.equal(r.done, false);
  assert.ok(r.quality < 0.82, "quality drops first");
  assert.equal(r.longEdgePx, 1800, "pixels are kept — lost pixels lose prices");
});

test("resolution only drops once quality has bottomed out", () => {
  const r = nextEncodeAttempt({
    attempt: 2,
    bytes: 900 * 1024,
    budgetBytes: 500 * 1024,
    longEdgePx: 1800,
    quality: MENU_IMPORT_LIMITS.MIN_QUALITY
  });
  assert.equal(r.done, false);
  assert.ok(r.longEdgePx < 1800);
  assert.equal(r.quality, MENU_IMPORT_LIMITS.MIN_QUALITY);
});

test("the ladder always terminates and never goes below the floors", () => {
  let state = { longEdgePx: 1800, quality: 0.82 };
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const r = nextEncodeAttempt({ attempt, bytes: 99 * MB, budgetBytes: 1024, ...state });
    state = { longEdgePx: r.longEdgePx, quality: r.quality };
    assert.ok(r.quality >= MENU_IMPORT_LIMITS.MIN_QUALITY, "never below the quality floor");
    assert.ok(r.longEdgePx >= MENU_IMPORT_LIMITS.MIN_LONG_EDGE_PX, "never below the resolution floor");
    if (r.done) return;
  }
  assert.fail("the ladder must terminate");
});

test("an impossible budget still yields a page rather than nothing", () => {
  const r = nextEncodeAttempt({
    attempt: MENU_IMPORT_LIMITS.MAX_ENCODE_ATTEMPTS,
    bytes: 99 * MB,
    budgetBytes: 1,
    longEdgePx: 1200,
    quality: 0.65
  });
  assert.equal(r.done, true, "a slightly heavy page beats no menu at all");
});

// ---------------------------------------------------------------------------
// Viewport scaling
// ---------------------------------------------------------------------------

test("A4 scales to the verified 150 DPI target", () => {
  // A4 is 595 x 842 pt. 1800/842 ≈ 2.14, which is the ~150 DPI I checked by eye.
  const scale = scaleForViewport({ widthPt: 595, heightPt: 842, targetLongEdgePx: 1800 });
  assert.ok(Math.abs(scale - 2.138) < 0.01, `expected ~2.14, got ${scale}`);
  assert.ok(Math.round(842 * scale) <= 1801);
});

test("landscape pages scale off their long edge too", () => {
  const scale = scaleForViewport({ widthPt: 842, heightPt: 595, targetLongEdgePx: 1800 });
  assert.ok(Math.abs(scale - 2.138) < 0.01);
});

test("a degenerate viewport doesn't produce Infinity", () => {
  assert.equal(scaleForViewport({ widthPt: 0, heightPt: 0, targetLongEdgePx: 1800 }), 1);
});

// ---------------------------------------------------------------------------
// Copy — the actual incident was a copy failure
// ---------------------------------------------------------------------------

test("no message ever claims the feature is unavailable when it isn't", () => {
  // The exact sentence the owner was shown. It must not come back.
  const everything = [
    ...["validating", "preparing", "uploading", "parsing", "committing"].map((phase) =>
      progressCopy({ phase, page: 1, pageCount: 12, percent: 40 })
    ),
    describeFailure(new Error("boom")),
    describeFailure({ code: "storage/retry-limit-exceeded" }),
    describeJobFailure({ status: "failed" })
  ];
  for (const message of everything) {
    assert.doesNotMatch(message, /isn't available right now/i, `bad copy: ${message}`);
  }
});

test("progress names the page being worked on", () => {
  assert.equal(progressCopy({ phase: "preparing", page: 3, pageCount: 12 }), "Preparing page 3 of 12…");
  assert.equal(progressCopy({ phase: "uploading", percent: 42.4 }), "Uploading… 42%");
});

test("a long menu warns that reading takes a while", () => {
  assert.match(progressCopy({ phase: "parsing", pageCount: 12 }), /can take a minute/);
  assert.doesNotMatch(progressCopy({ phase: "parsing", pageCount: 1 }), /minute/);
});

test("technical failures are translated, never echoed", () => {
  assert.match(describeFailure({ name: "PasswordException" }), /password-protected/);
  assert.match(describeFailure({ name: "InvalidPDFException" }), /damaged/);
  assert.match(describeFailure({ code: "HEIC_UNSUPPORTED" }), /JPEG/);
  assert.match(describeFailure({ code: "storage/unauthorized" }), /verified/);
  assert.match(describeFailure({ code: "UPLOAD_STALLED" }), /connection/);
});

test("a raw parser error never reaches the owner", () => {
  // This is the literal string production showed a restaurant owner.
  const shown = describeFailure(new SyntaxError("Unexpected end of JSON input"));
  assert.doesNotMatch(shown, /JSON/i);
  assert.doesNotMatch(shown, /SyntaxError/i);
  assert.match(shown, /editor/, "always leave a way forward");
  assert.doesNotMatch(describeJobFailure({ status: "failed", last_error: "Unexpected token < in JSON" }), /JSON/i);
});

test("backend messages already written for people are passed through", () => {
  const msg = "You've reached today's menu-import limit. Please try again tomorrow or add items manually.";
  assert.equal(describeFailure({ code: "MENU_OCR_RATE_LIMITED", message: msg }), msg);
});

// ---------------------------------------------------------------------------
// The review screen.
//
// A real import read 59 of 65 items — one whole page produced nothing — and the
// screen said "everything looked clear". These tests exist to make that sentence
// unsayable again.
// ---------------------------------------------------------------------------

const page = (n, status) => ({ page: n, status, items: status === "items" ? 3 : 0 });
const CLEAN = [1, 2, 3, 4, 5].map((n) => page(n, "items"));
const MISSED_ONE = [page(1, "items"), page(2, "items"), page(3, "unverified"), page(4, "items")];
const UNREADABLE_ONE = [page(1, "items"), page(2, "items"), page(3, "items"), page(4, "unread")];

/** Every shape the headline can take, so the negative assertions cover them all. */
const ALL_HEADLINES = [
  describeImportSummary({ itemCount: 59, pageResults: [] }),
  describeImportSummary({ itemCount: 1, pageResults: [] }),
  describeImportSummary({ itemCount: 59, pageResults: CLEAN }),
  describeImportSummary({ itemCount: 59, pageResults: MISSED_ONE }),
  describeImportSummary({ itemCount: 59, pageResults: UNREADABLE_ONE }),
  describeImportSummary({ itemCount: 59, pageResults: [...MISSED_ONE, page(9, "unread")] })
];

test("no headline ever promises the menu is complete", () => {
  for (const line of ALL_HEADLINES) {
    assert.doesNotMatch(line, /everything looked clear/i, line);
    assert.doesNotMatch(line, /all clear|nothing missing|got everything/i, line);
  }
});

test("every headline says the list is the limit of what the agent knows", () => {
  for (const line of ALL_HEADLINES) {
    assert.match(line, /only know the dishes on this list/, line);
  }
});

test("an import with no page information makes no claim about pages", () => {
  const line = describeImportSummary({ itemCount: 59, pageResults: [] });
  assert.doesNotMatch(line, /all \d+ pages/, "unknown must never be reported as clean");
  assert.match(line, /59 items/);
});

test("a clean multi-page import says how many pages it actually read", () => {
  assert.match(describeImportSummary({ itemCount: 59, pageResults: CLEAN }), /across all 5 pages/);
});

test("a page that produced nothing is named in the headline", () => {
  const line = describeImportSummary({ itemCount: 59, pageResults: MISSED_ONE });
  assert.match(line, /page 3/);
  assert.match(line, /nothing/);
});

test("an unreadable page is named, and reads differently from an empty one", () => {
  const unread = describeImportSummary({ itemCount: 59, pageResults: UNREADABLE_ONE });
  const missed = describeImportSummary({ itemCount: 59, pageResults: MISSED_ONE });
  assert.match(unread, /page 4/);
  assert.match(unread, /wouldn't read/);
  assert.notEqual(unread, missed, "the two failures must not be described identically");
});

test("a cover page the parser confirmed is never reported as a problem", () => {
  // The prompt tells the model to return nothing for covers and photo pages.
  // Reporting those trains owners to ignore the notice that matters.
  const withCover = [page(1, "empty_confirmed"), page(2, "items"), page(3, "items")];
  assert.match(describeImportSummary({ itemCount: 22, pageResults: withCover }), /across all 3 pages/);
  assert.deepEqual(describeReviewConcerns({ pageResults: withCover }), []);
});

test("a page recovered on the second pass is not reported as a problem", () => {
  const recovered = [page(1, "items"), page(2, "recovered"), page(3, "items")];
  assert.deepEqual(describeReviewConcerns({ pageResults: recovered }), []);
});

test("items with no price are called out with the consequence, not just a count", () => {
  const one = describeReviewConcerns({ pageResults: CLEAN, unpricedCount: 1 });
  assert.match(one.join(" "), /free/, "the owner needs to know Bella will say it's free");
  assert.match(one.join(" "), /1 item has/);
  const many = describeReviewConcerns({ pageResults: CLEAN, unpricedCount: 3 });
  assert.match(many.join(" "), /3 items have/);
});

test("a clean import has nothing to acknowledge", () => {
  assert.deepEqual(describeReviewConcerns({ pageResults: CLEAN, unpricedCount: 0 }), []);
  assert.deepEqual(describeReviewConcerns({ pageResults: [], unpricedCount: 0 }), []);
  assert.deepEqual(describeReviewConcerns(), []);
});

test("concerns put the worst thing first", () => {
  const mixed = [page(1, "unread"), page(2, "unverified"), page(3, "items")];
  const lines = describeReviewConcerns({ pageResults: mixed, unpricedCount: 2 });
  assert.match(lines[0], /couldn't read/, "a page we never read outranks one that came back empty");
  assert.match(lines[1], /got nothing/);
  assert.match(lines[2], /free/);
});

test("no page is silently dropped from the concerns list", () => {
  const many = [1, 2, 3, 4, 5, 6].map((n) => page(n, "unverified"));
  const lines = describeReviewConcerns({ pageResults: many });
  assert.equal(lines.length, 5, "four pages plus an honest count of the rest");
  assert.match(lines[4], /2 more pages/);
});

test("page lists read like a sentence", () => {
  assert.equal(pageListSentence([3]), "page 3");
  assert.equal(pageListSentence([3, 7]), "pages 3 and 7");
  assert.equal(pageListSentence([7, 3, 11]), "pages 3, 7 and 11");
  assert.equal(pageListSentence([11, 2, 3, 7]), "pages 2, 3, 7 and 1 other");
  assert.equal(pageListSentence([]), "");
});

test("pages we know nothing about are not counted as read", () => {
  assert.equal(summarisePages([]).hasInfo, false);
  assert.equal(summarisePages([]).allAccounted, true, "vacuously true — hasInfo is the guard");
  assert.equal(summarisePages(MISSED_ONE).allAccounted, false);
  assert.deepEqual(summarisePages(MISSED_ONE).missed, [3]);
  assert.deepEqual(summarisePages(UNREADABLE_ONE).unreadable, [4]);
});

test("only a blank name blocks the import — everything else is acknowledged", () => {
  assert.equal(describeCommitBlock({}), null);
  assert.equal(describeCommitBlock({ unnamedCount: 0, unnamedCategoryCount: 0 }), null);
  assert.match(describeCommitBlock({ unnamedCount: 1 }), /One row still has no name/);
  assert.match(describeCommitBlock({ unnamedCount: 3 }), /3 rows/);
  assert.match(describeCommitBlock({ unnamedCategoryCount: 1 }), /section/);
});

test("starting over says exactly what will be lost", () => {
  assert.match(describeStartOverConfirm(59), /59 items/);
  assert.match(describeStartOverConfirm(59), /anything you've added/);
  assert.match(describeStartOverConfirm(1), /1 item I read/);
});

test("hitting an add limit points at where the rest can go", () => {
  assert.match(describeAddLimit("item"), /Manage menu/);
  assert.match(describeAddLimit("item"), new RegExp(String(MENU_IMPORT_LIMITS.MAX_ITEMS_PER_CATEGORY)));
  assert.match(describeAddLimit("category"), new RegExp(String(MENU_IMPORT_LIMITS.MAX_CATEGORIES)));
});

test("byte formatting reads like a person wrote it", () => {
  assert.equal(formatBytes(413.6 * MB), "414 MB");
  assert.equal(formatBytes(3.9 * MB), "3.9 MB");
  assert.equal(formatBytes(325 * 1024), "325 KB");
  assert.equal(formatBytes(-5), "0 MB");
});
