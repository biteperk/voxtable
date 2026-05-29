# Pre-deploy assessment — onboarding rollout (2026-05-29)

Recon done before deploying `feat/stripe-billing` (multi-tenant onboarding,
Phases 0–5) to the production VM. **Conclusion: do NOT deploy onto the VM as-is.
First fix the VM's deploy hygiene + reconcile git (see remediation).**

## What the VM looks like
- VM `core-central-vm:/opt/vocotable` git HEAD = `34737dd` — **81 commits behind
  `origin/main`** (`34737dd` is a direct ancestor of `origin/main`).
- `git diff` on the VM shows a **12k-line "uncommitted" working tree** and dozens
  of "untracked" files (KDS, menu/orders/calcom services, workers, migrations
  004–006, smoke scripts, brand assets…).
- The working tree is littered with macOS **AppleDouble `._*` files** (`._apps`,
  `._.env`, `._CLAUDE.md`, …).
- `git fetch origin` on the VM **fails**: `could not read Username for
  https://github.com` — the box has **no GitHub credentials**.

## What it means (the important part)
The VM was last updated by **copying files from a Mac** (scp/tar — hence the
`._*` resource-fork junk), **not** `git pull`. Its `.git` HEAD is frozen at
`34737dd`, so:
- Everything "modified" is just newer `origin/main` content vs the stale HEAD.
- Everything "untracked" is files added in the 81 commits (they postdate the HEAD).

**There is no authoritative, novel source on the VM that isn't already in
`origin/main`.** The earlier worry ("a naive deploy would destroy Ali's WIP") is
resolved: the apparent WIP is just main's own code surfaced by the broken git
pointer. The real issue is **deploy hygiene**, not lost work.

### Config audit (done 2026-05-29) — RESULT
Pulled the VM's actual config files down and diffed vs `origin/main` (`.env`
deliberately NOT pulled — verify it by hand on the box):
- `deploy/nginx/vocotable.conf`, `docker-compose.yml`, `docker-compose.prod.yml`,
  `firebase.json`, `.firebaserc`, `.gitignore` → **IDENTICAL to origin/main**.
- `package.json` → only delta is the VM is **missing `jspdf`** (behind main, not
  hand-edited).
- `docker-compose.override.yml` → **VM-only** (not in repo), trivial content:
  ```
  services:
    postgres:
      ports: ["5432:5432"]
  ```
  (exposes Postgres to the host — a debug convenience). **Must be recreated** on a
  clean checkout, or it's lost. Consider committing it to the repo.

**Verdict:** no meaningful novel source or config on the VM — it's a stale copy
of `main`. Remediation is purely deploy-hygiene; nothing to salvage except the
one trivial override file. Still verify `.env` on the box by hand before cutover.

## Safe actions already taken (read-only / reversible)
- **Prod DB backup**: `pg_dump` of `vocotable` → gzip, verified (17 tables, clean
  exit). Stored OUTSIDE the repo (customer data): `~/vocotable-ops/vm-snapshot-20260529/vocotable-backup-20260529-185002.sql.gz`.
- **VM working-tree diff** captured for the record:
  `~/vocotable-ops/vm-snapshot-20260529/ali-wip-20260529-185002.diff`.
- VM `/tmp` cleaned of both. **No migrations applied, no container touched, no
  files overwritten on the VM.**
- Branch `feat/stripe-billing` (`5577d2f`) pushed to GitHub.

## Recommended remediation (needs Sam + Ali)
0. **Fix VM deploy hygiene** — give the VM proper repo access (deploy key or PAT)
   so it can `git fetch`/`pull`, OR plan to deploy via image rebuild from a clean
   checkout. Clean up the `._*` junk (`find /opt/vocotable -name '._*' -delete`).
1. **Confirm no real VM-only edits** — targeted config diff (above). If any exist,
   capture + PR them to `main` first so nothing is lost.
2. **Merge** `feat/stripe-billing` into `main` (3-way merge with the 81 commits;
   `npm run check` must stay green).
3. **Deploy via the staged rollout** — see `onboarding-rollout.md`.

Until 0–2 are done, the onboarding stack stays on the branch only.
