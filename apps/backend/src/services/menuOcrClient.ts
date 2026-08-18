import { env } from "../config/env";
import { AppError } from "../domain/errors";
import { logger } from "../utils/logger";
import { menuOcrBatchSchema, menuOcrVerifySchema, type MenuDraft } from "../http/schemas";
import {
  buildPageResults,
  lastCategoryOf,
  mergeAttributed,
  normaliseBatchOutput,
  parsePriceText,
  planBatches,
  unaccountedPages,
  verificationTargets,
  type PagePart,
  type PageResult,
  type PageStatus
} from "./menuPageAccounting";

/**
 * Vision-LLM menu parser. Kept behind a small interface + kill switch so the
 * provider is swappable and the feature ships inert. Default implementation
 * calls Anthropic's Messages API (no SDK dependency — plain fetch).
 *
 * Money discipline: the prompt forces integer cents, and the result is
 * re-validated by menuOcrBatchSchema (which also rejects absurd prices), so a
 * hallucinated "$1,299" can't silently land as a real price.
 *
 * Reading discipline: the model is asked to account for every page it was given,
 * and any page that yields nothing is re-read on its own before we call the
 * import done. See menuPageAccounting.ts for why — an import that loses a whole
 * page and reports success is worse than one that fails.
 */

export function isMenuOcrEnabled(): boolean {
  return env.MENU_OCR_ENABLED && Boolean(env.MENU_OCR_API_KEY);
}

/**
 * Pages per vision call.
 *
 * Was six. Reduced to three after a five-page import lost its MIDDLE page
 * entirely — the canonical position for attention loss in a long multimodal
 * context. The change is very nearly free: every page is sent exactly once
 * either way, so a smaller batch only re-pays the ~700-token system prompt per
 * extra call (fractions of a cent on a 12-page menu).
 *
 * What a larger batch bought was cross-page context for a heading that governs
 * items running onto the next page. That is now handled deterministically by
 * carrying the previous batch's last category forward as text (lastCategoryOf),
 * which is more reliable than hoping the model re-reads an image four pages back
 * and survives batch boundaries that don't align with the menu's own sections.
 */
export const PAGES_PER_BATCH = 3;

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
  '{ "pages": [ { "page": integer, "page_kind": "items"|"cover"|"contact"|"hours"|"photos"|"other",',
  '  "categories": [ { "name": string, "items": [ {',
  '   "name": string, "description"?: string, "price_cents": integer,',
  '   "variants"?: [ { "name": string, "price_delta_cents": integer } ],',
  '   "modifier_groups"?: [ { "group_name": string, "min_select": integer,',
  '     "max_select": integer, "options": [ { "name": string, "price_delta_cents": integer } ] } ]',
  "} ] } ] } ] }",
  "Rules: price_cents and price_delta_cents are INTEGER CENTS (e.g. $12.50 -> 1250).",
  "Never invent items or prices. If a price is unreadable, set price_cents to 0.",
  "Group items under the categories printed on the menu.",
  // --- account for every page ---
  // The envelope is a checklist. A model that must emit an entry per page skips
  // fewer of them, and an omitted entry is as informative as a zero-item one.
  'Return one entry in "pages" for EVERY page you were given, in label order,',
  "using the page number printed in that page's label — including pages with no",
  'items, which get "categories": []. Never omit a page and never merge two',
  "pages into one entry.",
  "Before you finish a page, sweep it once more for any price you have not yet",
  "written down. A page is done only when every price printed on it appears in",
  "your output for that page.",
  // --- reading real menu layouts ---
  "Pages are given in order. Read a multi-column page one full column at a time,",
  "top to bottom, left column before right — never straight across the page.",
  // This paragraph replaces a rule that said cover/branding/contact/photo pages
  // contain no items. On a real import it fired on a page carrying six priced
  // dishes — the page had a giant MENU wordmark, a welcome sentence, six food
  // photographs and a phone/address footer, so it LOOKED like a cover, and the
  // classification happened before the reading. Presence of a price is now the
  // decisive test, and styling is explicitly not.
  "Judge every page by what is printed on it, never by how it is styled. If a",
  "page shows any dish with a price beside it, that page HAS items and you must",
  "extract every one of them — however much the rest of the page looks like a",
  "cover. A large restaurant wordmark, a welcome sentence, food photographs, a",
  "phone number, an address and opening hours do NOT cancel priced dishes printed",
  "on the same page; a page can be a title page and an item page at once.",
  "Only a page carrying no dish-and-price anywhere on it is a non-item page. For",
  "that page return an empty categories array, and invent nothing to fill it.",
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

export interface FetchedFile {
  base64: string;
  mediaType: string;
}

/**
 * How a page's bytes are obtained, by 1-based absolute page number.
 *
 * This is the seam the fixture harness uses to feed pages from disk. The SSRF
 * allowlist deliberately lives in `parseMenu`, the only caller reachable from a
 * request — NOT here — so the check can never be turned off by configuration.
 * Nothing that handles user input constructs a loader; the one in production is
 * built from the job's own allowlisted URLs.
 */
export type PageLoader = (page: number) => Promise<FetchedFile>;

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

/**
 * Page labels, absolute across the whole menu.
 *
 * These used to read `Page ${i + 1} of ${files.length}` where `i` was the index
 * WITHIN the batch — so on a 12-page menu the second batch was also labelled
 * "Page 1 of 6" … "Page 6 of 6". Any scheme where the model tells us which page
 * an item came from is worthless until this is right, and the model was being
 * asked to reason about a page ordering that didn't exist.
 */
interface PageLabels {
  firstPageNumber: number;
  totalPages: number;
  /** Category the previous batch ended inside, if any. */
  carryCategory?: string | null;
}

function labelFor(i: number, labels: PageLabels): { type: string; text: string } {
  return { type: "text", text: `Page ${labels.firstPageNumber + i} of ${labels.totalPages}:` };
}

/** The instruction that closes every call, plus any heading carried forward. */
function closingInstruction(labels: PageLabels): { type: string; text: string } {
  const carry = labels.carryCategory
    ? ` The page before Page ${labels.firstPageNumber} ended inside the category "${labels.carryCategory}"; if this batch opens with dishes under no heading, they continue that category.`
    : "";
  return { type: "text", text: `Digitise this menu. Output only the JSON object.${carry}` };
}

// --- Anthropic-native (Messages API) content blocks ---
// One block per page, in order, each labelled so the model can attribute a
// heading on page 4 to the items running onto page 5.
function anthropicContentBlocks(
  files: FetchedFile[],
  sourceKind: "image" | "pdf",
  labels: PageLabels
): unknown[] {
  return files.flatMap((file, i) => {
    const label = labelFor(i, labels);
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
function openaiContentBlocks(
  files: FetchedFile[],
  sourceKind: "image" | "pdf",
  labels: PageLabels
): unknown[] {
  const pages = files.flatMap((file, i) => {
    const label = labelFor(i, labels);
    const media =
      sourceKind === "pdf" || file.mediaType === "application/pdf"
        ? {
            type: "file",
            file: {
              filename: `menu-${labels.firstPageNumber + i}.pdf`,
              file_data: `data:application/pdf;base64,${file.base64}`
            }
          }
        : { type: "image_url", image_url: { url: `data:${file.mediaType};base64,${file.base64}` } };
    return [label, media];
  });
  return [...pages, closingInstruction(labels)];
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

/**
 * One request, whichever provider dialect is configured. The system prompt and
 * model are parameters rather than constants so the recovery pass can ask a
 * different question of a different model over the same transport.
 */
interface CallOptions {
  files: FetchedFile[];
  sourceKind: "image" | "pdf";
  labels: PageLabels;
  system: string;
  model: string;
  maxTokens: number;
  signal: AbortSignal;
}

async function callAnthropic(opts: CallOptions): Promise<OcrResponse> {
  const { files, sourceKind, labels, signal } = opts;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": env.MENU_OCR_API_KEY!,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens,
      system: opts.system,
      messages: [
        {
          role: "user",
          content: [...anthropicContentBlocks(files, sourceKind, labels), closingInstruction(labels)]
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

async function callOpenAiCompatible(opts: CallOptions): Promise<OcrResponse> {
  const { files, sourceKind, labels, signal } = opts;
  const base = env.MENU_OCR_BASE_URL!.replace(/\/$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.MENU_OCR_API_KEY!}`
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: openaiContentBlocks(files, sourceKind, labels) }
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

/**
 * The recovery pass: one page, re-read on its own, after the first pass got
 * nothing from it.
 *
 * Two things this prompt must do that the main one does not. It has to make
 * "there is nothing here" an explicitly CORRECT answer — a verifier told only
 * "list the priced dishes" and handed a genuine cover page will invent some,
 * which would turn a missing-items bug into an invented-items bug. And it asks
 * for the price exactly as printed alongside the cents, so a conversion slip can
 * be caught by a pure function rather than by a person.
 */
const VERIFY_SYSTEM_PROMPT = [
  "You are checking ONE page of a restaurant menu. A first pass read this page as",
  "containing no dishes, and that may have been a mistake. Your only job is to",
  "find every dish on this page that has a price printed next to it.",
  "Output ONLY this JSON object. No prose, no code fences.",
  '{ "has_priced_items": boolean, "page_note": string,',
  '  "categories": [ { "name": string, "items": [ { "name": string,',
  '    "description"?: string, "price_text": string, "price_cents": integer } ] } ] }',
  "Read the whole page, corner to corner. Include text set over or beside",
  "photographs, text in very large display type, and text in the margins.",
  "A dish counts if a name and a price appear together in any layout: side by",
  "side, price on the line below, price in a circle or badge, or joined by a",
  "line of dots.",
  '"price_text" is the price EXACTLY as printed, character for character (for',
  'example "$10", "10.-", "12,50", "99.–"). "price_cents" is that same price as',
  'integer cents: $10 -> 1000, "12,50" -> 1250, "99.–" means ninety-nine dollars',
  "-> 9900.",
  "Use the category headings printed on this page. If the page has priced dishes",
  "but no heading, use the single category name 'Menu'.",
  "Describe only this page. Do not carry anything over from other pages.",
  "If, after reading the whole page, there is genuinely no name-with-a-price",
  'anywhere on it, return "has_priced_items": false with "categories": [] and say',
  'plainly what the page is in "page_note" — for example "cover page", "contact',
  'details", "opening hours", "photographs only". An empty answer is a correct',
  "answer here. Never invent a dish or a price to fill the page.",
  "Never guess a price you cannot read. If a name is clearly a dish but its price",
  'is illegible, include it with "price_text": "" and "price_cents": 0.'
].join(" ");

/**
 * A shared ceiling over every call one job makes — first pass, halving retries
 * and recovery together. Exhaustion is never silent: the caller turns it into
 * `unverified` pages, which the owner is told about.
 */
function createCallBudget(maxCalls: number, budgetMs: number) {
  const deadline = Date.now() + budgetMs;
  let spent = 0;
  let exhausted = false;
  return {
    tryClaim(): boolean {
      if (spent >= maxCalls || Date.now() >= deadline) {
        exhausted = true;
        return false;
      }
      spent += 1;
      return true;
    },
    get calls(): number {
      return spent;
    },
    get isExhausted(): boolean {
      return exhausted;
    }
  };
}

type CallBudget = ReturnType<typeof createCallBudget>;

/** Shared transport for both prompts. Throws AppError; classification unchanged. */
async function dispatch(opts: Omit<CallOptions, "signal">): Promise<OcrResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.MENU_OCR_REQUEST_TIMEOUT_MS);
  try {
    // Dispatch on the configured provider dialect — Anthropic-native or any
    // OpenAI-compatible host (open-weight VLMs). Both return a uniform shape.
    const withSignal = { ...opts, signal: controller.signal };
    return env.MENU_OCR_PROVIDER === "openai"
      ? await callOpenAiCompatible(withSignal)
      : await callAnthropic(withSignal);
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
}

/** One vision call over a contiguous run of pages. */
async function parseBatch(input: {
  loadPage: PageLoader;
  sourceKind: "image" | "pdf";
  restaurantId?: string;
  firstPageNumber: number;
  totalPages: number;
  batchPages: number[];
  carryCategory: string | null;
  budget: CallBudget;
}): Promise<{ parts: PagePart[]; attributed: boolean }> {
  if (!input.budget.tryClaim()) {
    throw new AppError(502, "MENU_OCR_BUDGET_EXHAUSTED", "This menu needed more reading than we allow.");
  }
  const files: FetchedFile[] = [];
  for (const page of input.batchPages) files.push(await input.loadPage(page));

  const result = await dispatch({
    files,
    sourceKind: input.sourceKind,
    labels: {
      firstPageNumber: input.firstPageNumber,
      totalPages: input.totalPages,
      carryCategory: input.carryCategory
    },
    system: SYSTEM_PROMPT,
    model: env.MENU_OCR_MODEL,
    maxTokens: outputTokenBudget(files.length)
  });

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

  const parsed = menuOcrBatchSchema.safeParse(extractJson(result.text));
  if (!parsed.success) {
    logger.error({
      evt: "menu_ocr_schema_mismatch",
      first_page: input.firstPageNumber,
      issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 5)
    });
    throw new AppError(502, "MENU_OCR_BAD_OUTPUT", "The menu parser returned an unexpected shape.");
  }

  const normalised = normaliseBatchOutput(parsed.data, input.batchPages);
  if (!normalised.attributed) {
    // Usable items, no idea which page they came from. Said out loud so a
    // provider quietly ignoring the envelope shows up in the logs rather than
    // as every page mysteriously needing verification.
    logger.warn({
      evt: "menu_ocr_unattributed_batch",
      first_page: input.firstPageNumber,
      pages: input.batchPages.length
    });
  }
  return normalised;
}

/**
 * Re-read one page that produced nothing. Returns the items found, or an
 * explicit "there is nothing on this page" with the verifier's own description.
 *
 * Recovered rows are marked low-confidence on purpose: they come from a page the
 * first pass missed entirely, so they are exactly the rows worth a human glance,
 * and the review screen already flags anything under 0.5.
 */
async function verifyPage(input: {
  loadPage: PageLoader;
  page: number;
  totalPages: number;
  sourceKind: "image" | "pdf";
  restaurantId?: string;
  budget: CallBudget;
}): Promise<{ categories: MenuDraft["categories"]; note?: string }> {
  if (!input.budget.tryClaim()) {
    throw new AppError(502, "MENU_OCR_BUDGET_EXHAUSTED", "This menu needed more reading than we allow.");
  }
  const file = await input.loadPage(input.page);
  const model = env.MENU_OCR_VERIFY_MODEL || env.MENU_OCR_MODEL;

  const result = await dispatch({
    files: [file],
    sourceKind: input.sourceKind,
    labels: { firstPageNumber: input.page, totalPages: input.totalPages, carryCategory: null },
    system: VERIFY_SYSTEM_PROMPT,
    model,
    maxTokens: 8_000
  });

  logger.info({
    evt: "menu_ocr_verify_call",
    provider: env.MENU_OCR_PROVIDER,
    model,
    restaurant_id: input.restaurantId ?? null,
    page: input.page,
    input_tokens: result.inputTokens,
    output_tokens: result.outputTokens,
    truncated: result.truncated
  });

  if (result.truncated) {
    throw new AppError(502, "MENU_OCR_TRUNCATED", "The menu parser ran out of room on this page.");
  }

  const parsed = menuOcrVerifySchema.safeParse(extractJson(result.text));
  if (!parsed.success) {
    throw new AppError(502, "MENU_OCR_BAD_OUTPUT", "The menu parser returned an unexpected shape.");
  }

  const categories: MenuDraft["categories"] = parsed.data.categories.map((category) => ({
    name: category.name,
    items: category.items.map(({ price_text, ...item }) => {
      // The printed text and the model's own cents should agree. When they
      // don't, keep the model's number but drop the row's confidence further —
      // we can detect the disagreement, we can't adjudicate it.
      const fromText = parsePriceText(price_text ?? "");
      const mismatch = fromText !== null && fromText !== item.price_cents;
      if (mismatch) {
        logger.warn({
          evt: "menu_ocr_price_text_mismatch",
          page: input.page,
          price_text,
          price_cents: item.price_cents,
          parsed_cents: fromText
        });
      }
      return { ...item, confidence: mismatch ? 0.25 : 0.4 };
    })
  }));

  return parsed.data.page_note ? { categories, note: parsed.data.page_note } : { categories };
}

export interface ParseMenuResult {
  draft: MenuDraft;
  /** One entry per source page, in order. Never partial, never inferred. */
  pageResults: PageResult[];
}


/** Page order for the final merge, so recovered items sit where they belong. */
function inPageOrder(parts: PagePart[]): PagePart[] {
  return [...parts].sort((a, b) => (a.page ?? Number.MAX_SAFE_INTEGER) - (b.page ?? Number.MAX_SAFE_INTEGER));
}

/**
 * Report liveness without ever failing the work being reported on.
 *
 * heartbeatIngestionJob is a plain pool.query subject to the 15s query_timeout.
 * Awaited unguarded, a DB blip rejected, propagated out of parseMenu, and
 * runJob classified it PERMANENT — isTransient only accepts an AppError with
 * status 503, and a pg error is neither. markFailed then discarded a parse the
 * venue had already paid for in vision calls, and the owner was told to type
 * their menu in by hand, because one liveness UPDATE timed out.
 *
 * Missing a heartbeat is survivable: the worst case is the ten-minute reaper
 * re-claiming a job that is still running. Losing the parse is not.
 *
 * Exported so the swallow is actually testable rather than asserted by eye.
 */
export async function pingBatchDone(onBatchDone?: () => Promise<void>): Promise<void> {
  if (!onBatchDone) return;
  try {
    await onBatchDone();
  } catch (error) {
    logger.warn({
      evt: "menu_ocr_heartbeat_failed",
      error: (error as Error).message,
      detail: "job liveness ping failed; continuing the parse rather than discarding paid work"
    });
  }
}

/**
 * Read a whole menu — one page or fifty — and return a merged draft plus an
 * honest account of every page.
 *
 * Two passes. The first reads in batches so output never has to fit one
 * response. The second re-reads, one page at a time and with a different prompt
 * (and usually a different model), only the pages the first pass got NOTHING
 * from. That second pass is the point of this function: a cover-page heuristic
 * that fires on a page full of priced dishes has to be recoverable, and the only
 * way to tell "this page was blank" from "I missed this page" is to look again.
 *
 * `onBatchDone` is awaited after every call so the caller can prove the job is
 * alive — the claim query re-claims anything sitting in 'processing' for ten
 * minutes, and a long menu plus a recovery pass legitimately exceeds that.
 *
 * Error handling is deliberately asymmetric between the passes:
 *
 *   - Pass 1, 503 (rate limit, upstream 5xx, timeout) → throw, so the worker's
 *     backoff retries the whole job rather than dropping pages that would have
 *     worked a minute later. Unchanged from before.
 *   - Pass 1, truncation → halve the batch and retry once. Unchanged.
 *   - Pass 1, anything else → those pages are `unread` and we carry on.
 *   - Pass 2 NEVER throws. We already hold a good draft; throwing would re-run
 *     and re-pay for the entire first pass. A 503 stops the phase (the next call
 *     would 503 too) and the remaining pages become `unverified`.
 *
 * Running out of budget is never silently converted into "there was nothing on
 * that page" — that is the same lie in a cheaper costume.
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
  return parseMenuPages({
    totalPages: input.sourceUrls.length,
    // Every page still goes through the allowlisted fetcher. This wrapper is
    // the only path a request can reach, so the SSRF check cannot be bypassed
    // by configuration — see PageLoader.
    loadPage: (page) => fetchAsBase64(input.sourceUrls[page - 1]!),
    sourceKind: input.sourceKind,
    restaurantId: input.restaurantId,
    onBatchDone: input.onBatchDone
  });
}

/**
 * The orchestration, over pages obtained however the caller likes.
 *
 * Split out from parseMenu so the fixture corpus (scripts/smoke-menu-ocr.ts)
 * can drive the real batching, merging, recovery and accounting against menus
 * on disk. Everything except the fetch is exercised; the fetch has its own
 * tests in menuOcrClient.test.ts.
 *
 * Note there is deliberately no kill-switch check here: MENU_OCR_ENABLED is a
 * product rollout flag, not a "is the parser configured" flag, and the corpus
 * must be runnable whatever the rollout state.
 */
export async function parseMenuPages(input: {
  totalPages: number;
  loadPage: PageLoader;
  sourceKind: "image" | "pdf";
  restaurantId?: string;
  onBatchDone?: () => Promise<void>;
}): Promise<ParseMenuResult> {
  const totalPages = input.totalPages;
  const budget = createCallBudget(env.MENU_OCR_MAX_CALLS_PER_JOB, env.MENU_OCR_JOB_BUDGET_MS);
  const parts: PagePart[] = [];
  const outcomes = new Map<number, { status: PageStatus; note?: string }>();
  const markUnread = (pages: number[]) => {
    for (const page of pages) outcomes.set(page, { status: "unread" });
  };

  // --- Pass 1: batches, in order -------------------------------------------
  for (const batch of planBatches(totalPages, PAGES_PER_BATCH)) {
    try {
      const got = await parseBatch({
        loadPage: input.loadPage,
        sourceKind: input.sourceKind,
        restaurantId: input.restaurantId,
        firstPageNumber: batch.firstPage,
        totalPages,
        batchPages: batch.pages,
        carryCategory: lastCategoryOf(parts),
        budget
      });
      parts.push(...got.parts);
    } catch (error) {
      const truncated = error instanceof AppError && error.code === "MENU_OCR_TRUNCATED";
      if (truncated && batch.pages.length > 1) {
        // Too much asked for at once — halve and retry the two halves.
        const mid = Math.ceil(batch.pages.length / 2);
        for (const half of [batch.pages.slice(0, mid), batch.pages.slice(mid)]) {
          try {
            const got = await parseBatch({
              loadPage: input.loadPage,
              sourceKind: input.sourceKind,
              restaurantId: input.restaurantId,
              firstPageNumber: half[0]!,
              totalPages,
              batchPages: half,
              carryCategory: lastCategoryOf(parts),
              budget
            });
            parts.push(...got.parts);
          } catch {
            // Not re-thrown even when transient: re-running the job would re-pay
            // for every earlier batch. These pages fall through to pass 2, and
            // if that can't reach them either they are reported, not hidden.
            markUnread(half);
          }
        }
      } else if (error instanceof AppError && error.statusCode === 503) {
        throw error;
      } else {
        markUnread(batch.pages);
      }
    }
    await pingBatchDone(input.onBatchDone);
  }

  // --- Which pages gave us nothing? ----------------------------------------
  // Asked of the MERGED draft, not the raw responses: a page whose every row was
  // deduped away contributed nothing the owner will see, and must be treated the
  // same as a page that returned nothing at all.
  let merged = mergeAttributed(inPageOrder(parts));
  const { targets, skipped } = verificationTargets(
    totalPages,
    merged.perPage,
    env.MENU_OCR_MAX_VERIFY_PAGES
  );
  for (const page of skipped) outcomes.set(page, { status: "unverified" });

  // --- Pass 2: recovery. Never throws. -------------------------------------
  let stopVerifying = false;
  for (const page of targets) {
    if (stopVerifying) {
      outcomes.set(page, { status: "unverified" });
      continue;
    }
    try {
      const found = await verifyPage({
        loadPage: input.loadPage,
        page,
        totalPages,
        sourceKind: input.sourceKind,
        restaurantId: input.restaurantId,
        budget
      });
      const items = found.categories.reduce((n, c) => n + c.items.length, 0);
      if (items > 0) {
        parts.push({ page, categories: found.categories });
        outcomes.set(page, { status: "recovered" });
      } else {
        // A positive determination, not an absence of evidence — this is the
        // one path allowed to mark a page fine without producing any items.
        outcomes.set(
          page,
          found.note ? { status: "empty_confirmed", note: found.note } : { status: "empty_confirmed" }
        );
      }
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 503) stopVerifying = true;
      outcomes.set(page, { status: "unverified" });
    }
    await pingBatchDone(input.onBatchDone);
  }

  if (targets.length > 0) merged = mergeAttributed(inPageOrder(parts));

  // Note a recovered page can still show 0 items here: everything on it was
  // already in the draft under another page. The dishes reach the owner either
  // way, so the page stays accounted for rather than reporting a phantom loss.
  const pageResults = buildPageResults(totalPages, merged.perPage, outcomes);
  const itemCount = merged.draft.categories.reduce((n, c) => n + c.items.length, 0);

  // Zero items is a failure, not a success. It used to pass validation and land
  // the owner on a review screen reading "I read 0 items — everything looked
  // clear" with the continue button disabled: a dead end that claimed success.
  // Checked AFTER recovery, so a menu whose only item page looked like a cover
  // is rescued rather than dead-lettered.
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
    pages_total: totalPages,
    calls: budget.calls,
    budget_exhausted: budget.isExhausted,
    verified_pages: targets.length,
    recovered_pages: pageResults.filter((p) => p.status === "recovered").map((p) => p.page),
    unaccounted_pages: unaccountedPages(pageResults),
    categories: merged.draft.categories.length,
    items: itemCount
  });

  return { draft: merged.draft, pageResults };
}
