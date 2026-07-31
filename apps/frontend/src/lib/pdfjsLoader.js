/**
 * pdf.js loading, in one place.
 *
 * Two things here are easy to get wrong and expensive to discover late, which
 * is why they live together behind one function rather than inline at the call
 * site.
 *
 * 1. THE WORKER URL. Vite resolves `new URL(..., import.meta.url)` differently
 *    in dev and in a production build. Get it wrong and menu import works
 *    perfectly on your laptop and 404s for every customer. Always verify
 *    against `npm run build:frontend` + preview, never dev alone.
 *
 * 2. iOS. pdf.js 4.x uses `Promise.withResolvers`, which Safari only shipped in
 *    17.4. Restaurant owners photograph menus on phones, many of them older
 *    iPhones, so without the polyfill below the whole feature throws on the
 *    devices most likely to use it. The version is pinned exactly for the same
 *    reason — a minor bump can raise the browser floor silently.
 *
 * 3. Rendering needs a VISIBLE page. `page.render()` is driven by
 *    requestAnimationFrame, which does not fire while `document.hidden` is
 *    true — the render promise simply never settles. Parsing (getDocument,
 *    getPage, getOperatorList) runs in the worker and is unaffected. Worth
 *    knowing before debugging a "hang": check visibilityState first. It also
 *    means an automated headless check can verify everything here EXCEPT the
 *    paint itself.
 */

let pdfjsPromise = null;

/** Four lines that keep iOS 16 / 17.0–17.3 working. Safari added this in 17.4. */
function ensurePromiseWithResolvers() {
  if (typeof Promise.withResolvers === "function") return;
  Promise.withResolvers = function withResolvers() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

/**
 * Load pdf.js and point it at its worker. Memoised — the library is ~1 MB and
 * lazily imported, so it must never enter the main bundle or load twice.
 */
export async function loadPdfjs() {
  if (pdfjsPromise) return pdfjsPromise;
  pdfjsPromise = (async () => {
    ensurePromiseWithResolvers();
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url
    ).href;
    return pdfjs;
  })().catch((error) => {
    // Don't cache a failure — a flaky chunk load should be retryable.
    pdfjsPromise = null;
    throw error;
  });
  return pdfjsPromise;
}

/**
 * Open a PDF without ever materialising it in JavaScript memory.
 *
 * `file.arrayBuffer()` on the 413 MB menu that started this is the single most
 * likely way to kill a phone tab, so the file is handed over as a `blob:` URL
 * and pdf.js fetches from it with its own networking. The browser owns those
 * bytes; the JS heap only ever holds what pdf.js asks for.
 *
 * A hand-rolled PDFDataRangeTransport would also work, but pdf.js's own network
 * layer is well-tested and needs no interface of ours to stay correct across
 * upgrades. Fewer moving parts for the same memory behaviour.
 *
 * The caller MUST call `release()` when finished, or the blob URL pins the whole
 * file in memory for the life of the document.
 */
export async function openPdf(file) {
  const pdfjs = await loadPdfjs();
  const url = URL.createObjectURL(file);
  try {
    const doc = await pdfjs.getDocument({
      url,
      // Fetch on demand rather than eagerly pulling the entire document.
      disableAutoFetch: true,
      disableStream: false
    }).promise;
    doc.__objectUrl = url;
    return doc;
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/** Destroy a document and release the blob URL behind it. */
export async function closePdf(doc) {
  if (!doc) return;
  const url = doc.__objectUrl;
  await doc.destroy().catch(() => {});
  if (url) URL.revokeObjectURL(url);
}
