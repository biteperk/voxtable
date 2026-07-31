import { env } from "../config/env";
import { AppError } from "../domain/errors";
import { logger } from "../utils/logger";
import { menuDraftSchema, type MenuDraft } from "../http/schemas";

/**
 * Vision-LLM menu parser. Kept behind a small interface + kill switch so the
 * provider is swappable and the feature ships inert. Default implementation
 * calls Anthropic's Messages API (no SDK dependency — plain fetch).
 *
 * Money discipline: the prompt forces integer cents, and the result is
 * re-validated by menuDraftSchema (which also rejects absurd prices), so a
 * hallucinated "$1,299" can't silently land as a real price.
 */

export function isMenuOcrEnabled(): boolean {
  return env.MENU_OCR_ENABLED && Boolean(env.MENU_OCR_API_KEY);
}

/**
 * Pages per vision call. A real designed menu is 12+ pages and its structured
 * JSON far exceeds any single response, so pages are read in batches and merged.
 * Six keeps each response comfortably inside the output budget below while
 * preserving enough context for a category heading to govern the items that
 * follow it onto the next page.
 */
export const PAGES_PER_BATCH = 6;

/**
 * Output token allowance, derived from how many pages a call is actually
 * reading rather than a flat number.
 *
 * This was a hardcoded 4096 — roughly a third of what a 100-item menu needs.
 * The model would run out mid-item, and the truncated JSON then crashed the
 * parser and showed the restaurant owner "Unexpected end of JSON input".
 * A dense page is ~20 items at ~90 tokens of JSON each, so 3000/page has real
 * headroom; the ceiling keeps a pathological response from running away.
 */
const TOKENS_PER_PAGE = 3_000;
const MAX_OUTPUT_TOKENS = 32_000;
const MIN_OUTPUT_TOKENS = 4_096;

export function outputTokenBudget(pageCount: number): number {
  return Math.min(MAX_OUTPUT_TOKENS, Math.max(MIN_OUTPUT_TOKENS, TOKENS_PER_PAGE * Math.max(1, pageCount)));
}

// Guidance below is written against real designed menus, not a toy example:
// two-column layouts, dietary codes in parentheses, indented sub-options, and a
// branding cover page carrying no items at all.
const SYSTEM_PROMPT = [
  "You are a precise menu digitiser for a restaurant booking platform.",
  "You receive one or more pages of a restaurant menu and must extract their",
  "structure as STRICT JSON. Output ONLY the JSON object, no prose, no code",
  "fences. Schema:",
  '{ "categories": [ { "name": string, "items": [ {',
  '  "name": string, "description"?: string, "price_cents": integer,',
  '  "confidence": number (0..1, your certainty for this row),',
  '  "variants"?: [ { "name": string, "price_delta_cents": integer } ],',
  '  "modifier_groups"?: [ { "group_name": string, "min_select": integer,',
  '    "max_select": integer, "options": [ { "name": string, "price_delta_cents": integer } ] } ]',
  "} ] } ] }",
  "Rules: price_cents and price_delta_cents are INTEGER CENTS (e.g. $12.50 -> 1250).",
  "Never invent items or prices. If a price is unreadable, set price_cents to 0",
  "and confidence below 0.4. Group items under the categories printed on the menu.",
  // --- reading real menu layouts ---
  "Pages are given in order. Read a multi-column page one full column at a time,",
  "top to bottom, left column before right — never straight across the page.",
  "Cover, branding, contact, opening-hours and full-page photo pages contain no",
  "items: return no categories for them rather than inventing any.",
  "A heading on one page governs the items that follow it, including onto the",
  "next page. If items appear before any heading, use the category name 'Menu'.",
  "Short parenthesised codes after a name (GF, DF, VG, VGN, V, N, I) are dietary",
  "tags, NOT part of the dish name and NOT a variant: drop them from `name` and",
  "append them to `description` as e.g. 'Gluten free, dairy free'.",
  "Indented or bulleted choices under one priced dish (fillings, sizes, protein",
  "swaps) are `variants` of that dish, not separate items. When such a choice",
  "costs no extra, price_delta_cents is 0; a smaller/kids option priced BELOW the",
  "dish is a NEGATIVE price_delta_cents.",
  "Italic or footnote lines like 'also available vegetarian' belong in the",
  "description of the dish above them, not as their own item.",
  "Editorial labels such as 'Signature dish', 'Chef's pick' or 'New' are not",
  "items and not categories — put them in the description if useful."
].join(" ");

interface FetchedFile {
  base64: string;
  mediaType: string;
}

/**
 * `source_url` is supplied by the client, and we then fetch it server-side —
 * classic SSRF shape. Without a host check any authenticated manager could aim
 * this at `http://169.254.169.254/` (cloud metadata) or any address inside our
 * VPC. It isn't even blind: the fetch outcome is persisted to `last_error` and
 * handed back by GET /api/menu/ingest/:jobId, which turns it into a port
 * scanner. So: HTTPS only, and only hosts we actually upload to.
 *
 * The frontend uploads to Firebase Storage and passes us the download URL
 * (see uploadMenuFile in apps/frontend/src/firebase.js), so the allowlist is
 * normally just the storage host. Kept in env so a bucket move is a config
 * change, not a deploy.
 */
export function assertAllowedMenuSourceUrl(sourceUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new AppError(400, "MENU_SOURCE_URL_INVALID", "That file link isn't valid.");
  }
  if (parsed.protocol !== "https:") {
    throw new AppError(400, "MENU_SOURCE_URL_INVALID", "That file link isn't valid.");
  }
  const allowed = env.MENU_OCR_ALLOWED_HOSTS.split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  const host = parsed.hostname.toLowerCase();
  // Exact host match only. A suffix match would let `evil-firebasestorage.
  // googleapis.com.attacker.test` through.
  if (!allowed.includes(host)) {
    logger.warn({ evt: "menu_ocr_source_url_rejected", host });
    throw new AppError(
      400,
      "MENU_SOURCE_URL_INVALID",
      "Menus can only be imported from a file you uploaded here. Please upload the file again."
    );
  }
}

async function fetchAsBase64(sourceUrl: string): Promise<FetchedFile> {
  // Re-checked here, not just at the API boundary: this is the line that
  // actually makes the request, and it runs in the worker long after the
  // request that created the job.
  assertAllowedMenuSourceUrl(sourceUrl);

  const maxBytes = env.MENU_OCR_MAX_FILE_MB * 1024 * 1024;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.MENU_OCR_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(sourceUrl, {
      signal: controller.signal,
      // An allowed host must not be able to bounce us to an internal one.
      redirect: "error"
    });
    if (!res.ok) {
      // The upstream status stays in our logs. Echoing it to the tenant is what
      // made this a usable scanner.
      logger.warn({ evt: "menu_ocr_fetch_failed", status: res.status });
      throw new AppError(502, "MENU_OCR_FETCH_FAILED", "We couldn't read that uploaded file.");
    }

    // Trust the declared length when it's there — cheapest possible rejection.
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new AppError(413, "MENU_OCR_FILE_TOO_LARGE", `File exceeds ${env.MENU_OCR_MAX_FILE_MB}MB.`);
    }

    // Stream with a running cap rather than arrayBuffer(): buffering first and
    // checking after means a multi-GB response OOMs the worker process — which
    // also runs notifications and provisioning — before we ever get to look.
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    if (!reader) {
      throw new AppError(502, "MENU_OCR_FETCH_FAILED", "We couldn't read that uploaded file.");
    }
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new AppError(413, "MENU_OCR_FILE_TOO_LARGE", `File exceeds ${env.MENU_OCR_MAX_FILE_MB}MB.`);
      }
      chunks.push(Buffer.from(value));
    }

    const buf = Buffer.concat(chunks, total);
    const mediaType = res.headers.get("content-type")?.split(";")[0]?.trim() || guessMediaType(sourceUrl);
    return { base64: buf.toString("base64"), mediaType };
  } finally {
    clearTimeout(timer);
  }
}

function guessMediaType(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes(".pdf")) return "application/pdf";
  if (lower.includes(".png")) return "image/png";
  if (lower.includes(".webp")) return "image/webp";
  return "image/jpeg";
}

// --- Anthropic-native (Messages API) content blocks ---
// One block per page, in order, each labelled so the model can attribute a
// heading on page 4 to the items running onto page 5.
function anthropicContentBlocks(files: FetchedFile[], sourceKind: "image" | "pdf"): unknown[] {
  return files.flatMap((file, i) => {
    const label = { type: "text", text: `Page ${i + 1} of ${files.length}:` };
    const media =
      sourceKind === "pdf" || file.mediaType === "application/pdf"
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: file.base64 } }
        : { type: "image", source: { type: "base64", media_type: file.mediaType, data: file.base64 } };
    return [label, media];
  });
}

// --- OpenAI-compatible (/chat/completions) content block ---
// Used for open-weight VLM hosts (OpenRouter, Together, Fireworks, DeepInfra,
// Gemini's OpenAI shim, local Ollama). Images go as a data: URL under
// image_url; PDFs are not universally supported on this shape, so we send them
// via the `file` block that OpenRouter/Gemini accept, falling back to image_url
// for image sources.
function openaiContentBlocks(files: FetchedFile[], sourceKind: "image" | "pdf"): unknown[] {
  const pages = files.flatMap((file, i) => {
    const label = { type: "text", text: `Page ${i + 1} of ${files.length}:` };
    const media =
      sourceKind === "pdf" || file.mediaType === "application/pdf"
        ? {
            type: "file",
            file: { filename: `menu-${i + 1}.pdf`, file_data: `data:application/pdf;base64,${file.base64}` }
          }
        : { type: "image_url", image_url: { url: `data:${file.mediaType};base64,${file.base64}` } };
    return [label, media];
  });
  return [...pages, { type: "text", text: "Digitise this menu. Output only the JSON object." }];
}

interface OcrResponse {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /**
   * True when the model stopped because it hit the output cap rather than
   * because it finished. Without this a truncated reply reaches JSON.parse and
   * blows up with a message no restaurant owner can act on — and, being
   * deterministic, it does so on every retry.
   */
  truncated: boolean;
}

async function callAnthropic(
  files: FetchedFile[],
  sourceKind: "image" | "pdf",
  signal: AbortSignal
): Promise<OcrResponse> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": env.MENU_OCR_API_KEY!,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: env.MENU_OCR_MODEL,
      max_tokens: outputTokenBudget(files.length),
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            ...anthropicContentBlocks(files, sourceKind),
            { type: "text", text: "Digitise this menu. Output only the JSON object." }
          ]
        }
      ]
    })
  });
  if (!res.ok) throw await upstreamError(res);
  const json = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  return {
    text: (json.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n"),
    inputTokens: json.usage?.input_tokens ?? null,
    outputTokens: json.usage?.output_tokens ?? null,
    truncated: json.stop_reason === "max_tokens"
  };
}

async function callOpenAiCompatible(
  files: FetchedFile[],
  sourceKind: "image" | "pdf",
  signal: AbortSignal
): Promise<OcrResponse> {
  const base = env.MENU_OCR_BASE_URL!.replace(/\/$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.MENU_OCR_API_KEY!}`
    },
    body: JSON.stringify({
      model: env.MENU_OCR_MODEL,
      max_tokens: outputTokenBudget(files.length),
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: openaiContentBlocks(files, sourceKind) }
      ]
    })
  });
  if (!res.ok) throw await upstreamError(res);
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = json.choices?.[0];
  return {
    text: choice?.message?.content ?? "",
    inputTokens: json.usage?.prompt_tokens ?? null,
    outputTokens: json.usage?.completion_tokens ?? null,
    // OpenAI-compatible hosts use "length"; Gemini's shim also emits "MAX_TOKENS".
    truncated: choice?.finish_reason === "length" || choice?.finish_reason === "MAX_TOKENS"
  };
}

async function upstreamError(res: Response): Promise<AppError> {
  const body = await res.text().catch(() => "");
  logger.error({ evt: "menu_ocr_upstream_error", status: res.status, body: body.slice(0, 300) });
  const transient = res.status === 429 || res.status >= 500;
  return new AppError(
    transient ? 503 : 502,
    "MENU_OCR_UPSTREAM_ERROR",
    "The menu parser is temporarily unavailable."
  );
}

function extractJson(text: string): unknown {
  // Strip ```json fences if the model added them despite instructions.
  const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new AppError(502, "MENU_OCR_BAD_OUTPUT", "The menu parser returned no JSON.");
  }
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (error) {
    // Was unguarded. A truncated reply threw a raw SyntaxError, which is not an
    // AppError, so the worker treated it as transient and burned three more paid
    // vision calls reproducing it — then showed the owner the literal text
    // "Unexpected end of JSON input".
    logger.error({
      evt: "menu_ocr_json_parse_failed",
      chars: cleaned.length,
      error: error instanceof Error ? error.message : String(error)
    });
    throw new AppError(502, "MENU_OCR_BAD_OUTPUT", "The menu parser returned an unreadable result.");
  }
}

/** Case/whitespace-insensitive key so "Desserts", "DESSERTS" and " desserts " merge. */
function categoryKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Fold per-batch results into one draft.
 *
 * Categories are matched on a normalised name because a heading legitimately
 * recurs across pages ("Desserts" on page 4 and page 11) and because the model
 * may differ in casing between calls. Without this the commit later hits the
 * `UNIQUE (restaurant_id, LOWER(name))` index and the whole import dies with
 * "Something went wrong."
 *
 * Item order is preserved, and an item already present under the same category
 * (same normalised name) is dropped — a page-straddling heading can otherwise
 * make the model repeat the last row of the previous page.
 */
export function mergeDrafts(parts: MenuDraft[]): MenuDraft {
  const byKey = new Map<string, { name: string; items: MenuDraft["categories"][number]["items"] }>();
  for (const part of parts) {
    for (const category of part.categories) {
      const key = categoryKey(category.name);
      const existing = byKey.get(key);
      const target = existing ?? { name: category.name, items: [] };
      if (!existing) byKey.set(key, target);
      const seen = new Set(target.items.map((i) => categoryKey(i.name)));
      for (const item of category.items) {
        const itemKey = categoryKey(item.name);
        if (seen.has(itemKey)) continue;
        seen.add(itemKey);
        target.items.push(item);
      }
    }
  }
  return { categories: [...byKey.values()].filter((c) => c.items.length > 0) };
}

/** One vision call over a contiguous run of pages. */
async function parseBatch(input: {
  pageUrls: string[];
  sourceKind: "image" | "pdf";
  restaurantId?: string;
  firstPageNumber: number;
}): Promise<MenuDraft> {
  const files: FetchedFile[] = [];
  for (const url of input.pageUrls) files.push(await fetchAsBase64(url));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.MENU_OCR_REQUEST_TIMEOUT_MS);
  let result: OcrResponse;
  try {
    // Dispatch on the configured provider dialect — Anthropic-native or any
    // OpenAI-compatible host (open-weight VLMs). Both return a uniform shape.
    result =
      env.MENU_OCR_PROVIDER === "openai"
        ? await callOpenAiCompatible(files, input.sourceKind, controller.signal)
        : await callAnthropic(files, input.sourceKind, controller.signal);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new AppError(503, "MENU_OCR_TIMEOUT", "The menu parser timed out.");
    }
    logger.error({ evt: "menu_ocr_request_failed", error });
    throw new AppError(502, "MENU_OCR_UPSTREAM_ERROR", "The menu parser is temporarily unavailable.");
  } finally {
    clearTimeout(timer);
  }

  // Cost attribution: tokens, not dollars, to stay provider-price-agnostic.
  logger.info({
    evt: "menu_ocr_call",
    provider: env.MENU_OCR_PROVIDER,
    model: env.MENU_OCR_MODEL,
    restaurant_id: input.restaurantId ?? null,
    source_kind: input.sourceKind,
    pages: files.length,
    first_page: input.firstPageNumber,
    file_bytes: files.reduce((n, f) => n + Math.round((f.base64.length * 3) / 4), 0),
    input_tokens: result.inputTokens,
    output_tokens: result.outputTokens,
    truncated: result.truncated
  });

  if (result.truncated) {
    // Signalled, not guessed — the caller halves the batch and retries. Distinct
    // code so it is never mistaken for a transient upstream problem.
    throw new AppError(502, "MENU_OCR_TRUNCATED", "The menu parser ran out of room on these pages.");
  }

  const parsed = menuDraftSchema.safeParse(extractJson(result.text));
  if (!parsed.success) {
    logger.error({
      evt: "menu_ocr_schema_mismatch",
      first_page: input.firstPageNumber,
      issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 5)
    });
    throw new AppError(502, "MENU_OCR_BAD_OUTPUT", "The menu parser returned an unexpected shape.");
  }
  return parsed.data;
}

export interface ParseMenuResult {
  draft: MenuDraft;
  /** 1-based page numbers we could not read. Empty on a clean run. */
  failedPages: number[];
  pagesRead: number;
}

/**
 * Read a whole menu — one page or fifty — and return a single merged draft.
 *
 * Pages are processed in batches so output never has to fit one response, and
 * `onBatchDone` is awaited between batches so the caller can prove the job is
 * still alive (see heartbeatIngestionJob: the claim query re-claims anything
 * sitting in 'processing' for ten minutes, and a long menu legitimately exceeds
 * that).
 *
 * A batch that reports truncation is split in half and retried once; that is a
 * signal we asked for too much at once, not a failure. A batch that still fails
 * is recorded in `failedPages` and the rest of the menu is kept — losing an
 * entire 12-page import because page 7 was a photo collage would be worse than
 * telling the owner which pages to add by hand.
 */
export async function parseMenu(input: {
  sourceUrls: string[];
  sourceKind: "image" | "pdf";
  restaurantId?: string;
  onBatchDone?: () => Promise<void>;
}): Promise<ParseMenuResult> {
  if (!isMenuOcrEnabled()) {
    throw new AppError(503, "MENU_OCR_DISABLED", "Menu OCR is not enabled.");
  }
  if (input.sourceUrls.length === 0) {
    throw new AppError(400, "MENU_SOURCE_URL_INVALID", "No menu pages to read.");
  }

  const batches: Array<{ urls: string[]; firstPage: number }> = [];
  for (let i = 0; i < input.sourceUrls.length; i += PAGES_PER_BATCH) {
    batches.push({ urls: input.sourceUrls.slice(i, i + PAGES_PER_BATCH), firstPage: i + 1 });
  }

  const parts: MenuDraft[] = [];
  const failedPages: number[] = [];
  let pagesRead = 0;

  for (const batch of batches) {
    try {
      parts.push(
        await parseBatch({
          pageUrls: batch.urls,
          sourceKind: input.sourceKind,
          restaurantId: input.restaurantId,
          firstPageNumber: batch.firstPage
        })
      );
      pagesRead += batch.urls.length;
    } catch (error) {
      const truncated = error instanceof AppError && error.code === "MENU_OCR_TRUNCATED";
      if (truncated && batch.urls.length > 1) {
        // Too much asked for at once — halve and retry the two halves.
        const mid = Math.ceil(batch.urls.length / 2);
        for (const [offset, half] of [
          [0, batch.urls.slice(0, mid)],
          [mid, batch.urls.slice(mid)]
        ] as Array<[number, string[]]>) {
          try {
            parts.push(
              await parseBatch({
                pageUrls: half,
                sourceKind: input.sourceKind,
                restaurantId: input.restaurantId,
                firstPageNumber: batch.firstPage + offset
              })
            );
            pagesRead += half.length;
          } catch {
            half.forEach((_, i) => failedPages.push(batch.firstPage + offset + i));
          }
        }
      } else if (error instanceof AppError && error.statusCode === 503) {
        // Genuinely transient (rate limit, upstream 5xx, timeout) — let the
        // worker's backoff handle the whole job rather than silently dropping
        // pages that would have worked a minute later.
        throw error;
      } else {
        batch.urls.forEach((_, i) => failedPages.push(batch.firstPage + i));
      }
    }
    if (input.onBatchDone) await input.onBatchDone();
  }

  const draft = mergeDrafts(parts);
  const itemCount = draft.categories.reduce((n, c) => n + c.items.length, 0);

  // Zero items is a failure, not a success. It used to pass validation and land
  // the owner on a review screen reading "I read 0 items — everything looked
  // clear" with the continue button disabled: a dead end that claimed success.
  if (itemCount === 0) {
    throw new AppError(
      502,
      "MENU_OCR_NO_ITEMS",
      "I couldn't find any dishes on that menu. Try a clearer photo, or add your items in the editor."
    );
  }

  logger.info({
    evt: "menu_ocr_complete",
    restaurant_id: input.restaurantId ?? null,
    pages_total: input.sourceUrls.length,
    pages_read: pagesRead,
    failed_pages: failedPages,
    categories: draft.categories.length,
    items: itemCount
  });

  return { draft, failedPages, pagesRead };
}
