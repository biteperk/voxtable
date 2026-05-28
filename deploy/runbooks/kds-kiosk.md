# KDS Kiosk Setup Runbook

How to bring the Kitchen Display System online at Natalia's. Target: a
10–12" wall-mounted tablet on the line.

## 0. Prereqs (one-off)

- [ ] Migration `006_kds_schema.sql` has been applied on the prod DB.
- [ ] `npm run db:seed` has been run on prod — Natalia's menu is in `menu_items`.
- [ ] Backend image rebuilt + redeployed on `core-central-vm` (CORS now allows
      `https://kitchen.vocotable.biteperk.com.au`).
- [ ] Firebase Hosting site created:
      `firebase hosting:sites:create vocotable-kds`
- [ ] Firebase target applied:
      `firebase target:apply hosting kds vocotable-kds`
- [ ] Frontend built + deployed:
      `npm run build:kds && firebase deploy --only hosting:kds`
- [ ] DNS: CNAME `kitchen.vocotable.biteperk.com.au` →
      `vocotable-kds.web.app` (the exact target is in Firebase Console
      → Hosting → Add custom domain). Verify with `dig kitchen.vocotable.biteperk.com.au`.
- [ ] Firebase Hosting custom domain provisioned + SSL ready.

## 1. Kitchen Google account

- [ ] Create a workspace-managed Google account `kitchen@biteperk.com.au`
      (or pick a non-personal address you can rotate later).
- [ ] Password stored in 1Password / Bitwarden.
- [ ] Add to `DASHBOARD_ALLOWED_EMAILS` on the VM `.env`. **Do NOT** add to
      `DASHBOARD_MANAGER_EMAILS` — kitchen staff don't toggle paid/refund.
- [ ] Restart backend: `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`.

## 2. Tablet setup

- [ ] Wipe / factory reset for a clean slate.
- [ ] Connect to kitchen WiFi.
- [ ] Disable: auto-lock, auto-update during business hours, notifications.
- [ ] Open Chrome → `https://kitchen.vocotable.biteperk.com.au`.
- [ ] Sign in with the kitchen Google account.
- [ ] Menu → "Add to Home Screen" / "Install" (PWA installs as standalone).
- [ ] Launch the home-screen icon — should open fullscreen, no Chrome chrome.
- [ ] Tap the "Tap to enable sound" banner. Confirm the speaker icon lights.

## 3. Smoke test

- [ ] Manager dashboard: create a test order with one item (Fish & Chips
      Large + Coke). KDS should show it within 2 s.
- [ ] Listen for the ding. (Volume up if the kitchen is loud.)
- [ ] Tap `Start` → card moves to Preparing.
- [ ] Tap the per-item ✓ → item shows green checkbox.
- [ ] Tap `Mark Ready` → card moves to Ready.
- [ ] Tap `Served` → card fades and disappears.
- [ ] Run from a second tab simulating a second tablet — verify 409 toast
      ("Updated by another tablet — refreshing").
- [ ] Pull WiFi for 30 s — verify OFFLINE banner + last orders still visible.
- [ ] Reconnect — verify board refreshes within 2 s.

## 4. Failure fallback

If the tablet goes down mid-service:

1. Open the manager dashboard `/kitchen-overview` page on a phone.
2. Same data, different UX — chef can pick up from there.
3. Tablet failures should escalate to ops on Slack via the
   `/api/ops/kds-health` alert (oldest pending order > 10 min).

## 5. Tablet hardware notes

Recommended: iPad 10.2" or Lenovo Tab M10 Plus. Whatever the venue already has
is fine — the SPA is forgiving as long as Chrome 110+ ships.
