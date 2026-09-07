/**
 * pdf.js loading, in one place.
 *
 * Two things here are easy to get wrong and expensive to discover late, which
 * is why they live together behind one function rather than inline at the call
 * site.
 *
 * 1. THE WORKER URL comes from the bundler (`?url`), never from a runtime
 *    `new URL(..., import.meta.url)`. This is not a style preference — it is
 *    the bug that took menu import down in production on 7 Sep 2026.
 *
 *    Vite/Rolldown only rewrites `new URL()` when the first argument is a
 *    RELATIVE literal. A bare package specifier is left untouched, so
 *    `new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url)`
 *    resolved against the chunk's own URL and asked Hosting for
 *    `/assets/pdfjs-dist/build/pdf.worker.min.mjs`. The worker was deployed
 *    correctly the whole time under its hashed name — nothing requested it.
 *
 *    What made it expensive to find: Firebase Hosting's SPA rewrite answers an
 *    unknown path with `index.html` and **HTTP 200**, not 404. So pdf.js tried
 *    to start a module worker from 6 KB of HTML, and there was no 404 in any
 *    log to point at. Dev was fine, because dev resolves bare specifiers.
 *
 *    Verify with `npm run build:frontend` and grep the built pdf chunk for the
 *    worker name — it must be a hashed `/assets/pdf.worker.min-*.mjs`. Never
 *    trust dev alone here, and never trust a 200 either.
 *
 * 2. iOS. pdf.js uses `Promise.withResolvers`, which Safari only shipped in
 *    17.4. Restaurant owners photograph menus on phones, many of them older
 *    iPhones, so without the polyfill below the whole feature throws on the
 *    devices most likely to use it. ⚠️ This comment used to claim the version
 *    was "pinned exactly"; it is not — `apps/frontend/package.json` carries
 *    `pdfjs-dist: ^6.2.108`, so a minor bump can raise the browser floor
 *    silently. Keep the polyfill above regardless of what the range allows.
 *
 * 3. Rendering needs a VISIBLE page. `page.render()` is driven by
 *    requestAnimationFrame, which does not fire while `document.hidden` is
 *    true — the render promise simply never settles. Parsing (getDocument,
 *    getPage, getOperatorList) runs in the worker and is unaffected. Worth
 *    knowing before debugging a "hang": check visibilityState first. It also
 *    means an automated headless check can verify everything here EXCEPT the
 *    paint itself.
 */

// The worker URL must come from the bundler, not from a runtime `new URL()`.
// `?url` makes Vite emit the worker as a hashed asset and hand back its real
// built path, and it resolves identically in dev and in a production build.
// This import costs nothing at load time — it is a string, not the 1 MB worker.
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

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
    pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
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
