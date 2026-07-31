/**
 * Turn whatever the owner picked into small, readable page images.
 *
 * This is the fix for the incident: a 12-page, 413 MB menu that timed out
 * uploading. Rendered here at ~150 DPI the same menu is under 4 MB, so it
 * uploads in seconds instead of six minutes.
 *
 * Every decision — sizes, budgets, degradation, copy — lives in
 * `menuImportPlan.js` so it can be unit-tested. This module only does the
 * browser work: canvas, pdf.js, and keeping memory under control.
 *
 * MEMORY IS THE HARD PART. A phone has to survive a 413 MB source, so:
 *   - the source file is never read whole (see pdfjsLoader.openPdf)
 *   - exactly one page is decoded at a time
 *   - each canvas is zeroed after use; iOS does not free canvas backing store
 *     promptly on garbage collection alone
 *   - the document is reopened periodically to drop pdf.js's chunk cache
 *   - only the encoded JPEG blobs are held between pages (~300 KB each)
 */

import {
  MENU_IMPORT_LIMITS,
  nextEncodeAttempt,
  planPageBudget,
  scaleForViewport
} from "./menuImportPlan.js";
import { openPdf } from "./pdfjsLoader.js";

/** Let the browser paint progress and stay responsive between pages. */
const yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve, 0));

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error("Cancelled");
    error.name = "AbortError";
    throw error;
  }
}

/** OffscreenCanvas where available (faster, off the main thread), else a DOM one. */
function makeCanvas(width, height) {
  if (typeof OffscreenCanvas === "function") {
    return { canvas: new OffscreenCanvas(width, height), offscreen: true };
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return { canvas, offscreen: false };
}

function toBlob(canvas, offscreen, quality) {
  if (offscreen) return canvas.convertToBlob({ type: "image/jpeg", quality });
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode this page."))),
      "image/jpeg",
      quality
    );
  });
}

/**
 * Release a canvas. Setting the dimensions to zero is the documented way to
 * make Safari drop the backing store — without it, twelve A4 pages at 2.4 MP
 * each accumulate until the tab dies.
 */
function releaseCanvas(canvas) {
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    // OffscreenCanvas in some engines refuses a resize after transfer; harmless.
  }
}

/** Encode a canvas, degrading via the ladder until it fits its budget. */
async function encodeWithinBudget({ canvas, offscreen, budgetBytes, quality }) {
  let current = quality;
  let blob = await toBlob(canvas, offscreen, current);
  for (let attempt = 1; attempt <= MENU_IMPORT_LIMITS.MAX_ENCODE_ATTEMPTS; attempt += 1) {
    const step = nextEncodeAttempt({
      attempt,
      bytes: blob.size,
      budgetBytes,
      longEdgePx: Math.max(canvas.width, canvas.height),
      quality: current
    });
    if (step.done) break;
    // Only quality is retried here; a resolution change needs a re-render, and
    // in practice quality alone gets a real menu page under budget.
    if (step.quality !== current) {
      current = step.quality;
      blob = await toBlob(canvas, offscreen, current);
    } else {
      break;
    }
  }
  return blob;
}

/** Render every page of a PDF to a JPEG blob. */
async function renderPdfPages(file, { onProgress, signal }) {
  let pdf = await openPdf(file);
  const plan = planPageBudget({ pageCount: pdf.numPages });
  const pages = [];

  try {
    for (let pageNumber = 1; pageNumber <= plan.pagesToRender; pageNumber += 1) {
      throwIfAborted(signal);
      onProgress?.({ phase: "preparing", page: pageNumber, pageCount: plan.pagesToRender });

      // Drop pdf.js's accumulated chunk cache periodically. Re-parsing the xref
      // costs milliseconds; on a bloated Photoshop export the cache does not.
      if (pageNumber > 1 && (pageNumber - 1) % MENU_IMPORT_LIMITS.REOPEN_EVERY_N_PAGES === 0) {
        await pdf.destroy().catch(() => {});
        pdf = await openPdf(file);
      }

      const page = await pdf.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const scale = scaleForViewport({
        widthPt: base.width,
        heightPt: base.height,
        targetLongEdgePx: plan.targetLongEdgePx
      });
      const viewport = page.getViewport({ scale });
      const { canvas, offscreen } = makeCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext("2d", { alpha: false });
      // Menus are dark-on-light; without this, pages with transparency render
      // onto black and become unreadable.
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: context, viewport }).promise;

      const blob = await encodeWithinBudget({
        canvas,
        offscreen,
        budgetBytes: plan.perPageBudgetBytes,
        quality: plan.initialQuality
      });
      pages.push(blob);

      page.cleanup();
      releaseCanvas(canvas);
      await yieldToBrowser();
    }
  } finally {
    await pdf.destroy().catch(() => {});
  }

  return { pages, truncatedFrom: plan.truncatedFrom };
}

/** Downscale a photo without ever holding it at full resolution. */
async function renderPhoto(file, budgetBytes, quality) {
  let bitmap;
  try {
    // resizeWidth makes the decoder do the downscale, so a 12 MP photo never
    // exists as a full-size bitmap on the JS heap.
    bitmap = await createImageBitmap(file, {
      resizeWidth: MENU_IMPORT_LIMITS.TARGET_LONG_EDGE_PX,
      resizeQuality: "high"
    });
  } catch (error) {
    // Chrome and Firefox cannot decode HEIC; Safari can. Say so usefully.
    if (/\.(heic|heif)$/i.test(file.name ?? "") || /heic|heif/i.test(file.type ?? "")) {
      const heic = new Error("HEIC not supported by this browser");
      heic.code = "HEIC_UNSUPPORTED";
      throw heic;
    }
    throw error;
  }

  // Portrait photos come back taller than wide; keep the long edge on target.
  const longest = Math.max(bitmap.width, bitmap.height);
  const factor = longest > MENU_IMPORT_LIMITS.TARGET_LONG_EDGE_PX
    ? MENU_IMPORT_LIMITS.TARGET_LONG_EDGE_PX / longest
    : 1;
  const width = Math.max(1, Math.round(bitmap.width * factor));
  const height = Math.max(1, Math.round(bitmap.height * factor));

  const { canvas, offscreen } = makeCanvas(width, height);
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await encodeWithinBudget({ canvas, offscreen, budgetBytes, quality });
  releaseCanvas(canvas);
  return blob;
}

/**
 * Prepare a selection for upload.
 *
 * Returns one entry per page, in menu order. A single photo yields one page and
 * `sourceKind: "image"`; anything else yields images too, because the backend
 * reads pages in batches and page images are what it wants.
 *
 * @returns {Promise<{ pages: Blob[], sourceKind: "image"|"pdf", truncatedFrom: number|null, originalBytes: number }>}
 */
export async function prepareMenuUpload(files, { onProgress, signal } = {}) {
  const list = [...files];
  const originalBytes = list.reduce((n, f) => n + (f.size ?? 0), 0);
  throwIfAborted(signal);

  const onlyPdf = list.length === 1 && /pdf$/i.test(list[0].type || list[0].name || "");
  if (onlyPdf) {
    const { pages, truncatedFrom } = await renderPdfPages(list[0], { onProgress, signal });
    return { pages, sourceKind: "image", truncatedFrom, originalBytes };
  }

  const plan = planPageBudget({ pageCount: list.length });
  const pages = [];
  for (let i = 0; i < plan.pagesToRender; i += 1) {
    throwIfAborted(signal);
    onProgress?.({ phase: "preparing-photos", page: i + 1, pageCount: plan.pagesToRender });
    pages.push(await renderPhoto(list[i], plan.perPageBudgetBytes, plan.initialQuality));
    await yieldToBrowser();
  }
  return { pages, sourceKind: "image", truncatedFrom: plan.truncatedFrom, originalBytes };
}
