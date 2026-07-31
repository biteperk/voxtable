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

/** Shown after a partial success, so missed pages aren't discovered later. */
export function describePartialPages(failedPages) {
  if (!failedPages?.length) return null;
  const list = failedPages.length > 3 ? `${failedPages.slice(0, 3).join(", ")} and others` : failedPages.join(", ");
  return `I couldn't read page ${list}. Check those items are here, and add anything missing in the editor.`;
}
