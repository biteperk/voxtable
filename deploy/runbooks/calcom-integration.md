# Cal.com — online bookings, per venue

> **Read this before binding a Cal.com event type to a venue, turning
> `CALCOM_SYNC_ENABLED` on, or debugging an online booking that landed at the
> wrong restaurant.** Numbers and voice agents are separate concerns — see
> `NUMBERS.md` and the `retell-agent-quality` skill.

## What this integration is, and is not

VoxTable owns availability. The engine understands tables, zones, party-size
fit, the advisory lock and the `reservations_no_overlap` exclusion constraint.
Cal.com understands none of that.

Cal.com is **the public booking page**, plus a two-way mirror that keeps that
page honest: bookings taken by phone are pushed out so Cal.com stops offering
slots the venue has already filled, and bookings taken online are pulled in
through `bookingService.createBooking` so the same capacity rules apply.

It is **not** the reservation engine, and nothing should be built as if it were.

## The model, in one paragraph

Each venue gets **its own Cal.com event type**. The numeric event type id is
stored on `restaurants.calcom_event_type_id` (migration 035) and is the key an
inbound webhook is matched against — the Cal.com equivalent of resolving a call
from the dialled number. A venue with no event type id is simply not mirrored;
that is the per-venue opt-in and there is no separate flag.

## Per-venue setup

1. **Create one event type per venue** in Cal.com.
   - Length = the venue's booking duration (`restaurant_settings.booking_duration_minutes`, default 90).
   - Availability schedule = the venue's real trading hours. **Mazcina is closed Tuesdays and Wednesdays.**
   - Add a **number** booking field with slug exactly **`party-size`**. Without it every
     online booking arrives flagged `party_size_missing` and defaults to 2 covers,
     and staff ring guests back to ask how many are coming.
   - **Leave "offer seats" OFF.** See the limitation below — the admin API refuses a seated event type.
2. **Register a webhook** on that event type (or account-wide, if per-event-type
   webhooks are unavailable):
   - Subscriber URL `https://<this environment's API host>/cal/webhook`
   - A strong random secret → `CALCOM_WEBHOOK_SECRET` for **that environment only**
   - Triggers: `BOOKING_CREATED`, `BOOKING_CANCELLED`, `BOOKING_RESCHEDULED`. Nothing else —
     every other trigger is stored in `inbox_calcom_events` and never processed.
3. **Bind it** in the admin console (`/admin` → the venue → Online bookings), or
   `PATCH /api/admin/restaurants/:id/provisioning` with `{"calcom_event_type_id": 3414737}`.
   The bind is verified before it is stored and refuses with a 409 when:
   | Code | Meaning |
   |---|---|
   | `CALCOM_EVENT_TYPE_ALREADY_BOUND` | another venue holds it — one venue's diners would book the other's tables |
   | `CALCOM_EVENT_TYPE_NOT_FOUND` | Cal.com has no such event type; every booking would be unresolvable |
   | `CALCOM_EVENT_TYPE_SEATED` | seats are on — see the limitation below |
   | `CALCOM_EVENT_TYPE_VENUE_MISMATCH` | the title does not resemble the venue. Override with `?allow_name_mismatch=true` (audited) |

   Verification is skipped, with a warning, only when `CALCOM_API_KEY` is unset —
   which the boot gate makes impossible in production or on staging.

## ⚠️ Current limitation: one booking per time slot

Cal.com blocks a slot once it is booked. Without seats, a venue's Cal.com page
offers each time **once**, so it cannot represent a restaurant that seats ten
parties at 7pm. Today that means Cal.com is only useful for venues where a
single online booking per slot is acceptable, or where the page is deliberately
narrow.

Seats is the fix and it is **not implemented**. The admin bind refuses a seated
event type on purpose, because the mirror assumes one Cal.com booking is one
reservation and seats breaks that assumption in ways that lose real bookings
silently:

- Every party in a slot shares one booking `uid`, so the inbound loop guard
  (`calcomService.ts`) treats the second party as our own echo and drops it.
- `POST /bookings/{uid}/cancel` **without a `seatUid` cancels the whole booking**
  — under seats, every party at that time.
- The webhook does not say which seat it is about: the root `attendeeSeatId` was
  removed without a version bump (`calcom/cal.diy#28508`, open) and the
  `attendees` array carries every seat in the slot.

Enabling seats requires capturing real seated payloads first, then a migration
adding `reservations.calcom_seat_uid`, seat-aware cancel, and set-reconciliation
in the inbound handler. Do not turn seats on in Cal.com before that lands.

## Environment isolation — one Cal.com account, two environments

Staging and production **share one Cal.com account and one API key**. Nothing at
the vendor stops both environments binding the same event type, and a staging
test booking reaching production would write a real reservation on a real
venue's floor — the same class of mistake as `CLAUDE.md` §D rule 2.

Controls that exist:

- **A separate webhook per environment**, each with its own secret, each pointing
  only at that environment's API host. Register these by hand; nothing enforces it.
- **The tenant-mismatch tripwire.** Every outbound push stamps
  `vocotable_restaurant_id`. A staging push carries a staging restaurant UUID
  that does not exist in the production database, so a cross-environment echo
  logs `calcom_inbox_tenant_mismatch` at error instead of stamping a uid onto a
  real booking.
- **The unmapped-event-type alarm.** A webhook whose `eventTypeId` no venue holds
  logs `calcom_inbox_unmapped_event_type` at error and the booking is cancelled
  back on Cal.com so the guest is told now rather than at the door.

The only real fix is a second Cal.com account (or team) for staging. Until then,
prefix staging event type titles with `[STG]` and check the account picker before
every change.

## Turning it on

Order matters, and the flag goes last.

1. Secrets — `deploy/runbooks/staging-secrets.md`. `voxtable-stg-calcom-api-key`,
   `voxtable-stg-calcom-webhook-secret`, created with `printf` not `echo` (a
   trailing newline reads as a wrong key, i.e. a 401 that looks like a bad secret).
2. **The Terraform env map** in `biteperk/biteperk-cloud-platform`
   → `roots/products/voxtable/stg`, then that repo's manual `terraform.yml` apply.
   A secret Terraform does not reference is invisible to the service.
3. Deploy with `CALCOM_SYNC_ENABLED` still **false**; confirm both services boot.
   Read the values back off the running service, not off the Terraform plan.
4. Bind the venue's event type.
5. **Then** flip `CALCOM_SYNC_ENABLED=true`.

`CALCOM_EVENT_TYPE_ID` must **not** be set in production — event types are
per-venue, and the boot gate refuses to start if a global one is present.

## Rollback

**Per venue (prefer this).** Clear `calcom_event_type_id` — admin danger zone, or
`UPDATE restaurants SET calcom_event_type_id = NULL WHERE id = '…';`

This stops new bookings mirroring out and stops inbound webhooks resolving to the
venue. It deliberately does **not** strand bookings already live on Cal.com: the
cancel and reschedule paths gate on the reservation's `calcom_booking_uid`, never
on the venue's current binding, so an existing booking can still be cancelled.
Stopping new mirroring and abandoning existing bookings are different things.

**Platform-wide.** `CALCOM_SYNC_ENABLED=false` disables the outbox worker and makes
`/cal/webhook` return 410. Reach for this only when Cal.com itself is the problem —
it takes every venue's online bookings offline.

On Cloud Run that is a Terraform env change plus a redeploy, not a `sed` on a VM;
`rollback.md`'s Cal.com section describes the VM path, which is production today.

## Dead letters

```sql
SELECT id, reservation_id, op, attempts, last_error, failed_at
  FROM outbox_calcom
 WHERE failed_at IS NOT NULL
 ORDER BY failed_at DESC
 LIMIT 50;
```

`cleanupWorker` deletes succeeded rows after 30 days and **never** deletes failed
ones, so this table is the durable record. Re-enqueue via the admin stuck-jobs
surface rather than by editing rows.

## Known gaps

- **There is no inbox retry worker.** `claimUnprocessedInbox` exists and has no
  callers; `/cal/webhook` processes inline and turns every failure into a 200, so
  Cal.com never retries either. A booking lost to a lock wait or a pool timeout is
  lost. This must be built before Cal.com carries real public traffic.
- **`BOOKING_RESCHEDULED` inbound is ignored** by design. A guest who reschedules
  on Cal.com gets a confirmation for the new time while the floor plan still shows
  the old one.
- **The tenant health endpoint reports platform-wide outbox and inbox stats.** Do
  not surface it per venue until it is scoped.
