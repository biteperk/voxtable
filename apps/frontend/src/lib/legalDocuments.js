const REQUIRED_MANIFEST_FIELDS = [
  "document_set_version",
  "csa_url",
  "schedule_url",
  "csa_sha256",
  "schedule_sha256"
];

const SHA256_HEX = /^[a-fA-F0-9]{64}$/;

export function legalDocumentsManifestUrl(env = import.meta.env) {
  const override = (env.VITE_LEGAL_DOCUMENTS_MANIFEST_URL ?? "").trim();
  if (override) return override;

  const projectId = (env.VITE_FIREBASE_PROJECT_ID ?? "").trim();
  return projectId
    ? `https://storage.googleapis.com/${projectId}-legal-documents/current/manifest.json`
    : "";
}

export function missingLegalDocumentKeys(env = import.meta.env) {
  return legalDocumentsManifestUrl(env) ? [] : ["VITE_FIREBASE_PROJECT_ID"];
}

export function validateLegalDocumentsManifest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Legal documents manifest must be a JSON object.");
  }

  const missing = REQUIRED_MANIFEST_FIELDS.filter((field) => typeof raw[field] !== "string" || !raw[field].trim());
  if (missing.length > 0) {
    throw new Error(`Legal documents manifest is missing: ${missing.join(", ")}.`);
  }

  const manifest = {
    document_set_version: raw.document_set_version.trim(),
    csa_url: raw.csa_url.trim(),
    schedule_url: raw.schedule_url.trim(),
    csa_sha256: raw.csa_sha256.trim().toLowerCase(),
    schedule_sha256: raw.schedule_sha256.trim().toLowerCase()
  };

  for (const field of ["csa_url", "schedule_url"]) {
    try {
      const url = new URL(manifest[field]);
      if (url.protocol !== "https:") throw new Error("not https");
    } catch {
      throw new Error(`Legal documents manifest field ${field} must be an HTTPS URL.`);
    }
  }

  for (const field of ["csa_sha256", "schedule_sha256"]) {
    if (!SHA256_HEX.test(manifest[field])) {
      throw new Error(`Legal documents manifest field ${field} must be a 64-character SHA-256 hex digest.`);
    }
  }

  return manifest;
}

export async function fetchLegalDocumentsManifest(fetchImpl = fetch, env = import.meta.env) {
  const url = legalDocumentsManifestUrl(env);
  if (!url) {
    throw new Error("Legal documents manifest URL could not be derived because VITE_FIREBASE_PROJECT_ID is not configured.");
  }

  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`Could not load legal documents manifest (${response.status}).`);
  }

  return validateLegalDocumentsManifest(await response.json());
}
