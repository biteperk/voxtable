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
| Production project (**exists as an empty shell**) | `bp-voxtable-prod` — **`-prod`, never `-prd`**. Older notes had `-prd`; Terraform enforces the correct form (`roots/products/voxtable/prod/variables.tf` validation). ⚠️ The project **does** exist — one secret, Cloud Run API not even enabled — so "does the project exist?" answers a misleading *yes*. Nothing runs there; production is still the VM. |
| Shared registry project | `bp-shared-artifacts` |
| Docker images (new world) | `australia-southeast1-docker.pkg.dev/bp-shared-artifacts/voxtable/api` and `…/worker` |
| Cloud Run **services** — staging (exist today) | `voxtable-stg-api`, `voxtable-stg-worker` |
| Cloud Run **job** — staging | `voxtable-stg-migrate` (runs `dist/db/migrate.js`; not a service) |
| Cloud SQL **instance** — staging | `voxtable-stg-postgres` (a database, not a Cloud Run service) |
| Service **account** — staging runtime | `voxtable-stg-runtime@…iam.gserviceaccount.com` |
| Secret Manager **name prefixes** — staging | `voxtable-stg-retell-*`, `voxtable-stg-twilio-*` (see `deploy/runbooks/staging-secrets.md` for the full registry) |
| Cloud Run — production (pattern; created at cutover, no services exist yet) | `voxtable-prod-<service>` mirroring the staging fleet |
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

## 6. Per-venue vendor resources (multi-tenant scale rules)

A tenant is DATA, not infrastructure: the `restaurants` row is the registry
(the single source of truth for every id below), and no venue ever gets its
own GCP project, repo, or branch. When provisioning a venue:

| Resource | Convention | Example |
|---|---|---|
| Twilio number friendly name | `voxtable: <venue-slug> <restaurant-uuid-first8>` | `voxtable: cuban-corner-parramatta ecfca4b0` |
| Retell agent | `<Venue Name> (VoxTable)` — one agent **and one LLM** per venue (a shared LLM means one venue's prompt edit rewrites another's live agent) | `Cuban Corner Parramatta (VoxTable)` |
| Stripe Customer / Connect account | `metadata.restaurant_id = <uuid>` on both | — |
| Number registration | Retell import with `inbound_webhook_url` (webhook mode) — never a static `inbound_agent_id` binding | — |

Where each id is recorded: `restaurants.twilio_phone_number`,
`retell_phone_number`, `retell_agent_id`, `stripe_customer_id`,
`stripe_connect_account_id`. Nowhere else — no spreadsheets. Full procedure:
`deploy/runbooks/venue-onboarding.md`.

### Live per-venue identifiers (Retell)

Recorded here because nothing else outside the database holds them, and a
missed rebind fails silently at call time. Keys and account credentials stay in
the gitignored `deploy/runbooks/vendor-accounts.local.md`.

**Going forward — BitePerk-owned account** (`biteperk@gmail.com`), workspace
**Biteperk**. These are the ids new work should target:

| Venue | Retell agent | Retell LLM |
|---|---|---|
| Natalia's Bistro | `agent_5b5df167525452db98cda2112f` | `llm_18ad6f5adedc865b7ffd02a121e1` |
| Cuban Corner Parramatta | `agent_2892d65ceace4e68d8a3f3e80c` | `llm_53c6e9de9aac3b60270ffdd6bcba` |

The **Staging** workspace in the same account carries a parallel pair, built
13 Aug and pointed at the staging API rather than production:
Natalia's `agent_b9087333b7030f0cee06a19ffc` / `llm_7c0a5c84498b81a5c723521038ef`;
Cuban Corner `agent_a9c17694d805908f4b9a7bd4b9` / `llm_472328dafafd697a3c8e67230457`.

**Legacy — Algorythmos-owned** (`retellai@algorythmos.com.au`, org
`org_f0DPXgKIQTMJL4je`). A **different company's** workspace, out of BitePerk's
scope. It still answers the pilot line until Natalia's is cut over
([`NUMBERS.md`](NUMBERS.md) §8), and it carries no obligation afterwards — the
calls recorded there were tests, not customer audio. Recorded only so the ids
below are not mistaken for current ones:

| Venue | Retell agent | Retell LLM |
|---|---|---|
| Natalia's Bistro | `agent_7b7a5f6c21c9968ee88afd3bac` | `llm_2cad4da643f2beb4d07dd0b311d1` |
| Cuban Corner Parramatta | `agent_93864e80fbaab14b5168e8f7b9` | `llm_adc242c622b8dffd32c24495edbd` |

The backend can only ever serve **one** Retell account per environment (one API
key, one webhook secret), so switching is an atomic cutover, never a gradual
move — which is why both sets are recorded rather than one being deleted.

Each venue owns a **separate LLM object**. Sharing one is the trap that makes a
prompt edit for one venue rewrite another venue's live agent.
