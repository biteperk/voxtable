# Legal Documents

Published Client Services Agreement and Privacy & Data Handling Schedule PDFs live in this repo so the document set reviewed in GitHub is the same one published to the environment bucket.

Use one immutable folder per document set:

```text
legal-documents/versions/<document_set_version>/
  client-services-agreement.pdf
  privacy-data-handling-schedule.pdf
```

Example:

```text
legal-documents/versions/CSA-2026-08/
  client-services-agreement.pdf
  privacy-data-handling-schedule.pdf
```

Publishing is manual from GitHub Actions:

1. Open **Actions -> Publish legal documents**.
2. Select the correct branch: `integration` for `staging`, `main` for `production`.
3. Choose `staging` or `production`.
4. Enter the `document_set_version`.
5. Confirm the two PDF paths.
6. Run with `dry_run=true` first to print the manifest and hashes.
7. Run again with `dry_run=false` and `publish_current=true` to upload the PDFs and update `current/manifest.json`.

Required GitHub Environment variables:

```text
GCP_WORKLOAD_IDENTITY_PROVIDER=...
GCP_FRONTEND_DEPLOY_SERVICE_ACCOUNT=...
VOXTABLE_PROJECT_ID=bp-voxtable-stg
```

Use `VOXTABLE_PROJECT_ID=bp-voxtable-prod` in the production environment.
The workflow derives the bucket as:

```text
<VOXTABLE_PROJECT_ID>-legal-documents
```

The frontend derives the manifest URL from `VITE_FIREBASE_PROJECT_ID` using the same convention:

```text
https://storage.googleapis.com/<VITE_FIREBASE_PROJECT_ID>-legal-documents/current/manifest.json
```

The workflow uploads:

```text
gs://<env-bucket>/versions/<document_set_version>/client-services-agreement.pdf
gs://<env-bucket>/versions/<document_set_version>/privacy-data-handling-schedule.pdf
gs://<env-bucket>/current/manifest.json
```

The frontend reads the manifest, displays the linked PDFs, and submits `document_set_version`, `csa_url`, `schedule_url`, `csa_sha256`, and `schedule_sha256` with the onboarding agreement payload.

Keep versioned document folders immutable after publication. Publish a new document set for any legal text change.
