import { z } from "zod";

import { env } from "../config/env";
import { AppError } from "../domain/errors";
import { logger } from "../utils/logger";

/**
 * Server-side view of the legal-documents manifest (#196).
 *
 * The wizard fetches `current/manifest.json` from the legal-documents bucket
 * and submits the version/URLs/hashes with the acceptance. Those values end up
 * in the append-only agreement_acceptances ledger, so the SERVER must vouch
 * for them: this module fetches the same manifest and the acceptance route
 * refuses anything that doesn't match it. The ledger is only evidence if the
 * browser can't choose what goes in it.
 *
 * Fail-closed by design: if the manifest can't be fetched, acceptance is
 * refused (503) rather than recorded unverified. Verification is active
 * whenever LEGAL_DOCUMENTS_MANIFEST_URL is set; when unset (local dev without
 * a bucket) the route skips it with a warning, and env.ts refuses production
 * boots with self-serve signup on and no manifest URL.
 */

const SHA256_HEX = /^[a-fA-F0-9]{64}$/;

const httpsUrl = z
  .string()
  .url()
  .refine((url) => url.startsWith("https://"), "must be an HTTPS URL");

const sha256 = z
  .string()
  .trim()
  .regex(SHA256_HEX, "must be a 64-character SHA-256 hex digest")
  .transform((s) => s.toLowerCase());

// Mirrors validateLegalDocumentsManifest in
// apps/frontend/src/lib/legalDocuments.js — keep the two in sync.
export const legalDocumentsManifestSchema = z.object({
  document_set_version: z.string().trim().min(1).max(120),
  csa_url: httpsUrl,
  schedule_url: httpsUrl,
  csa_sha256: sha256,
  schedule_sha256: sha256
});

export type LegalDocumentsManifest = z.infer<typeof legalDocumentsManifestSchema>;

const MANIFEST_CACHE_TTL_MS = 60_000;
const MANIFEST_FETCH_TIMEOUT_MS = 5_000;

let cached: { manifest: LegalDocumentsManifest; fetchedAt: number } | null = null;

/** Test hook — the cache is module state. */
export function clearManifestCache(): void {
  cached = null;
}

export function legalDocumentsVerificationEnabled(): boolean {
  return Boolean(env.LEGAL_DOCUMENTS_MANIFEST_URL);
}

/**
 * Fetch (with a short cache) the published manifest. Throws 503
 * TERMS_MANIFEST_UNAVAILABLE on any failure — never returns stale-unknown.
 */
export async function getPublishedLegalDocuments(): Promise<LegalDocumentsManifest> {
  const url = env.LEGAL_DOCUMENTS_MANIFEST_URL;
  if (!url) {
    throw new AppError(
      503,
      "TERMS_MANIFEST_UNAVAILABLE",
      "LEGAL_DOCUMENTS_MANIFEST_URL is not configured."
    );
  }

  const now = Date.now();
  if (cached && now - cached.fetchedAt < MANIFEST_CACHE_TTL_MS) {
    return cached.manifest;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MANIFEST_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`manifest fetch returned ${response.status}`);
    }
    const manifest = legalDocumentsManifestSchema.parse(await response.json());
    cached = { manifest, fetchedAt: now };
    return manifest;
  } catch (error) {
    logger.error({
      message: "legal_documents_manifest_fetch_failed",
      error
    });
    throw new AppError(
      503,
      "TERMS_MANIFEST_UNAVAILABLE",
      "The published agreement documents could not be verified right now. Please try again shortly."
    );
  } finally {
    clearTimeout(timer);
  }
}

export interface AcceptanceDocumentClaims {
  document_set_version: string;
  csa_url: string;
  schedule_url: string;
  csa_sha256: string;
  schedule_sha256: string;
}

/**
 * Refuse an acceptance whose document claims differ from the published
 * manifest. 409 TERMS_VERSION_MISMATCH — the usual innocent cause is a stale
 * tab open across a document republish, so the message says to reload.
 */
export function assertAcceptanceMatchesPublished(
  claims: AcceptanceDocumentClaims,
  manifest: LegalDocumentsManifest
): void {
  const mismatched: string[] = [];
  if (claims.document_set_version.trim() !== manifest.document_set_version) {
    mismatched.push("document_set_version");
  }
  if (claims.csa_url.trim() !== manifest.csa_url) mismatched.push("csa_url");
  if (claims.schedule_url.trim() !== manifest.schedule_url) mismatched.push("schedule_url");
  if (claims.csa_sha256.trim().toLowerCase() !== manifest.csa_sha256) {
    mismatched.push("csa_sha256");
  }
  if (claims.schedule_sha256.trim().toLowerCase() !== manifest.schedule_sha256) {
    mismatched.push("schedule_sha256");
  }
  if (mismatched.length > 0) {
    throw new AppError(
      409,
      "TERMS_VERSION_MISMATCH",
      "The agreement documents changed while this page was open. Please reload and review them again.",
      { mismatched_fields: mismatched, published_version: manifest.document_set_version }
    );
  }
}

/**
 * Refuse acceptances against an unpublished document set (#198). SAMPLE-* and
 * DRAFT-* versions are placeholders; recording a legal acceptance against one
 * is worse than refusing. TERMS_ALLOW_UNPUBLISHED_DOCS (default off) lets
 * staging keep testing the wizard before the real CSA text ships (#164).
 */
export function assertPublishedVersionAllowed(manifest: LegalDocumentsManifest): void {
  if (env.TERMS_ALLOW_UNPUBLISHED_DOCS) return;
  if (/^(sample|draft)/i.test(manifest.document_set_version)) {
    throw new AppError(
      503,
      "TERMS_NOT_PUBLISHED",
      "The agreement documents are not final yet, so acceptances can't be recorded. Please try again once the agreement is published.",
      { published_version: manifest.document_set_version }
    );
  }
}
