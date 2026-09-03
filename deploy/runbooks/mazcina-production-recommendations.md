# Mazcina production — recommendations, arrival pre-orders, party cap

Puts PR #337's work on the production VM: Bella recommends the owner's own ranked dishes,
a pre-ordered tray reaches the pass timed to the guest's arrival, parties above the cap go
to Camilo, and he gets a text on every booking.

Environment for everything below: **production** — VM `core-central-vm`
(project `vocotable-497209`, zone `us-central1-a`), Retell workspace **Biteperk**
(key only from the VM's `/opt/vocotable/.env`), Twilio `Biteperk-production`.

⚠️ **The line stays `customer_facing: false`.** The ~7.6 s drop (#341) is unresolved and
unrelated to this work. Nothing here makes the number publishable.

⚠️ **Every step from §4 on fails SILENTLY if skipped.** Deploy the code alone and the result
is: empty recommendations, no owner text, no party cap, nothing spoken. No error anywhere.

## What makes this different from a normal deploy

Production is on migration **036**. The repo is on **042**. So this is a six-migration jump,
not three — `037`–`039` were never applied and ride along. §3 reviews each.

And the data does not promote. Production's Mazcina row is
`44444444-4444-4444-8444-444444444444` with **8 categories / 31 items**; staging and local
carry `33333333-…` with 12 / 97. The rankings must be applied to production separately.

---

## 1. Before touching anything — two read-only checks

Both are `SELECT`s. Run them first; each can turn a later step into a failed apply.

```bash
gcloud compute ssh core-central-vm --zone us-central1-a --project vocotable-497209
```

**Check A — the category names the rankings need.** The importer refuses the whole file if a
dish or section does not match. Production has 8 categories; the ranked list needs 5 of them.

```bash
sudo docker compose exec postgres psql -U vocotable -Atc \
  "SELECT name FROM menu_categories WHERE restaurant_id='44444444-4444-4444-8444-444444444444' ORDER BY display_order"
```

Expect, case-insensitively: `Starters`, `Chef Suggestions for Sharing`, `Mains`, `Sides`,
`Desserts`. If one is missing or named differently, stop and reconcile — §4 will abort.

**Check B — duplicate phone numbers, before migration 039.** 039 adds a trigger raising
`unique_violation` when two venues share a number across `twilio_phone_number` /
`retell_phone_number`. The migration itself is safe (it does not validate existing rows), but
a pre-existing duplicate makes the **next write** to that row throw — and Mazcina's number is
mid-cutover, so a cutover UPDATE would be the first thing to hit it.

```bash
sudo docker compose exec postgres psql -U vocotable -Atc \
  "SELECT a.id, b.id, coalesce(a.twilio_phone_number, a.retell_phone_number)
     FROM restaurants a JOIN restaurants b ON a.id < b.id
    WHERE coalesce(a.twilio_phone_number,'x') IN (coalesce(b.twilio_phone_number,'y'), coalesce(b.retell_phone_number,'y'))
       OR coalesce(a.retell_phone_number,'x') IN (coalesce(b.twilio_phone_number,'y'), coalesce(b.retell_phone_number,'y'))"
```

Zero rows is the pass. Any row: resolve the duplicate before running migrations.

## 2. Back up

`deploy/runbooks/backup-restore.md` — pg_dump **off-VM**. Non-negotiable here because of
migration 038 (§3). The VM's `devstorage.read_only` scope blocks writing to GCS, which is why
the dump runs off-VM.

## 3. The migrations, 037 → 042

| File | Risk | What to know |
|---|---|---|
| `037_enable_pgaudit` | Low | Guarded `DO` block; skips with a NOTICE where the extension is unavailable. Stock Postgres on the VM should no-op. Only hazard is `CREATE EXTENSION` needing superuser if it *is* present. |
| `038_app_role_grants_either_spelling` | **Highest — watch this one** | Runs `ALTER ROLE vocotable_app NOCREATEDB NOCREATEROLE NOINHERIT` against **the live role the API connects as**. `NOINHERIT` strips anything held via role membership; the migration re-GRANTs DML directly, but only for objects existing at run time. #324 de-fanged it to *warn* rather than wedge on insufficient privilege — so the likely outcome is a WARNING and a clean exit, which is exactly why §3's health loop matters more than the migrate command's exit code. Failure looks like `permission denied for table …` on the first call after restart. |
| `039_phone_number_single_owner` | Medium, deferred | DDL only. Risk is the next phone-column write — see Check B. |
| `040_menu_recommendations` | Low | New nullable/defaulted columns on `menu_items` plus a partial unique index that cannot collide (every existing row is NULL). |
| `041_order_fire_at` | Low | `orders.fire_at`; NULL = fire now = every order that exists today. |
| `042_restaurant_owner_phone` | Lowest | One nullable TEXT column. |

Neither 040 nor 041 uses `CREATE INDEX CONCURRENTLY`, so each briefly locks `menu_items` /
`orders`. Sub-second at this volume — but **not mid-service**.

**Pin the image.** `docker-compose.deploy.yml` pins `api:0.2.0`; `package.json` is `1.0.0`;
the registry has no `latest`. CI publishes an `api:<sha>` for every branch, so pin the exact
`integration` SHA that carries #337 — no `main` merge is needed for the VM.

```bash
# laptop — edit the two image: lines to the integration SHA, then:
gcloud compute scp docker-compose.deploy.yml core-central-vm:/tmp/ --zone us-central1-a --project vocotable-497209
# VM:
sudo install -m 0644 /tmp/docker-compose.deploy.yml /opt/vocotable/
```

**Pull → migrate from the NEW image → verify → start**, in `/opt/vocotable`:

```bash
C="sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.deploy.yml"
$C pull api worker
$C run --rm api node apps/backend/dist/db/migrate.js      # NOT `exec` — exec hits the OLD container
sudo docker compose exec postgres psql -U vocotable -Atc \
  "select filename from schema_migrations order by filename desc limit 8"
```

Expect `042_restaurant_owner_phone.sql` on top and 037–041 beneath it — **eight rows checked,
six newly added**. Migrations must run as `voxtable_owner`, never `postgres`: migration 029's
`ALTER DEFAULT PRIVILEGES` attaches to the executing role, and the wrong one silently strips
future tables of their grants.

```bash
$C up -d api worker
for i in $(seq 1 10); do sudo docker inspect vocotable-api-1 --format '{{.State.Health.Status}}'; sleep 3; done
```

If the api is not `healthy`: `sudo docker compose logs api | grep -iE "refusing|permission denied"`.
A boot gate names its missing variable; `permission denied for table` is 038 — restore from §2.

**Rollback:** re-pin the previous SHA in `docker-compose.deploy.yml`, `up -d`. Migrations
040–042 are additive, so the old image runs against the new schema. 038 is the exception,
which is why §2 exists.

## 4. The rankings — data, and it does not promote

Generate the SQL on the laptop (no database needed) and apply it with psql, the same path
every venue's menu has taken:

```bash
cd apps/backend
npx tsx scripts/import-recommendations.ts \
  --restaurant-id 44444444-4444-4444-8444-444444444444 \
  --file ../../mazcina/prioritized-dishes-by-category-ordered-from-highest-priority.json \
  --emit-sql /tmp/mazcina-recs-prod.sql
```

⚠️ **The UUID is the trap.** The only written Mazcina import command lives in
`mazcina-staging-conversion.md` and carries `33333333-…`. Copying it ranks the wrong venue in
the wrong database, succeeds, and prints a happy report — both rows are named "Mazcina", so
nothing catches it. The line above carries `44444444-…`; use it.

The ranked JSON lives in `mazcina/`, which is **gitignored** — it is not on the VM after a
deploy, which is why the SQL is generated here and copied.

```bash
gcloud compute scp /tmp/mazcina-recs-prod.sql core-central-vm:/tmp/ --zone us-central1-a --project vocotable-497209
# VM:
sudo docker compose exec -T postgres psql -U vocotable -v ON_ERROR_STOP=1 -f - < /tmp/mazcina-recs-prod.sql
```

Expect ten `NOTICE` lines, one per dish, then `COMMIT`. The file is one transaction that
clears the venue's rankings first and **raises on any dish that matches nothing** — a miss
aborts everything rather than applying nine of ten. If it raises, that is Check A failing
late: reconcile the name and re-run. Nothing is written on a failure, so re-running is safe.

Verify:

```bash
sudo docker compose exec postgres psql -U vocotable -Atc \
  "SELECT c.name||' #'||m.recommend_rank||': '||m.name FROM menu_items m
     JOIN menu_categories c ON c.id=m.category_id
    WHERE m.restaurant_id='44444444-4444-4444-8444-444444444444' AND m.recommend_rank IS NOT NULL
    ORDER BY c.display_order, m.recommend_rank"
```

**Rollback:** re-run with the previous ranked file, or
`UPDATE menu_items SET recommend_rank=NULL, is_signature=false, is_quick_bite=false WHERE restaurant_id='44444444-…'`.
An empty ranking set makes `menu_highlights` empty, which is the pre-#337 behaviour.

## 5. Camilo's mobile

Needed for the booking notification. It is **not recorded anywhere in the repo** — get it from
Camilo, in E.164.

```bash
sudo docker compose exec postgres psql -U vocotable -c \
  "UPDATE restaurants SET owner_phone='+61XXXXXXXXX' WHERE id='44444444-4444-4444-8444-444444444444'"
```

The notification is silent when this is NULL or does not start with `+`, so a typo here has no
symptom. Verify by making a booking and watching for the text.

Also confirm SMS is actually configured on the VM — the notice needs `NOTIFICATIONS_ENABLED=true`,
both Twilio credentials, and **one of** `NOTIFICATIONS_MESSAGING_SERVICE_SID` or
`NOTIFICATIONS_SMS_FROM`. Setting both silently disables the branded sender.

## 6. Turn the features on — separately, and reversibly

Everything above is **behaviour-neutral**: all three variables default to off/disabled, so the
deploy changes nothing a caller experiences until this step. Do it as its own change so it can
be undone without touching code or schema.

`/opt/vocotable/.env` — keep the file `0644` (`chmod 600` breaks the CI deploy read):

```
ORDER_FIRE_AT_ENABLED=true
KITCHEN_LEAD_MINUTES=25
VOICE_AUTOBOOK_MAX_PARTY=4
```

Then `$C up -d api worker` and re-check health.

Two things to settle with Camilo rather than assume:

- **25 minutes** is Sam's working figure, not the venue's. A 7 pm booking puts the docket up at
  6:35 pm. His quick bites (empanadas, sopaipillas) may want less than a grilled main —
  `is_quick_bite` already exists if it needs splitting.
- **A cap of 4** is his stated rule, but production's largest table seats **six**, so it turns
  away parties the floor can hold. He framed it as temporary ("eventually Bella can manage
  everything"). Raising it is an env change, not an agent PATCH — deliberately.

**Rollback:** remove the three lines, `up -d`. Complete behavioural revert, no schema change.
⚠️ If reverting after pre-orders exist, null the future fire times in the same step, or those
tickets sit invisible until their hour and then arrive already red:
`UPDATE orders SET fire_at=NULL WHERE fire_at > now() AND status NOT IN ('served','cancelled')`.

## 7. The prompt — last, and only once §4–6 are true

> ✅ **Done 3 Sep 2026.** §4 (10/10 dishes ranked, read back from `menu_items`), §5
> (`owner_phone` set), §6 (three flags live, containers healthy) all landed during the 1.1.0
> promotion; the prompt PATCH followed the same day — pre/post snapshots and the printed
> read-back in `deploy/retell-snapshots/20260903-mazcina-recommend-prod-{pre,post}/`.
> `npm run check:voice-lines`: all three lines green. **§9's real call is still owed.**

Until this step Bella cannot say any of it. The backend serves **13** dynamic variables; the
production prompt references **10**. `menu_highlights`, `menu_status` and `owner_name` are
computed on every call and never spoken.

Prove the variable arrives before the prompt mentions it — Retell renders a missing `{{name}}`
literally to the caller:

```bash
node .claude/skills/retell-agent-quality/scripts/probe-inbound.mjs +61468202846
```

`menu_highlights` must be **populated**, not empty. If it is empty, §4 did not take.

Then the change discipline, in full — no shortcuts for a one-liner:

1. Fresh pre-snapshot: `scripts/snapshot.sh agent_b6b6488af08b82d80e8f4d270a llm_5f642f051bb83c28d02cea4e1cbc deploy/retell-snapshots/<date>-mazcina-recommend-pre`
2. Single hand `PATCH /update-retell-llm/llm_5f642f051bb83c28d02cea4e1cbc`. `apply-line.mjs`
   does **not** touch the LLM.
3. Read back; assert the fields set **and** the invariants not set (`default_dynamic_variables: {}`,
   voice, sensitivity, speak flags). Never trust the write response.
4. Post-snapshot + README: what changed, why, the evidence, the rollback line. Commit.
5. A real test call.

The prompt gains a recommending section driven by `{{menu_highlights}}`, and its party rule
changes from "Parties of 7 or more" to the cap, handing off via `{{owner_name}}`. No venue
names and no dish names in prose — `assert-agent.mjs` hard-fails on venue names, and hardcoded
dishes break the moment Camilo reorders his list.

⚠️ **Credentials via `line-credentials.mjs`.** The repo's local `.env` holds the **legacy
Algorythmos** workspace key; read with it, this number 404s and the correct agent "does not
exist". Acting on that reading took the line down for two hours on 20 August.

**Rollback:** re-apply the pre-snapshot, one PATCH per object.

## 8. The kitchen display

The Upcoming lane is frontend. **Confirm which KDS site the kitchen actually opens** before
assuming a deploy reached it — the legacy `vocotable-kds.web.app` has historically been
hand-deployed (`npm run build:kds && firebase deploy --only hosting:kds`), while the pipeline
ships `bp-voxtable-prod-kds` on a `main` promotion.

A kitchen on a stale bundle sees pre-orders behave the old way while the backend schedules
them — worse than either alone, because the ticket is simply absent until its fire time with
no explanation on screen.

## 9. Prove it, then stop

```bash
npm run check:voice-lines          # per-line credentials from the declaration
```

Then a real call to `+61 468 202 846` — internal, the line is not customer-facing:

- "What do you recommend to start?" → a **Starter**, rank 1, one dish, then a pause
- "What's good for sharing?" → reaches Chef Suggestions for Sharing
- "What salads do you have?" → falls back cleanly; no ranked items in that section
- A party of 5 → hands off to Camilo, and `check_availability` agrees rather than offering a table
- Book, pre-order a dish → the ticket appears in KDS **Upcoming** with a countdown, does not
  ding, is not red; it moves to Pending at its fire time
- Camilo receives the booking text

Record the result in a post-snapshot README the same day. A document may only claim what a
read-back printed.
