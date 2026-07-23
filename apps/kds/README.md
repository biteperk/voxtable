# Kitchen Display System (KDS)

A kiosk-style React app for a restaurant kitchen. Polls `/api/orders/active`
every 2 s for the authenticated active tenant, shows orders in three lanes
(Pending → Preparing → Ready), and lets line cooks advance status with a single
tap.

Lives in the same monorepo as the backend and manager dashboard. Shares the
backend on `core-central-vm` and the Firebase project. The kiosk account should
be allowlisted as a kitchen user through `DASHBOARD_KITCHEN_EMAILS` or an
equivalent restaurant membership.

## Quick start (dev)

```bash
# From the repo root
cp apps/kds/.env.example apps/kds/.env   # fill VITE_API_BASE_URL + Firebase keys
npm run dev:backend                       # http://localhost:3050
npm run dev:kds                           # http://localhost:3052
```

## Production deploy

```bash
npm run build:kds
firebase deploy --only hosting:kds
```

The Firebase Hosting target is `kds` in `firebase.json`. The Firebase Hosting
site is `vocotable-kds` (created via `firebase hosting:sites:create
vocotable-kds`). Custom domain `kitchen.vocotable.biteperk.com.au` is configured
in the Firebase Console.

## What's wired

| Capability                            | Status |
|---------------------------------------|--------|
| Real-time order board (2s polling)    | ✅ |
| Optimistic UI + 409 reconciliation    | ✅ |
| Per-item ✓ ready ticks                | ✅ |
| New-order audio chime (rate-limited)  | ✅ |
| Service Worker (shell + stale orders) | ✅ |
| Online / offline banner               | ✅ |
| Heartbeat ping (1/min)                | ✅ |
| Error boundary auto-reload            | ✅ |
| Optimistic-locking If-Match           | ✅ |

## Kiosk setup runbook

See [`deploy/runbooks/kds-kiosk.md`](../../deploy/runbooks/kds-kiosk.md).
