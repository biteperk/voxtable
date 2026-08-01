/**
 * Menu import — the decisions, with no browser in them.
 *
 * Everything here is pure so it can be unit-tested: what we accept, how big a
 * page may be, how we degrade when one is too big, and every sentence the owner
 * reads. `menuImportPrepare.js` does the canvas and pdf.js work and asks this
 * module what to do.
 *
 * Written after a real menu — 12 pages, 413 MB, exported from Photoshop —
 * failed to upload and told the owner "photo import isn't available right now".
 * It was available. The upload had timed out after 20 seconds on a file that
 * needed six minutes, and the message sent them somewhere else entirely.
 *
 * Measured on that file: re-rendered at 150 DPI the whole menu is 3.9 MB and
 * the text is still perfectly legible. That is the entire idea here — shrink it
 * on the device, before a byte goes anywhere.
 */

export const MENU_IMPORT_LIMITS = {
  /** Past this we can't reliably even open the file on a phone. */
  MAX_SOURCE_BYTES: 600 * 1024 * 1024,
  /** Photos selected at once. A PDF is one file with many pages. */
  MAX_FILES: 12,
  /** Must match MENU_INGEST_MAX_PAGES on the backend. */
  MAX_PAGES: 48,
  /**
   * Must match menuDraftSchema on the backend. Enforced here so that adding a
   * 121st dish disables the button, rather than failing the save with a zod
   * message no restaurant owner can act on.
   */
  MAX_CATEGORIES: 40,
  MAX_ITEMS_PER_CATEGORY: 120,
  /** Ceiling on the whole upload, to bound how long it takes on mobile data. */
  TOTAL_BUDGET_BYTES: 24 * 1024 * 1024,
  /** No single page may exceed this — comfortably under the 10 MB storage cap. */
  MAX_PAGE_BYTES: 1.5 * 1024 * 1024,
  /** Below this, quality is bad enough that OCR starts losing prices. */
  MIN_PAGE_BUDGET_BYTES: 200 * 1024,
  /** ~150 DPI on A4. The resolution verified legible on the real menu. */
  TARGET_LONG_EDGE_PX: 1800,
  MIN_LONG_EDGE_PX: 1200,
  INITIAL_QUALITY: 0.82,
  MIN_QUALITY: 0.65,
  MAX_ENCODE_ATTEMPTS: 3,
  /** pdf.js keeps fetched chunks for the document's life; reopen to drop them. */
  REOPEN_EVERY_N_PAGES: 6
};

const IMAGE_TYPES = /^image\/(jpeg|jpg|png|webp|heic|heif)$/i;
const PDF_TYPE = /^application\/pdf$/i;

/** Bytes → "413.6 MB", for messages the owner reads. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 MB";
  const mb = bytes / 1024 / 1024;
  if (mb >= 10) return `${Math.round(mb)} MB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function isPdf(file) {
  return PDF_TYPE.test(file.type || "") || /\.pdf$/i.test(file.name || "");
}

function isImage(file) {
  return IMAGE_TYPES.test(file.type || "") || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name || "");
}

/**
 * What did the owner give us?
 *   single-image → upload as-is (downscaled), source_kind "image"
 *   multi-image / pdf → render to pages, source_kind matches
 *   unsupported → rejected before any network call
 */
export function classifySelection(files) {
  const list = [...(files ?? [])];
  if (list.length === 0) return { kind: "empty", files: [] };
  if (list.length === 1 && isPdf(list[0])) return { kind: "pdf", files: list };
  if (list.some(isPdf) && list.length > 1) return { kind: "mixed", files: list };
  if (list.every(isImage)) {
    return { kind: list.length === 1 ? "single-image" : "multi-image", files: orderFiles(list) };
  }
  return { kind: "unsupported", files: list };
}

/**
 * Sort photos the way a person numbered them: IMG_2 before IMG_10.
 * A plain string sort puts IMG_10 first, which silently reorders a menu.
 */
export function orderFiles(files) {
  return [...files].sort((a, b) =>
    String(a.name ?? "").localeCompare(String(b.name ?? ""), undefined, { numeric: true, sensitivity: "base" })
  );
}

/** The extension, for a message that names what they actually picked. */
function extensionOf(file) {
  const match = /\.([a-z0-9]+)$/i.exec(file?.name ?? "");
  return match ? `.${match[1].toLowerCase()}` : null;
}

/**
 * The gate. Runs BEFORE anything touches the network, so a wrong file produces
 * an instant, specific answer instead of a slow, misleading one.
 *
 * Returns { ok: true } or { ok: false, code, message }.
 */
export function validateSelection(files) {
  const list = [...(files ?? [])];
  const { MAX_SOURCE_BYTES, MAX_FILES } = MENU_IMPORT_LIMITS;

  if (list.length === 0) {
    return { ok: false, code: "NO_FILE", message: "No file selected." };
  }

  const classification = classifySelection(list);

  if (classification.kind === "unsupported") {
    const ext = list.map(extensionOf).find(Boolean);
    return {
      ok: false,
      code: "UNSUPPORTED_TYPE",
      message: ext
        ? `I can read photos (JPG, PNG) and PDFs. ${ext} files aren't supported — try exporting it as a PDF.`
        : "I can read photos (JPG, PNG) and PDFs. That file type isn't supported."
    };
  }

  if (classification.kind === "mixed") {
    return {
      ok: false,
      code: "MIXED_SELECTION",
      message: "Please upload either one PDF or a set of photos — not both at once."
    };
  }

  if (list.length > MAX_FILES) {
    return {
      ok: false,
      code: "TOO_MANY_FILES",
      message: `That's ${list.length} photos — I can take up to ${MAX_FILES} at once. Upload them in two batches, or send a PDF.`
    };
  }

  const total = list.reduce((n, f) => n + (f.size ?? 0), 0);
  if (total > MAX_SOURCE_BYTES) {
    return {
      ok: false,
      code: "SOURCE_TOO_LARGE",
      message: `That file is ${formatBytes(total)} — too big to open on this device. Export a smaller PDF, or add your menu in the editor.`
    };
  }

  return { ok: true, kind: classification.kind, files: classification.files };
}

/**
 * How many pages to render and how many bytes each may use.
 *
 * The budget is per page rather than one lump because each page is uploaded as
 * its own file — the storage size limit applies to each, not the total. The
 * total ceiling exists only to keep the upload quick on mobile data.
 *
 * A menu longer than MAX_PAGES is truncated and the owner is TOLD (see
 * progressCopy) — never silently cut short.
 */
export function planPageBudget({ pageCount }) {
  const { MAX_PAGES, TOTAL_BUDGET_BYTES, MAX_PAGE_BYTES, MIN_PAGE_BUDGET_BYTES, TARGET_LONG_EDGE_PX, INITIAL_QUALITY } =
    MENU_IMPORT_LIMITS;

  const requested = Math.max(0, Math.floor(pageCount || 0));
  const pagesToRender = Math.min(requested, MAX_PAGES);
  const truncatedFrom = requested > MAX_PAGES ? requested : null;

  const share = pagesToRender > 0 ? TOTAL_BUDGET_BYTES / pagesToRender : MAX_PAGE_BYTES;
  const perPageBudgetBytes = Math.max(MIN_PAGE_BUDGET_BYTES, Math.min(MAX_PAGE_BYTES, share));

  return {
    pagesToRender,
    truncatedFrom,
    perPageBudgetBytes,
    targetLongEdgePx: TARGET_LONG_EDGE_PX,
    initialQuality: INITIAL_QUALITY
  };
}

/**
 * A page came out too big — what next?
 *
 * Quality first, resolution second. Text survives JPEG ringing far better than
 * it survives lost pixels, and losing pixels is what makes a price unreadable.
 * Gives up after MAX_ENCODE_ATTEMPTS and accepts the smallest result: a slightly
 * heavy page is much better than no menu.
 */
export function nextEncodeAttempt({ attempt, bytes, budgetBytes, longEdgePx, quality }) {
  const { MAX_ENCODE_ATTEMPTS, MIN_QUALITY, MIN_LONG_EDGE_PX } = MENU_IMPORT_LIMITS;

  if (bytes <= budgetBytes) return { done: true, longEdgePx, quality };
  if (attempt >= MAX_ENCODE_ATTEMPTS) return { done: true, longEdgePx, quality };

  if (quality > MIN_QUALITY) {
    return { done: false, longEdgePx, quality: Math.max(MIN_QUALITY, Number((quality - 0.1).toFixed(2))) };
  }
  if (longEdgePx > MIN_LONG_EDGE_PX) {
    return { done: false, longEdgePx: Math.max(MIN_LONG_EDGE_PX, Math.round(longEdgePx * 0.8)), quality };
  }
  return { done: true, longEdgePx, quality };
}

/**
 * pdf.js viewport scale to hit the target pixel size.
 * Works in points (1/72") because DPI is meaningless without page dimensions —
 * an A4 page and a US-Letter page at "150 DPI" are different pixel counts.
 */
export function scaleForViewport({ widthPt, heightPt, targetLongEdgePx }) {
  const longEdgePt = Math.max(widthPt || 0, heightPt || 0);
  if (longEdgePt <= 0) return 1;
  return targetLongEdgePx / longEdgePt;
}

// ---------------------------------------------------------------------------
// Copy. All of it lives here so it can be tested and reviewed in one place.
// ---------------------------------------------------------------------------

export function progressCopy({ phase, page, pageCount, percent, truncatedFrom }) {
  switch (phase) {
    case "validating":
      return "Checking your file…";
    case "preparing":
      return pageCount > 1 ? `Preparing page ${page} of ${pageCount}…` : "Preparing your menu…";
    case "preparing-photos":
      return pageCount > 1 ? `Preparing photo ${page} of ${pageCount}…` : "Preparing your photo…";
    case "uploading":
      return Number.isFinite(percent) ? `Uploading… ${Math.round(percent)}%` : "Uploading…";
    case "parsing":
      return pageCount > 4
        ? `Reading your menu — a ${pageCount}-page menu can take a minute.`
        : "Reading your menu…";
    case "committing":
      return "Saving your menu…";
    case "truncated":
      return `Your PDF has ${truncatedFrom} pages — I'll read the first ${MENU_IMPORT_LIMITS.MAX_PAGES}. You can add the rest in the editor.`;
    default:
      return "Working…";
  }
}

/**
 * Turn any thrown thing into something the owner can act on.
 *
 * Deliberately never returns the raw error: the message that started all this
 * was a real one, and "Unexpected end of JSON input" is not a sentence a
 * restaurant owner should ever be shown.
 */
export function describeFailure(error) {
  const code = error?.code ?? "";
  const name = error?.name ?? "";
  const message = String(error?.message ?? "");

  // Backend errors already written for people — pass them through.
  if (code === "MENU_OCR_DISABLED" || code === "MENU_OCR_RATE_LIMITED" || code === "MENU_TOO_MANY_PAGES") {
    return message || "Menu import isn't available right now.";
  }
  if (code === "RATE_LIMITED") {
    return "You're uploading menus too quickly — please wait a moment and try again.";
  }
  if (code === "MENU_OCR_NO_ITEMS") {
    return message || "I couldn't find any dishes on that menu. Add your items in the editor and I'll learn them.";
  }

  // Firebase Storage. A size rejection surfaces as "unauthorized" too, but the
  // client checks size first, so reaching here means the email isn't verified.
  if (code === "storage/unauthorized") {
    return "Your email isn't verified yet — verify it and I'll be able to read your menu.";
  }
  if (code === "storage/canceled") return "Upload cancelled.";
  if (code === "storage/retry-limit-exceeded" || code === "UPLOAD_STALLED") {
    return "Upload stopped — check your connection and try again.";
  }

  // pdf.js
  if (name === "PasswordException") {
    return "That PDF is password-protected. Remove the password and try again, or add your menu in the editor.";
  }
  if (name === "InvalidPDFException" || /invalid pdf/i.test(message)) {
    return "I couldn't open that PDF — the file looks damaged. Try exporting it again.";
  }
  if (code === "HEIC_UNSUPPORTED") {
    return "This browser can't open HEIC photos. Share the photo as JPEG, or upload your menu as a PDF.";
  }
  if (name === "RangeError" || /out of memory|allocation failed/i.test(message)) {
    return "This menu is too big to prepare on this phone. Try again on a laptop, or add your menu in the editor.";
  }
  if (name === "AbortError") return "Cancelled.";

  return "Something went wrong preparing that menu. Try again, or add your items in the editor.";
}

/**
 * What to show when the parse job itself finished badly. Never renders
 * `last_error` — that field holds parser internals.
 */
export function describeJobFailure(job) {
  if (job?.status === "failed") {
    return "I couldn't read that menu. Add your items in the editor and I'll learn them.";
  }
  return "Still reading — this is taking longer than usual.";
}

// ---------------------------------------------------------------------------
// The review screen.
//
// This screen used to end on "everything looked clear", which was a completeness
// claim the system had no basis for making. A real 5-page import dropped an
// entire page — six priced dishes — and said exactly that, because the only
// signal it consulted was a model confidence score that comes back 1.0 for every
// row. The owner had nothing to go on, and Bella then told callers the
// restaurant didn't sell pizza.
//
// So: stop promising, start bounding. Every headline ends on the one sentence
// that is true in every case — the list is the limit of what the agent knows.
// ---------------------------------------------------------------------------

const KNOWLEDGE_LIMIT = "I'll only know the dishes on this list.";

/** Page outcomes that need no comment. Anything else is worth telling them. */
const PAGE_STATUS_FINE = new Set(["items", "recovered", "empty_confirmed"]);

/** "page 3" · "pages 3 and 7" · "pages 3, 7 and 11" · "pages 3, 7, 11 and 2 others" */
export function pageListSentence(pages) {
  const list = [...new Set(pages ?? [])].sort((a, b) => a - b);
  if (!list.length) return "";
  if (list.length === 1) return `page ${list[0]}`;
  if (list.length <= 3) {
    return `pages ${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
  }
  const rest = list.length - 3;
  return `pages ${list.slice(0, 3).join(", ")} and ${rest} other${rest === 1 ? "" : "s"}`;
}

/**
 * Bucket the per-page outcomes into the two things worth saying out loud.
 *
 * `hasInfo` is load-bearing: an empty array means we know NOTHING about the
 * pages, not that they were all fine. Every caller has to be able to tell those
 * apart, because collapsing "unknown" into "clean" is the original bug.
 */
export function summarisePages(pageResults) {
  const pages = Array.isArray(pageResults) ? pageResults : [];
  const missed = [];
  const unreadable = [];
  for (const p of pages) {
    if (!p || typeof p.page !== "number") continue;
    if (p.status === "unread") unreadable.push(p.page);
    else if (!PAGE_STATUS_FINE.has(p.status)) missed.push(p.page);
  }
  return {
    total: pages.length,
    hasInfo: pages.length > 0,
    allAccounted: missed.length === 0 && unreadable.length === 0,
    missed: missed.sort((a, b) => a - b),
    unreadable: unreadable.sort((a, b) => a - b)
  };
}

/**
 * The review headline. Never claims completeness — the most it will say is how
 * many pages it managed to read, and it always names the ones it didn't.
 *
 * Pages the parser positively determined were covers or photos are NOT
 * mentioned: they are the expected case, and reporting them would train owners
 * to skip the notice that matters.
 */
export function describeImportSummary({ itemCount, pageResults }) {
  const n = `${itemCount} item${itemCount === 1 ? "" : "s"}`;
  const { total, hasInfo, allAccounted, missed, unreadable } = summarisePages(pageResults);

  if (hasInfo && !allAccounted) {
    const parts = [];
    if (unreadable.length) parts.push(`${pageListSentence(unreadable)} wouldn't read at all`);
    if (missed.length) parts.push(`I got nothing from ${pageListSentence(missed)}`);
    return `I read ${n}, but ${parts.join(", and ")}. Add whatever's missing below — ${KNOWLEDGE_LIMIT}`;
  }
  if (hasInfo && total > 1) {
    return `I read ${n} across all ${total} pages. Have a quick look — ${KNOWLEDGE_LIMIT}`;
  }
  return `I read ${n} from your menu. Have a quick look — ${KNOWLEDGE_LIMIT}`;
}

export const REVIEW_CONCERNS_HEADING = "Before you import";

/**
 * The things worth a second look, worst first. Empty array means nothing to say
 * — which is also what hides the acknowledgement tickbox.
 *
 * Page rows carry no "fix this" button on purpose. We know page 3 came back
 * empty; we do NOT know which category it belonged to, and a button that guesses
 * is the same class of confident-but-wrong that put us here.
 */
export function describeReviewConcerns({ pageResults, unpricedCount = 0 } = {}) {
  const { missed, unreadable } = summarisePages(pageResults);
  const pageRows = [
    ...unreadable.map((page) => `Page ${page} — I couldn't read this one at all`),
    ...missed.map((page) => `Page ${page} — I got nothing from this one`)
  ];

  const out = pageRows.slice(0, 4);
  // Never silently drop a page from the list: how many are unshown is itself
  // the number the owner needs.
  if (pageRows.length > 4) {
    const rest = pageRows.length - 4;
    out.push(`…and ${rest} more page${rest === 1 ? "" : "s"} to check`);
  }

  if (unpricedCount > 0) {
    out.push(
      unpricedCount === 1
        ? "1 item has no price — I'd tell callers it's free"
        : `${unpricedCount} items have no price — I'd tell callers they're free`
    );
  }
  return out;
}

export const REVIEW_ACK_LABEL = "I've checked these — import my menu as it is.";
export const REVIEW_ACK_HINT = "Tick the box above and I'll import what's here.";

/**
 * The one thing that genuinely blocks a commit, because the backend rejects it
 * and its rejection is unreadable. Everything else is acknowledged, not blocked:
 * a hard block leaves the owner nowhere to go but "Start over", which re-uploads
 * the same file and returns the same job.
 */
export function describeCommitBlock({ unnamedCount = 0, unnamedCategoryCount = 0 } = {}) {
  if (unnamedCount > 0) {
    return unnamedCount === 1
      ? "One row still has no name — give it one or remove it."
      : `${unnamedCount} rows still have no name — name them or remove them.`;
  }
  if (unnamedCategoryCount > 0) {
    return unnamedCategoryCount === 1
      ? "One section still has no name — give it one, or remove the items under it."
      : `${unnamedCategoryCount} sections still have no name — name them, or remove the items under them.`;
  }
  return null;
}

/** Shown when adding would exceed what one import can carry. */
export function describeAddLimit(kind) {
  return kind === "category"
    ? `That's the most categories I can take in one import (${MENU_IMPORT_LIMITS.MAX_CATEGORIES}). Import these, then add the rest in Manage menu.`
    : `That's the most items I can take in one category (${MENU_IMPORT_LIMITS.MAX_ITEMS_PER_CATEGORY}). Import these, then add the rest in Manage menu.`;
}

/** Starting over now discards typed-in work too, so it has to be asked. */
export function describeStartOverConfirm(itemCount) {
  return `Start over? I'll forget the ${itemCount} item${itemCount === 1 ? "" : "s"} I read, and anything you've added.`;
}
