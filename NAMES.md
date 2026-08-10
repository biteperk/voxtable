# NAMES.md — the naming registry

> 🏷️ **This file is the single source of truth for every name in the BitePerk/VoxTable
> estate** — products, hostnames, GCP projects, services, images, repos, branches.
> **Check it before you name anything, and before you type a name you "remember".**
> When this file and any other doc disagree, this file wins and the other doc gets
> fixed. Migrations here are **additive — old names keep serving; never a cutover.**
> Minting a new name the tables don't cover? Extend THIS file in the same PR.

Last full audit: 7 Aug 2026, cross-checked against `deploy/runbooks/domain-migration.md`,
`deploy/runbooks/staging-cloudrun-bootstrap.md`, and the Terraform in
`biteperk/biteperk-cloud-platform` (`roots/products/voxtable/`).

## 1. Brand & product names

Visual identity, tokens, wordmark and NAP facts live in the website repo's
**`BRAND.md`** (portable kit) — this section only fixes the *names*.

| Name | What it is | Rules |
|---|---|---|
| **BitePerk** / `biteperk` | The company | **Never renames.** The wordmark is `bite`+`perk` — bulk product renames have eaten it twice; verify branding by rendering to pixels, never by grep. |
| **Vox** | Umbrella product | |
| **VoxTable** | Bookings (this repo's product) | CamelCase, "by BitePerk". |
| **VoxOrder**, **VoxConcierge** | Takeaway · front-of-house | VoxConcierge sellable only behind `SERVICES_VOXCONCIERGE_ENABLED`. |
| **VoxDrive** | Drive-thru concept | **Concept only — never sellable, never in a services enum.** Its absence from `AGREEMENT_SERVICES` is the enforcement. |
| **VoxStay** | Hotel pitch material | **Pitch-only — never in site or app code.** |
| **Bella** | The voice persona | Never renames. |
| ~~VocoTable~~, ~~PerkTable~~ | Retired product names | Historical narration only. Never introduce in new code, docs, or UI. |

## 2. Customer-facing hostnames (domain migration, in flight since 3 Aug 2026)

Procedure SSOT: [`deploy/runbooks/domain-migration.md`](deploy/runbooks/domain-migration.md).
**Every "old" hostname is still serving and must not be removed** until Phase 6's
90-day grace period completes.

| Surface | New name | Old name(s) — still serving | Status (7 Aug 2026) |
|---|---|---|---|
| Client dashboard | `app.biteperk.com.au` | `vocotable.biteperk.com.au`, `vocotable.web.app` | Firebase Hosting target `app`; custom domain pending (Phase 5) |
| Backend API | `api.biteperk.com.au` | `vocotable.algorythmos.com.au` | **Live on both names** since 3 Aug (one cert covers both); Stripe repointed 3 Aug; Cal.com → Retell → Twilio cut over one at a time (Phase 4) |
| Kitchen display | `kds.biteperk.com.au` | `kitchen.vocotable.biteperk.com.au`, `vocotable-kds.web.app` | Firebase Hosting target `kds`; custom domain pending (Phase 5) |
| Public brand site | `biteperk.com.au` | — | Live (Vox rename shipped 22 Jul 2026) |

Note: the prod Terraform `CORS_ALLOWED_ORIGINS` currently lists the legacy set +
`bp-voxtable-prod.web.app` — the `app.`/`kds.` names get added there at Phase 5,
not before.

## 3. GCP / infrastructure names (the Terraform world)

Terraform SSOT: **`biteperk/biteperk-cloud-platform`** (`roots/`). Names are minted
there; this table registers them.

| Thing | Name |
|---|---|
| Staging project | `bp-voxtable-stg` |
| Production project (created at cutover) | `bp-voxtable-prod` — **`-prod`, never `-prd`**. Older notes had `-prd`; Terraform enforces the correct form (`roots/products/voxtable/prod/variables.tf` validation). |
| Shared registry project | `bp-shared-artifacts` |
| Docker images (new world) | `australia-southeast1-docker.pkg.dev/bp-shared-artifacts/voxtable/api` and `…/worker` |
| Cloud Run — staging (exists today) | `voxtable-stg-api`, `voxtable-stg-worker`, `voxtable-stg-migrate`, `voxtable-stg-postgres`, `voxtable-stg-retell`, `voxtable-stg-twilio`, `voxtable-stg-runtime` (see `deploy/runbooks/staging-cloudrun-bootstrap.md`) |
| Cloud Run — production (pattern; created at cutover, does NOT exist yet) | `voxtable-prod-<service>` mirroring the staging fleet |
| Firebase Hosting (new world) | `bp-voxtable-stg.web.app` / `bp-voxtable-prod.web.app` |
| Database roles (Cloud SQL) | `voxtable_owner` (migrations) / `voxtable_app` (runtime) |
| Repos | product `biteperk/voxtable` (renamed from `biteperk/vocotable`) · infra `biteperk/biteperk-cloud-platform` · marketing site `biteperk/biteperk-website` |
| Branches (product repo, since 1 Aug 2026) | `integration` (default; deploys staging) · `main` (production; reached by promotion only) |

## 4. Immutable legacy identities — NEVER rename

These look like leftovers. They are not. Each has a hard reason:

| Identity | Why it can never change |
|---|---|
| Firebase/GCP project `vocotable` / `vocotable-497209` | Project ids are immutable in GCP. |
| `SYNTH_EMAIL_DOMAIN=bookings.vocotable.algorythmos.com.au` (`services/calcomService.ts`) | Baked into the attendee identity of every existing Cal.com booking; changing it orphans them. Internal-only, never shown to customers. |
| `vocotable_number` API field | Public API contract. |
| `vocotable.*` localStorage keys + `vocotable:*` window events | Persisted in customers' browsers. |
| Legacy VM-world registry `us-central1-docker.pkg.dev/vocotable-497209/vocotable/*` | Serves the VM production until the Cloud Run cutover retires it. |
| Legacy `voco*` / `perk*` URL slugs (website 301s + `PRODUCT_SLUGS`) | Printed collateral and cached links use them — keep forever. |
| Local checkout dir `~/vocotable` | Sam's machine; scripts and muscle memory point at it. Renaming buys nothing. |

## 5. Conventions for minting NEW names

- GCP projects: `bp-<product>-<env>`, env ∈ `stg` \| `prod` (three letters vs four — see §3).
- Cloud Run services: `<product>-<env>-<service>`.
- Customer-facing surfaces: `<surface>.biteperk.com.au`, DNS-only (gray cloud) in Cloudflare.
- Kebab-case everywhere a platform allows it.
- The string `vocotable` **never appears in a new name** — it exists only in §4.
- If the tables above don't cover your case: pick the name following these rules,
  and add it to this file **in the same PR**.
