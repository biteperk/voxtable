# Restaurant provisioning runbook (Phase 4a — admin-assisted)

When a restaurant finishes the self-serve wizard, its `onboarding_status` becomes
`provisioning` (the Stripe webhook advances it once the trial subscription is
active). At that point a VocoTable admin provisions the telephony + agent, then
flips it live. This is the manual procedure; Phase 4b automates it.

Local development note: when `APP_ENV !== "production"` and
`PROVISIONING_AUTO_ENABLED=false`, the onboarding phone step exposes a
development-only "Finish setup locally" path through
`POST /api/onboarding/verify-forwarding`. That path marks the tenant live
without Twilio/Retell bindings so the dashboard can be exercised locally. It is
not production behavior.

> **Admin dashboard:** every step below can also be done from `/admin` in the
> dashboard (Venues → bind / go-live, Provisioning → jobs + re-enqueue). The
> curl commands remain the source of truth for what each action does. Every
> mutation — UI or curl — is recorded in `admin_actions` with the actor.

## 0. Find the queue
`GET /api/admin/provisioning-queue` (admin-gated) lists restaurants awaiting
provisioning, with their profile + any bindings already set.
`GET /api/admin/restaurants?status=&q=` is the broader cross-tenant list
(any status, name search) with billing/legal columns.

## 1. Buy + configure a Twilio number
1. Twilio Console → Phone Numbers → buy an AU local number.
2. Point the number's Voice config at the SIP trunk that forwards to
   `sip.retellai.com` (the existing `algorythmos` trunk pattern).

## 2. Create the Retell agent
1. Create/clone a Retell agent for this restaurant (single-prompt, en-AU, the
   Bella template).
2. Set its custom-function webhook URLs to `${PUBLIC_API_BASE_URL}/retell/tools/*`
   and the lifecycle webhook to `/retell/webhook`.
3. Note the `agent_id` and the Retell inbound number, if any.

Per-call dynamic variables (restaurant name, timezone, today/tomorrow) are
injected automatically by `handleRetellInbound` from the resolved tenant — no
per-agent cron needed.

## 3. Bind in VocoTable
`PATCH /api/admin/restaurants/:id/provisioning` with:
```json
{ "twilio_phone_number": "+61...", "retell_phone_number": "+61...", "retell_agent_id": "agent_..." }
```
Numbers are normalized to E.164 server-side. `twilio_phone_number` is the trusted
dialed-number key used to route inbound calls to this tenant.

## 4. Owner forwards + activates (self-serve)
The owner's wizard "Connect your phone" step now shows their VocoTable number
and forwarding instructions. After the equivalent staging venue has passed the
complete call battery, they forward their advertised line and use
`POST /api/onboarding/verify-forwarding` to activate the already-reviewed
bindings and advance `provisioning → live`. The endpoint does not require or
create a production test call.

## 5. Go live (admin override)
If activation needs an admin override,
`POST /api/admin/restaurants/:id/go-live` flips the restaurant live once the
subscription gate passes and the Twilio number + Retell agent are bound.

## Rollback
To pull a restaurant back, set `onboarding_status` to `suspended` (billing lapse)
or clear the bindings. Inbound calls to an unmapped number fail safe (Bella is
not bound to any tenant) rather than routing to the wrong restaurant.

Clearing bindings no longer needs SQL: `POST /api/admin/restaurants/:id/unbind`
with `{ "fields": ["twilio_phone_number", ...], "confirm_name": "<exact venue name>" }`.
The venue's name must be typed back exactly, and a live venue additionally
requires `"acknowledge_live": true` — clearing a live venue's bindings
disconnects its phone line.

## Stuck provisioning jobs (Phase 4b, auto-provisioning)
`GET /api/admin/provisioning-jobs?status=failed` lists failed jobs with
`last_error`. `POST /api/admin/provisioning-jobs/:id/re-enqueue` resets the
failed row **in place** (payload preserved — never a second job, which would
buy a second number). If the failure was the purchase crash-window
(`buy_started_at` set, no number recorded): first check the Twilio console for
an unassigned AU number, then re-enqueue with `{ "clear_buy_marker": true }`.
Without that the job re-fails immediately, by design. Re-enqueued jobs only
run while `PROVISIONING_AUTO_ENABLED=true`; the response says so when it's off.
