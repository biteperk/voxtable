# Legacy dashboard hosts → `voxtable.biteperk.com.au`

Deploy **only after** `api.biteperk.com.au` serves from Cloud Run (cutover step 7 in
`deploy/runbooks/cuban-corner-cutover-day.md`). Before that moment the legacy site is the only
dashboard that can sign users in against the VM; after it, the legacy bundle's Firebase project
(`vocotable`) is rejected by the new backend and every login there fails silently.

```bash
# from the repo root — the `vocotable` project is the LEGACY one (110560713396), Sam is owner
npx --yes firebase-tools@15 hosting:channel:list --project vocotable   # sanity: you are on the right project
npx --yes firebase-tools@15 deploy --only hosting:app --project vocotable --non-interactive \
  --config deploy/legacy-redirect/firebase.json
```

`firebase.json` here points `public` at this folder, so the SPA bundle is replaced by the single
redirect page; the `**` rewrite keeps deep links (`/live-feed/abc`) resolving to it so the
path-preserving hop works.

Rollback: redeploy the last real bundle (`npm run build:frontend` with the legacy env values in
`apps/frontend/.env.example`, then the normal `firebase deploy --only hosting:app --project vocotable`).
