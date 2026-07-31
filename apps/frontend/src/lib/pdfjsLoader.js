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
 * Open a PDF without ever materialising it in memory.
 *
 * `file.arrayBuffer()` on the 413 MB menu that started this is the single most
 * likely way to kill a phone tab, so we hand pdf.js a range transport backed by
 * `file.slice()` and let it pull only the bytes it needs. `disableAutoFetch`
 * and `disableStream` stop it helpfully reading the whole thing anyway.
 */
export async function openPdf(file) {
  const pdfjs = await loadPdfjs();
  return pdfjs.getDocument({
    range: new FileRangeTransport(file, pdfjs),
    disableAutoFetch: true,
    disableStream: true
  }).promise;
}

/** Reads a local File in ranges, so only the requested slice is ever decoded. */
class FileRangeTransport {
  constructor(file, pdfjs) {
    // Constructed dynamically because PDFDataRangeTransport only exists once
    // pdf.js has loaded, and this module must stay importable without it.
    const Base = pdfjs.PDFDataRangeTransport;
    const instance = new Base(file.size, new Uint8Array(0));
    instance.requestDataRange = (begin, end) => {
      file
        .slice(begin, end)
        .arrayBuffer()
        .then((buffer) => instance.onDataRange(begin, new Uint8Array(buffer)))
        .catch((error) => instance.onDataProgressiveError?.(error));
    };
    instance.abort = () => {};
    return instance;
  }
}
