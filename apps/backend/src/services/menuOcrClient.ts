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

async function fetchAsBase64(sourceUrl: string): Promise<FetchedFile> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.MENU_OCR_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(sourceUrl, { signal: controller.signal });
    if (!res.ok) {
      throw new AppError(502, "MENU_OCR_FETCH_FAILED", `Could not fetch the uploaded file (${res.status}).`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const maxBytes = env.MENU_OCR_MAX_FILE_MB * 1024 * 1024;
    if (buf.byteLength > maxBytes) {
      throw new AppError(413, "MENU_OCR_FILE_TOO_LARGE", `File exceeds ${env.MENU_OCR_MAX_FILE_MB}MB.`);
    }
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

function contentBlockFor(file: FetchedFile, sourceKind: "image" | "pdf"): unknown {
  if (sourceKind === "pdf" || file.mediaType === "application/pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: file.base64 } };
  }
  return { type: "image", source: { type: "base64", media_type: file.mediaType, data: file.base64 } };
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
}): Promise<MenuDraft> {
  if (!isMenuOcrEnabled()) {
    throw new AppError(503, "MENU_OCR_DISABLED", "Menu OCR is not enabled.");
  }

  const file = await fetchAsBase64(input.sourceUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.MENU_OCR_REQUEST_TIMEOUT_MS);
  let responseText: string;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": env.MENU_OCR_API_KEY!,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: env.MENU_OCR_MODEL,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              contentBlockFor(file, input.sourceKind),
              { type: "text", text: "Digitise this menu. Output only the JSON object." }
            ]
          }
        ]
      })
    });

    if (!res.ok) {
      const body = await res.text();
      // Log status + a short body snippet (no API key — it's only in the header).
      logger.error({ evt: "menu_ocr_upstream_error", status: res.status, body: body.slice(0, 300) });
      const transient = res.status === 429 || res.status >= 500;
      throw new AppError(
        transient ? 503 : 502,
        "MENU_OCR_UPSTREAM_ERROR",
        "The menu parser is temporarily unavailable."
      );
    }

    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    responseText = (json.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");
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
