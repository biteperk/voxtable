# The staging venue — VoxTable Staging Venue

> 🔄 **Being converted to Mazcina (18 Aug 2026).** This venue is becoming a real restaurant —
> real name, real menu, its own Retell agent — so staging rehearses production instead of
> simulating it. Follow [`mazcina-staging-conversion.md`](mazcina-staging-conversion.md);
> it supersedes the menu and agent sections below, and the steps are order-dependent.
> The number, restaurant id and members are unchanged.

The end-to-end test restaurant on staging. One venue, one number, committed as code.

| Fact | Value |
|---|---|
| Restaurant id | `33333333-3333-4333-8333-333333333333` |
| Bound number | `+61 468 203 234` (staging Twilio, `Biteperk-staging`) |
| Retell agent | ⚠️ **unbound** — see "The agent this venue must NOT use" below |
| Tables | **10, the venue's real floor plan** — T1–T4 (1-2) · T5–T8 (2-4) · T9–T10 (4-6). Largest seats **6**; S1–S4 are retired (deactivated, not deleted). |
| Hours | 09:00–23:00 every day |
| Menu | 5 items — see below, the prices are load-bearing |
| Seed | `deploy/seeds/staging-venue.sql` (idempotent; applied + re-applied 14 Aug 2026) |

## The menu is a test fixture, not a menu

| Item | Why it exists |
|---|---|
| Fish & Chips $22 (Small −$8 / Medium / Large +$4; Drink required: Coke default, Lemonade, Sparkling Water) | The `smoke-orders` contract — the smoke asserts Large+Coke totals **$26.00 exactly**. Change a price and the staging smoke fails on purpose. |
| Garden Salad $14 | A second orderable item for multi-line orders. |
| Big Breakfast $24, window 09:00–11:30 | The menu-window refusal leg — order it after 11:30 and Bella must decline. |
| Coke $5 | Plain drink line item. |
| House Lager $9, `is_restricted` | The licensed-item refusal leg — Bella must refuse it with the licensing line. |

## THE ONE RULE

**Never bind a second venue to `+61 468 203 234`, and never bind another venue's Retell
agent to this row.** Extend this venue; don't clone it.

> **Correction, 18 Aug 2026.** This section used to say the routing query has "no uniqueness
> constraint". That was wrong: migration 007 gives `twilio_phone_number` and
> `retell_phone_number` a partial unique index each, so a duplicate number is rejected by the
> database. The unguarded column was `retell_agent_id` — bare `TEXT`, no constraint — which
> is how this venue came to be bound to another venue's agent. Migration 034 adds the missing
> index, and the routing query is now `ORDER BY`'d so the cross-column `twilio OR retell`
> match cannot resolve arbitrarily either.

> ✅ **RESOLVED 19 Aug 2026.** The venue is now **Mazcina** and is bound to its own agent,
> `agent_7b67073710604d306443cc569c` (LLM `llm_c1d40dbe180e737dd2ce1309ed3f`), with a fully
> de-venued prompt. `agent_b9087333…` remains in the workspace as Natalia's staging agent and
> is bound to nothing. The section below stands as the history of why the constraint exists.

## The agent this venue must NOT use

`agent_b9087333b7030f0cee06a19ffc` is **`Natalia's Bistro (STAGING)`**, not this venue's
agent. The seed bound it here from the 13 Aug bring-up, labelled "Natalia's clone", and the
prompt was never de-venued — it hard-codes Natalia's restaurant name in the system prompt and
greeting, and her *name* in the callback line.

On a real test call (18 Aug 2026) the effect was: the dialled number resolved to **this**
venue, `/retell/inbound` returned this venue's name, timezone and dates — and the call was
then answered by Natalia's Bistro. The caller was told, confidently, that they had reached a
different restaurant, while the booking landed against the right one. Nothing objected
anywhere: `retell_agent_id` had no constraint, the bind did no vendor round-trip, and go-live
only checks the field is non-null.

**The seed now leaves `retell_agent_id` NULL.** Bind this venue's agent through the admin
endpoint instead, which verifies against Retell before storing:

```
PATCH /api/admin/restaurants/33333333-3333-4333-8333-333333333333/provisioning
{ "twilio_phone_number": "+61468203234", "retell_agent_id": "<this venue's agent>" }
```

Until that agent exists and is bound, the line answers with nothing and the API logs
`retell_inbound_no_agent_bound` — deliberately, because dead air is a better failure than a
confident lie about which restaurant you have reached.

⚠️ **Re-applying the seed will NOT fix the live staging row.** The insert is
`ON CONFLICT (id) DO NOTHING`, so the existing row keeps whatever it already has — including
`agent_b9087333…` if it is still there. Clear it explicitly, then bind the new agent:

```
POST  /api/admin/restaurants/33333333-3333-4333-8333-333333333333/unbind
      { "confirm_name": "VoxTable Staging Venue", "fields": ["retell_agent_id"] }
PATCH /api/admin/restaurants/33333333-3333-4333-8333-333333333333/provisioning
      { "twilio_phone_number": "+61468203234", "retell_agent_id": "<new agent>" }
```

Read the result back off `GET /api/admin/restaurants/:id` afterwards — never trust the write
response.

⚠️ **Rebinding by direct SQL does not take effect immediately.** The number→venue map is
cached per process, and each api/worker instance holds its own. The admin PATCH purges it;
raw SQL does not, so a SQL rebind is only picked up when the 60-second TTL expires.

## (Re)applying the seed

Staging Cloud SQL is private-only — no laptop path, even with the proxy. Use a throwaway
Cloud Run job cloned from `voxtable-stg-migrate`'s settings (image = any published api image;
the runner is node + the image's own `pg`):

```bash
SQL_B64=$(base64 -i deploy/seeds/staging-venue.sql | tr -d '\n')
RUNNER='const {Client} = require("pg");
(async () => {
  const c = new Client({connectionString: process.env.DATABASE_URL});
  await c.connect();
  const res = await c.query(Buffer.from(process.env.SQL_B64, "base64").toString("utf8"));
  for (const r of (Array.isArray(res) ? res : [res])) console.log(r.command, r.rowCount, r.rows?.length ? JSON.stringify(r.rows) : "");
  await c.end();
})().catch(e => { console.error("SEED_JOB_ERROR", e.message); process.exit(1); });'

gcloud run jobs create staging-venue-seed \
  --project bp-voxtable-stg --region australia-southeast1 \
  --image "australia-southeast1-docker.pkg.dev/bp-shared-artifacts/voxtable/api:<any-recent-sha>" \
  --service-account voxtable-stg-runtime@bp-voxtable-stg.iam.gserviceaccount.com \
  --set-cloudsql-instances bp-voxtable-stg:australia-southeast1:voxtable-stg-postgres \
  --network voxtable-stg-private --subnet voxtable-stg-cloud-run --vpc-egress private-ranges-only \
  --set-secrets "DATABASE_URL=voxtable-stg-database-url:latest" \
  --set-env-vars "^@^SQL_B64=${SQL_B64}@DATABASE_SSL=false" \
  --command node --args "^@^-e@${RUNNER}" \
  --max-retries 0 --task-timeout 120

gcloud run jobs execute staging-venue-seed --project bp-voxtable-stg \
  --region australia-southeast1 --wait
# Output: gcloud logging read 'resource.type="cloud_run_job" resource.labels.job_name="staging-venue-seed"' \
#   --project bp-voxtable-stg --freshness 10m --format='value(textPayload)'

# Delete when done — the job is not Terraform-managed:
gcloud run jobs delete staging-venue-seed --project bp-voxtable-stg \
  --region australia-southeast1 --quiet
```

Ad-hoc SQL (reads, the battery's SMS-leg outbox insert, smoke cleanup) goes through the same
job — swap `SQL_B64`. The `^@^` delimiter matters: gcloud splits `--args`/`--set-env-vars`
on commas and real SQL is full of them.

## Verifying after an apply

1. Re-run the apply — every INSERT must report `0` rows (idempotency).
2. `npm run smoke:retell-signed` against staging (signed inbound must return the agent id
   above with fresh dynamic variables).
3. The dashboard shows the venue for any signed-in member (membership row = access;
   Sam's uid is seeded as owner).
