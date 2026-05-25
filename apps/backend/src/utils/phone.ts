import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

/**
 * Normalise a free-form phone number (whatever the LLM transcribed) into E.164.
 * Returns null if the input can't plausibly be a phone number.
 * Default region is AU; callers can override (e.g., en-US restaurants).
 */
export function normalizePhone(
  raw: string | null | undefined,
  region: CountryCode = "AU"
): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Strip common "withheld" markers from telephony providers.
  const lower = trimmed.toLowerCase();
  if (
    lower === "anonymous" ||
    lower === "unknown" ||
    lower === "private" ||
    lower === "blocked" ||
    lower === "restricted"
  ) {
    return null;
  }

  try {
    const parsed = parsePhoneNumberFromString(trimmed, region);
    if (parsed?.isValid()) {
      return parsed.number; // E.164 format e.g. +61400111222
    }
  } catch {
    // fall through
  }
  return null;
}
