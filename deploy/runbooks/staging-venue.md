# The staging venue — VoxTable Staging Venue

The end-to-end test restaurant on staging. One venue, one number, committed as code.

| Fact | Value |
|---|---|
| Restaurant id | `33333333-3333-4333-8333-333333333333` |
| Bound number | `+61 468 203 234` (staging Twilio, `Biteperk-staging`) |
| Retell agent | `agent_b9087333b7030f0cee06a19ffc` (Staging workspace) |
| Tables | S1 (1-2) · S2 (2-4) · S3 (3-6) · S4 (4-8) |
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

**Never bind a second venue to `+61 468 203 234`.** Dialled-number routing is
`WHERE twilio_phone_number = $1 … LIMIT 1` with no uniqueness constraint — two rows on one
number route calls arbitrarily. Extend this venue; don't clone it.

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
