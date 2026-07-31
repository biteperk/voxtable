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

// Vision-LLM output cap — generous enough for a full menu's structured JSON.
const OCR_MAX_TOKENS = 4096;

const SYSTEM_PROMPT = [
  "You are a precise menu digitiser for a restaurant booking platform.",
  "You receive an image or PDF of a restaurant menu and must extract its",
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
  "and confidence below 0.4. Group items under the categories printed on the menu."
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

// --- Anthropic-native (Messages API) content block ---
function anthropicContentBlock(file: FetchedFile, sourceKind: "image" | "pdf"): unknown {
  if (sourceKind === "pdf" || file.mediaType === "application/pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: file.base64 } };
  }
  return { type: "image", source: { type: "base64", media_type: file.mediaType, data: file.base64 } };
}

// --- OpenAI-compatible (/chat/completions) content block ---
// Used for open-weight VLM hosts (OpenRouter, Together, Fireworks, DeepInfra,
// Gemini's OpenAI shim, local Ollama). Images go as a data: URL under
// image_url; PDFs are not universally supported on this shape, so we send them
// via the `file` block that OpenRouter/Gemini accept, falling back to image_url
// for image sources.
function openaiContentBlocks(file: FetchedFile, sourceKind: "image" | "pdf"): unknown[] {
  const text = { type: "text", text: "Digitise this menu. Output only the JSON object." };
  if (sourceKind === "pdf" || file.mediaType === "application/pdf") {
    return [
      {
        type: "file",
        file: { filename: "menu.pdf", file_data: `data:application/pdf;base64,${file.base64}` }
      },
      text
    ];
  }
  return [
    { type: "image_url", image_url: { url: `data:${file.mediaType};base64,${file.base64}` } },
    text
  ];
}

interface OcrResponse {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

async function callAnthropic(file: FetchedFile, sourceKind: "image" | "pdf", signal: AbortSignal): Promise<OcrResponse> {
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
      max_tokens: OCR_MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            anthropicContentBlock(file, sourceKind),
            { type: "text", text: "Digitise this menu. Output only the JSON object." }
          ]
        }
      ]
    })
  });
  if (!res.ok) throw await upstreamError(res);
  const json = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  return {
    text: (json.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n"),
    inputTokens: json.usage?.input_tokens ?? null,
    outputTokens: json.usage?.output_tokens ?? null
  };
}

async function callOpenAiCompatible(file: FetchedFile, sourceKind: "image" | "pdf", signal: AbortSignal): Promise<OcrResponse> {
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
      max_tokens: OCR_MAX_TOKENS,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: openaiContentBlocks(file, sourceKind) }
      ]
    })
  });
  if (!res.ok) throw await upstreamError(res);
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    text: json.choices?.[0]?.message?.content ?? "",
    inputTokens: json.usage?.prompt_tokens ?? null,
    outputTokens: json.usage?.completion_tokens ?? null
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
  return JSON.parse(cleaned.slice(start, end + 1));
}

export async function parseMenu(input: {
  sourceUrl: string;
  sourceKind: "image" | "pdf";
  restaurantId?: string;
}): Promise<MenuDraft> {
  if (!isMenuOcrEnabled()) {
    throw new AppError(503, "MENU_OCR_DISABLED", "Menu OCR is not enabled.");
  }

  const file = await fetchAsBase64(input.sourceUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.MENU_OCR_REQUEST_TIMEOUT_MS);
  let responseText: string;
  try {
    // Dispatch on the configured provider dialect — Anthropic-native or any
    // OpenAI-compatible host (open-weight VLMs). Both return a uniform shape.
    const result =
      env.MENU_OCR_PROVIDER === "openai"
        ? await callOpenAiCompatible(file, input.sourceKind, controller.signal)
        : await callAnthropic(file, input.sourceKind, controller.signal);

    // Cost attribution: log token usage per call so vision spend can be tracked
    // per restaurant (B2). Tokens, not dollars, to stay provider-price-agnostic.
    logger.info({
      evt: "menu_ocr_call",
      provider: env.MENU_OCR_PROVIDER,
      model: env.MENU_OCR_MODEL,
      restaurant_id: input.restaurantId ?? null,
      source_kind: input.sourceKind,
      file_bytes: Math.round((file.base64.length * 3) / 4),
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens
    });
    responseText = result.text;
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

  // Validate the model output against the same schema the API + commit use.
  const parsed = menuDraftSchema.safeParse(extractJson(responseText));
  if (!parsed.success) {
    logger.error({
      evt: "menu_ocr_schema_mismatch",
      issues: parsed.error.issues.map((i) => i.message).slice(0, 5)
    });
    throw new AppError(502, "MENU_OCR_BAD_OUTPUT", "The menu parser returned an unexpected shape.");
  }
  return parsed.data;
}
