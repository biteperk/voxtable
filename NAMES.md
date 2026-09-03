# NAMES.md — the naming registry

> 🏷️ **This file is the single source of truth for every name in the BitePerk/VoxTable
> estate** — products, hostnames, GCP projects, services, images, repos, branches.
> **Check it before you name anything, and before you type a name you "remember".**
> When this file and any other doc disagree, this file wins and the other doc gets
> fixed. Legacy names may redirect, but must never keep a sandbox backend serving.
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
| **VoxStay** | Hotels — front desk | **Visible in the client app, not sellable** (amended 20 Aug 2026: hotels became a real segment). It appears in the venue home page's product list as `coming-soon`, and is deliberately **absent from `AGREEMENT_SERVICES`** — there is nothing to contract yet. Still **never in public site code or marketing material** until that changes. |
| **Bella** | The voice persona | Never renames. |
| ~~VocoTable~~, ~~PerkTable~~ | Retired product names | Historical narration only. Never introduce in new code, docs, or UI. |

## 2. Customer-facing hostnames

Procedure SSOT: [`deploy/runbooks/domain-migration.md`](deploy/runbooks/domain-migration.md).
Production application hostnames resolve only to the production Firebase/Cloud Run estate.
Legacy names may redirect; they must not route application traffic to `core-central-vm`.

| Surface | New name | Old name(s) — still serving | Status (25 Aug 2026) |
|---|---|---|---|
| Client dashboard | `voxtable.biteperk.com.au` | `vocotable.web.app` (~~`vocotable.biteperk.com.au`~~ — **no DNS record exists**, checked in Cloudflare 2 Sep 2026; the custom domain was never/no-longer wired, only the `web.app`/`firebaseapp.com` URLs serve) | Firebase Hosting target `app`; custom domain pending (Phase 5). Decision 25 Aug 2026: product-named subdomain **supersedes the never-shipped `app.biteperk.com.au`** — `app.` was planned, never had DNS/cert/traffic, and must not be created |
| Backend API | `api.biteperk.com.au` | `vocotable.algorythmos.com.au` (redirect/retire; never a VM production origin) | Cloud Run `voxtable-prod-api` in `bp-voxtable-prod` |
| Kitchen display | `kds.biteperk.com.au` | `vocotable-kds.web.app` (~~`kitchen.vocotable.biteperk.com.au`~~ — **no DNS record exists**, checked in Cloudflare 2 Sep 2026) | Firebase Hosting target `kds`; custom domain pending (Phase 5) |
| Public brand site | `biteperk.com.au` | — | Live (Vox rename shipped 22 Jul 2026) |
| VoxOrder (reserved) | `voxorder.biteperk.com.au` | — | 301 → `biteperk.com.au/au-en/products/voxorder` (Cloudflare redirect rule); becomes the product's app host when one exists |
| VoxConcierge (reserved) | `voxconcierge.biteperk.com.au` | — | 301 → `biteperk.com.au/au-en/products/voxconcierge`; same rule |
| VoxStay (reserved) | `voxstay.biteperk.com.au` | — | 301 → `biteperk.com.au/au-en/` (VoxStay has no public page — the pitch-only rule holds); same rule |

VoxDrive deliberately has **no** subdomain — §1 marks it concept-only, never sellable.

Note: the prod Terraform `CORS_ALLOWED_ORIGINS` currently lists the legacy set +
`bp-voxtable-prod.web.app` — the `voxtable.`/`kds.` names get added there at Phase 5,
not before.

## 3. GCP / infrastructure names (the Terraform world)

Terraform SSOT: **`biteperk/biteperk-cloud-platform`** (`roots/`). Names are minted
there; this table registers them.

| Thing | Name |
|---|---|
| Staging project | `bp-voxtable-stg` |
| Production project | `bp-voxtable-prod` — **`-prod`, never `-prd`**. Cloud Run, Cloud SQL, Firebase and Secret Manager production resources live here. |
| Shared registry project | `bp-shared-artifacts` |
| Docker images (new world) | `australia-southeast1-docker.pkg.dev/bp-shared-artifacts/voxtable/api` and `…/worker` |
| Cloud Run **services** — staging (exist today) | `voxtable-stg-api`, `voxtable-stg-worker` |
| Cloud Run **job** — staging | `voxtable-stg-migrate` (runs `dist/db/migrate.js`; not a service) |
| Cloud SQL **instance** — staging | `voxtable-stg-postgres` (a database, not a Cloud Run service) |
| Service **account** — staging runtime | `voxtable-stg-runtime@…iam.gserviceaccount.com` |
| Secret Manager **name prefixes** — staging | `voxtable-stg-retell-*`, `voxtable-stg-twilio-*` (see `deploy/runbooks/staging-secrets.md` for the full registry) |
| Cloud Run **services** — production | `voxtable-prod-api`, `voxtable-prod-worker` |
| Cloud Run **job** — production | `voxtable-prod-migrate` |
| Cloud SQL **instance** — production | `voxtable-prod-postgres` |
| Firebase Hosting (new world) | `bp-voxtable-stg.web.app` / `bp-voxtable-prod.web.app` |
| Database roles (Cloud SQL) | `voxtable_owner` (migrations) / `voxtable_app` (runtime) |
| Repos | product `biteperk/voxtable` (renamed from `biteperk/vocotable`) · infra `biteperk/biteperk-cloud-platform` · marketing site `biteperk/biteperk-website` |
| Branches (product repo, since 1 Aug 2026) | `integration` (default; deploys staging) · `main` (production; reached by promotion only) |

## 4. Legacy identities — check the reason before renaming

These look like leftovers. Most are not. Each row states its reason — and the reason is the
point, not the row: two entries here were audited on 28 Aug 2026 and turned out to be movable,
so **check the reason before repeating it.** A false "never rename" is as expensive as a
missing one, and it froze the other company's name into this product for weeks.

✅ **Cal.com `vocotable_*` metadata keys — renamed 28 Aug 2026 to `voxtable_*`, legacy keys read
FOREVER.** They were never in this table and should have been its first entry.
`reconcileMirroredBooking` uses the reservation id as positive proof that a webhook is our own
booking echoing back; read only the new key and a pre-rename booking's webhook falls through to
the genuine-web-booking path and creates a phantom reservation holding a real table. The lookup
is `ourReservationId()` in `calcomService.ts` — one function so the two keys cannot drift apart.
**There is no date after which the legacy key can be dropped**, only a date after which no such
booking exists, and nothing tracks that.

| Identity | Why it can never change |
|---|---|
| Firebase/GCP project `vocotable` / `vocotable-497209` | Project ids are immutable in GCP. |
| ~~`SYNTH_EMAIL_DOMAIN`~~ — **moved 28 Aug 2026** to `bookings.voxtable.biteperk.com.au` | The old reason ("orphans every existing Cal.com booking") did not survive checking: **four** bookings, `CALCOM_SYNC_ENABLED` unset in production, and **no synthetic address is stored in our database** — `customers` has no email column. `calcomService.ts` writes the new domain and recognises both, so nothing was orphaned. The legacy domain stays *readable* forever: those addresses live in Cal.com's records and an old booking can be cancelled years later. |
| `vocotable_number` API field | Public API contract. |
| `vocotable.*` localStorage keys | Persisted in customers' browsers. Renameable only behind a read-old/write-new shim — a bare rename resets the active restaurant and can drop an in-flight signup. |
| ~~`vocotable:*` window events~~ — **renamed 28 Aug 2026** | Never belonged here: same-page pub/sub, dispatcher and listener ship in the same bundle, nothing persisted. Now `voxtable:*`. |
| Legacy VM-world registry `us-central1-docker.pkg.dev/vocotable-497209/vocotable/*` | Sandbox-only legacy images; never use for a production deployment. |
| Legacy `voco*` / `perk*` URL slugs (website 301s + `PRODUCT_SLUGS`) | Printed collateral and cached links use them — keep forever. |
| Local checkout dir `~/vocotable` | Sam's machine; scripts and muscle memory point at it. Renaming buys nothing. |

✅ **npm package names + Postgres application names — renamed 2 Sep 2026.** `vocotable` /
`@vocotable/{backend,frontend,kds}` → `voxtable` / `@voxtable/*` (workspaces are path-based, so
only the `--workspace=` flags referenced the names: root scripts, both Dockerfiles' `npm ci`,
CI, and living runbooks' commands — dated session reports keep the old spelling as historical
record). `PG_APPLICATION_NAME` defaults `vocotable-api`/`vocotable-worker` → `voxtable-*`
(display-only in `pg_stat_activity`; nothing filters on it). The CI ephemeral image tags
`vocotable-*:ci` moved with them. `vocotable_number` is already aliased — the onboarding
response serves `voxtable_number` first with `vocotable_number` as a deprecated sibling, and the
frontend reads new-then-old; the old key stays until no deployed bundle reads it.

## 5. Conventions for minting NEW names

- GCP projects: `bp-<product>-<env>`, env ∈ `stg` \| `prod` (three letters vs four — see §3).
- Cloud Run services: `<product>-<env>-<service>`.
- Customer-facing **product apps**: `<product>.biteperk.com.au` (`voxtable.`, `voxorder.`, …) —
  decision 25 Aug 2026, superseding the earlier `<surface>.` convention that produced the
  never-shipped `app.biteperk.com.au`. Shared infrastructure surfaces stay function-named
  (`api.`, `kds.`). Hosts backed by Firebase Hosting are DNS-only (gray cloud) in Cloudflare;
  reserved product hosts serving only a Cloudflare redirect rule are proxied (orange) —
  there is no origin behind them, so the gray-cloud rule does not apply.
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
