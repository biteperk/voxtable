# Moving VoxTable to Australia — scoping notes

**Status: not started. This is a plan, nothing has been changed.**
Written 31 Jul 2026.

---

## The short version

Our customer data is currently in **Iowa, USA**. The move to Sydney is smaller
than it sounds — the database is 10 MB — but it can't be done in one step, and
some things can never be Australian at all.

Read the "what can't move" section before promising anyone full Australian
data residency.

---

## Where our data actually lives today

I checked each of these rather than assuming.

| Thing | Where it is now | Notes |
|---|---|---|
| Backend server | **Iowa** (`core-central-vm`, `us-central1-a`) | Needs to move |
| Database | **Iowa** — Postgres in Docker on that same VM | Needs to move |
| Menu photo uploads | **Sydney** ✅ | `vocotable.firebasestorage.app` is already `australia-southeast1` |
| Database backups | **Sydney** ✅ | `vocotable-backups-497209` is already `australia-southeast1` |
| Dashboard website | Global CDN | Static files only, no customer data — not a residency question |
| Customer emails/logins | **USA** ❌ | Firebase Auth. Google-managed. Cannot be moved. |
| Call recordings + transcripts | **USA** ❌ | Retell AI processes every call |
| Payment records | **USA/global** ❌ | Stripe |
| Error reports | Nowhere | Deliberately switched off 31 Jul 2026 — Sentry has no AU region |

So two of the seven are already Australian, two need to move, and three
**cannot** move without changing vendor.

## How much data are we actually moving

Checked against production:

```
database size    10 MB
restaurants       4
reservations     15
call logs        41
```

This is small enough that the database itself is a non-event — a dump and
restore is seconds, not hours. **All the risk in this migration is in the
re-wiring, not the data.** Plan accordingly: don't budget time for the copy,
budget it for DNS, certificates and testing the phone line.

---

## What can't be Australian (read this before promising anything)

Three vendors sit in the middle of our product and none offer Australian
hosting:

- **Retell AI** handles every phone call. The audio and the transcript go
  through their US infrastructure. This is the biggest one by far — it's the
  actual content of our customers' conversations.
- **Firebase Auth** holds every restaurant owner's email and login. Google
  manages the location; there is no setting for it.
- **Stripe** holds payment records.

Moving our server to Sydney does **not** change any of that. It's still worth
doing — the booking data, customer phone numbers and call metadata in our own
database would become Australian — but "all your data stays in Australia"
would not be a true statement afterwards.

This is exactly why the agreement screen collects a separate **overseas
disclosure consent**. Worth re-reading that wording against this table before
a customer's lawyer does.

---

## The recommended approach: move first, tidy up later

There are two separate projects here, and they keep getting talked about as
one:

1. **Move to Sydney** — same database shape, new location.
2. **Re-shape the database** — the parked `apps/backend/db/baseline-sydney/`
   tree, which splits tables into domain schemas (`core`, `reservations`,
   `voice`, …).

**Do them separately, in that order.** Doing both at once means that if
anything goes wrong you won't know whether it was the move or the re-shape,
and the rollback is twice as complicated. The re-shape can happen any time
afterwards, in any region — it has nothing to do with residency.

Note also that the parked baseline is now out of date: it was written before
the legal layer landed and is missing migrations 017–020, and it needs the
`search_path` wiring in `db/pool.ts` restored. That's more evidence it should
be its own project with its own testing, not a passenger on this one.

---

## The move, step by step

**The key decision that makes this easy: keep the same web address.**
If `vocotable.algorythmos.com.au` still points at us afterwards, then Retell,
Twilio, Stripe and Cal.com need **no changes at all** — they keep calling the
same URL, it just resolves somewhere new. Changing the hostname would mean
re-registering webhooks with four vendors and is not worth it.

1. **Build the new server in Sydney.** New VM in `australia-southeast1`, new
   static IP (the current one, `136.113.35.88`, is tied to `us-central1` and
   cannot be moved). Install Docker, pull the same images.

2. **Get the config across.** `/opt/vocotable/.env` and the compose files.
   Remember the VM has no GitHub credentials — files get there by
   `gcloud compute scp`, not `git pull`.

3. **Certificate.** Let's Encrypt validates over HTTP, so the certificate can
   only be issued *after* DNS points at the new server. Expect a short window
   where DNS has moved but HTTPS isn't ready — do this at a quiet hour.

4. **Move the data.** Stop the old API and worker so nothing writes mid-copy,
   `pg_dump` the old database, restore into the new one, verify row counts
   match. At 10 MB this is the fastest part.

5. **Repoint DNS.** Change the `vocotable` A record in Cloudflare to the new
   IP. **It must stay grey-cloud (DNS-only).** Orange-cloud proxying breaks
   both the Let's Encrypt check and the webhook signature verification that
   Retell and Twilio depend on.

6. **Start the new server, then test a real phone call.** Not a smoke test —
   an actual call that reaches the AI and writes a booking. That's the only
   check that proves the whole chain survived.

7. **Keep the old VM running but idle for a week** before deleting it. DNS
   caching means stragglers may still arrive at the old address.

### Rollback

Point the DNS A record back at `136.113.35.88`. The old VM still has the data
as it was at the moment of the dump. Anything written to Sydney after the
cutover would be lost, which is the reason for step 6 — find out immediately,
not the next morning.

---

## Gotchas found while scoping

**The nginx config in this repo is stale.** `deploy/nginx/vocotable.conf` is
written for `api.vocotable.com`, which is not the hostname production actually
serves (`vocotable.algorythmos.com.au`). Anyone rebuilding the server from the
repo would get a config that doesn't match reality. **Copy the live config off
the old VM — do not trust the repo copy.** Worth fixing separately, before it
misleads someone under time pressure.

**Nothing in the codebase hardcodes the region**, so no application code needs
to change for this move. Checked.

**Menu photo uploads keep working during the move** — they go to Firebase
Storage, not our server, and that bucket is already in Sydney. Note the
backend only accepts uploads from `firebasestorage.googleapis.com`
(`MENU_OCR_ALLOWED_HOSTS`); that's the correct host for our bucket and it
doesn't change with the move. Verified.

**Watch the Twilio SIP trunk.** Calls route Twilio → `sip.retellai.com`, which
doesn't touch our server, so it should be unaffected. But it's the piece
nobody remembers until the phone stops working — hence the real-call test in
step 6.

---

## Rough effort

Half a day of hands-on work, plus a week of leaving the old VM up. The
database is the easy part; DNS propagation and the certificate are what make
it an afternoon rather than an hour.

Best done on a quiet morning, never before a Friday or Saturday dinner
service.

## Open questions for Sam

1. Do we want Australian residency as a **selling point**? If yes, the Retell
   question has to be answered too, and that's a vendor change, not a move.
2. Is anyone actually asking for this — a customer, a tender, a broker — or is
   it a principle? That changes how much the three unmovable vendors matter.
3. Do we re-shape the database (the parked baseline) at all, or leave the
   current schema alone? It works. "Tidier" isn't a reason on its own.
