import { Router } from "express";

import { actorFor, requireAdminRole, requireFirebaseAuth } from "../auth/firebaseAuth";
import { env } from "../config/env";
import { pool } from "../db/pool";
import { AppError } from "../domain/errors";
import { asyncHandler } from "../http/asyncHandler";
import { adminActionLimiter } from "../http/rateLimiters";
import {
  adminProvisioningSchema,
  adminReenqueueSchema,
  adminSupportStatusSchema,
  adminUnbindSchema
} from "../http/schemas";
import { countAdminActions, listAdminActions, recordAdminAction } from "../repositories/adminActions";
import { verifyAgentForVenue } from "../services/retellProvisioning";
import { getLatestAcceptance } from "../repositories/agreements";
import { getInboxStats } from "../repositories/inbox";
import { listRestaurantMembers } from "../repositories/members";
import { getMenuIngestionSummary, rerunFailedIngestionJob } from "../repositories/menuIngestion";
import {
  getNotificationOutboxStats,
  listFailedNotifications,
  retryFailedNotification
} from "../repositories/notifications";
import { getOpsState, listOpsStateByPrefix } from "../repositories/opsState";
import { getOutboxStats } from "../repositories/outbox";
import {
  listProvisioningJobs,
  resetFailedProvisioningJob,
  clearProvisioningPayloadKey
} from "../repositories/provisioning";
import {
  clearProvisioningBindings,
  getProvisioning,
  getRestaurantByCalcomEventTypeId,
  getRestaurantByPhoneNumber,
  getRestaurantByRetellAgentId,
  getOnboardingFunnel,
  getOnboardingStatus,
  getStripeCustomerId,
  listByOnboardingStatus,
  listRestaurantsAdmin,
  setOnboardingStatus,
  setProvisioningBindings,
  setVoicePaused,
  type OnboardingStatus
} from "../repositories/restaurants";
import { listSupportRequests, setSupportRequestStatus } from "../repositories/supportRequests";
import { quotaSnapshotFromDb } from "../services/calcomQuotaTracker";
import { verifyCalcomEventTypeForVenue } from "../services/calcomService";
import {
  getPublishedLegalDocuments,
  legalDocumentsVerificationEnabled
} from "../services/legalDocuments";
import {
  isEmailEnabled,
  isNotificationsEnabled,
  isSmsEnabled,
  notifyRestaurant
} from "../services/notificationService";
import { assertCanGoLive, becameLineReady } from "../services/onboardingService";
import { stripeMode } from "../services/stripeClient";
import { getSubscription } from "../services/stripeService";
import { currentRequestId, logger } from "../utils/logger";
import { normalizePhone } from "../utils/phone";

// Internal provisioning console (VoxTable staff). Cross-tenant, so it is gated
// by requireAdminRole rather than per-restaurant membership.
export const adminRouter = Router();

// Path-scoped so these gates run ONLY for /api/admin/* — a bare router.use(mw)
// leaks onto every fall-through request (the router is mounted at "/"), which
// would 401/403 unrelated endpoints like /api/me and /stripe/webhook.
adminRouter.use("/api/admin", requireFirebaseAuth);
adminRouter.use("/api/admin", requireAdminRole);

// Every mutating admin route records who did what (migration 033). The write
// happens AFTER the mutation succeeds; an audit insert failure is logged but
// never fails the request — the mutation has already committed.
async function audit(
  request: Parameters<typeof actorFor>[0],
  action: string,
  detail: { restaurantId?: string | null; target?: string | null; params?: Record<string, unknown> }
): Promise<void> {
  try {
    await recordAdminAction({
      actorUid: actorFor(request),
      actorEmail: request.firebaseUser?.email ?? null,
      action,
      restaurantId: detail.restaurantId ?? null,
      target: detail.target ?? null,
      params: detail.params ?? {},
      requestId: currentRequestId() ?? null
    });
  } catch (error) {
    logger.error({ message: "admin_action_audit_write_failed", action, error });
  }
}

// Onboarding funnel snapshot — counts per status for drop-off analysis.
adminRouter.get(
  "/api/admin/funnel",
  asyncHandler(async (_request, response) => {
    const funnel = await getOnboardingFunnel();
    response.json({ funnel });
  })
);

// D2/S2: cross-tenant onboarding + OCR-cost health for the ops view. Combines
// the funnel counts with today's menu-OCR ingestion activity (jobs are the
// paid-vision signal: `attempts` ≈ vision calls made). Admin-gated + read-only.
adminRouter.get(
  "/api/admin/onboarding-health",
  asyncHandler(async (_request, response) => {
    const [funnel, ocrRow] = await Promise.all([
      getOnboardingFunnel(),
      pool.query<{
        jobs_today: string;
        committed_today: string;
        failed_today: string;
        attempts_today: string;
        restaurants_today: string;
      }>(
        `
        SELECT
          COUNT(*)::text                                              AS jobs_today,
          COUNT(*) FILTER (WHERE status = 'committed')::text          AS committed_today,
          COUNT(*) FILTER (WHERE status = 'failed')::text             AS failed_today,
          COALESCE(SUM(attempts), 0)::text                            AS attempts_today,
          COUNT(DISTINCT restaurant_id)::text                         AS restaurants_today
        FROM menu_ingestion_jobs
        WHERE created_at >= date_trunc('day', now())
        `
      )
    ]);
    const o = ocrRow.rows[0];
    response.json({
      funnel,
      menu_ocr_today: {
        jobs: Number(o?.jobs_today ?? "0"),
        committed: Number(o?.committed_today ?? "0"),
        failed: Number(o?.failed_today ?? "0"),
        // attempts ≈ vision-LLM calls made today (each retry is another call).
        vision_calls_est: Number(o?.attempts_today ?? "0"),
        restaurants: Number(o?.restaurants_today ?? "0")
      }
    });
  })
);

// Restaurants waiting for a phone line + agent to be bound.
adminRouter.get(
  "/api/admin/provisioning-queue",
  asyncHandler(async (_request, response) => {
    const queue = await listByOnboardingStatus("provisioning");
    response.json({ restaurants: queue });
  })
);

const ONBOARDING_STATUSES: OnboardingStatus[] = [
  "account_created",
  "profile",
  "agreement",
  "menu",
  "trial",
  "provisioning",
  "live",
  "suspended",
  "cancelled"
];

// Cross-tenant venue list for the admin dashboard: bindings + cheap local
// billing/legal columns. Live Stripe state is a separate lazy call per venue.
adminRouter.get(
  "/api/admin/restaurants",
  asyncHandler(async (request, response) => {
    const statusParam = typeof request.query.status === "string" ? request.query.status : undefined;
    const status = ONBOARDING_STATUSES.find((s) => s === statusParam);
    const query = typeof request.query.q === "string" ? request.query.q.slice(0, 100) : undefined;

    const restaurants = await listRestaurantsAdmin({ status, query });

    // The published document-set version lets the UI badge venues whose
    // terms_version has drifted (#191). Best-effort: the list must render
    // even when the manifest bucket is unreachable or unconfigured.
    let publishedTermsVersion: string | null = null;
    if (legalDocumentsVerificationEnabled()) {
      try {
        publishedTermsVersion = (await getPublishedLegalDocuments()).document_set_version;
      } catch {
        publishedTermsVersion = null;
      }
    }

    response.json({ restaurants, published_terms_version: publishedTermsVersion });
  })
);

// Venue 360 — everything the admin venue drawer shows, one round trip.
adminRouter.get(
  "/api/admin/restaurants/:id",
  asyncHandler(async (request, response) => {
    const id = request.params.id!;
    const provisioning = await getProvisioning(id);
    if (!provisioning) throw new AppError(404, "RESTAURANT_NOT_FOUND", "Restaurant not found.");

    const [acceptance, members, elections, activityRow] = await Promise.all([
      getLatestAcceptance(id),
      listRestaurantMembers(id),
      pool.query<{
        client_legal_name: string | null;
        client_abn: string | null;
        services: string[] | null;
        phone_mode: string | null;
        retention_days: number | null;
        storage_tier: string | null;
        pii_redaction: boolean | null;
        service_start_date: string | null;
        playback_approved_at: string | null;
        terms_version: string | null;
        stripe_customer_id: string | null;
        stripe_connect_charges_enabled: boolean;
        stripe_connect_payouts_enabled: boolean;
        voice_paused_at: Date | null;
      }>(
        `SELECT client_legal_name, client_abn, services, phone_mode, retention_days,
                storage_tier, pii_redaction, service_start_date, playback_approved_at,
                terms_version, stripe_customer_id,
                stripe_connect_charges_enabled, stripe_connect_payouts_enabled,
                voice_paused_at
           FROM restaurants WHERE id = $1`,
        [id]
      ),
      pool.query<{ calls_today: string; bookings_today: string }>(
        `SELECT
           (SELECT COUNT(*) FROM call_logs
             WHERE restaurant_id = $1 AND started_at >= date_trunc('day', now()))::text AS calls_today,
           (SELECT COUNT(*) FROM reservations
             WHERE restaurant_id = $1 AND created_at >= date_trunc('day', now()))::text AS bookings_today`,
        [id]
      )
    ]);

    const e = elections.rows[0];
    response.json({
      provisioning,
      legal: {
        terms_version: e?.terms_version ?? null,
        latest_acceptance: acceptance
          ? {
              document_set_version: acceptance.document_set_version,
              accepted_at: acceptance.accepted_at,
              channel: acceptance.channel
            }
          : null,
        elections: e
          ? {
              client_legal_name: e.client_legal_name,
              client_abn: e.client_abn,
              services: e.services ?? [],
              phone_mode: e.phone_mode,
              retention_days: e.retention_days,
              storage_tier: e.storage_tier,
              pii_redaction: e.pii_redaction,
              service_start_date: e.service_start_date,
              playback_approved_at: e.playback_approved_at
            }
          : null
      },
      billing: {
        has_stripe_customer: Boolean(e?.stripe_customer_id),
        connect_charges_enabled: e?.stripe_connect_charges_enabled ?? false,
        connect_payouts_enabled: e?.stripe_connect_payouts_enabled ?? false
      },
      members: members,
      activity_today: {
        calls: Number(activityRow.rows[0]?.calls_today ?? "0"),
        bookings: Number(activityRow.rows[0]?.bookings_today ?? "0")
      },
      voice_paused_at: e?.voice_paused_at ?? null
    });
  })
);

// Live Stripe subscription state — one Stripe API round trip, so it is a
// separate lazy endpoint rather than a column on the venue list.
adminRouter.get(
  "/api/admin/restaurants/:id/subscription",
  asyncHandler(async (request, response) => {
    const id = request.params.id!;
    const customer = await getStripeCustomerId(id);
    if (!customer) {
      response.json({ subscription: null, reason: "no_stripe_customer" });
      return;
    }
    const subscription = await getSubscription(customer, id);
    response.json({ subscription, reason: subscription ? null : "no_subscription" });
  })
);

// Bind the Twilio number / Retell number + agent for a restaurant. Numbers are
// normalized to E.164 so the inbound dialed-number lookup matches.
adminRouter.patch(
  "/api/admin/restaurants/:id/provisioning",
  adminActionLimiter,
  asyncHandler(async (request, response) => {
    const id = request.params.id!;
    const body = adminProvisioningSchema.parse(request.body);

    // Prove the agent before storing it. `restaurants.retell_agent_id` is plain
    // TEXT and is what /retell/inbound returns as override_agent_id, so a typo
    // or another venue's id here routes live calls to the wrong persona with no
    // error anywhere downstream. See verifyAgentForVenue for the incident.
    // Only the NAME check is overridable. An agent may legitimately be named for
    // a brand rather than the venue; it may never be shared between venues (see
    // migration 034), because the agent is where a venue's identity and tools
    // live, and one agent serving two venues is the bug itself.
    const allowNameMismatch = request.query.allow_name_mismatch === "true";

    // Read the venue ONCE, before anything is written. Two things need this:
    // the name checks below, and knowing whether the line was already ready —
    // see the number_ready gate at the end of the handler. It used to be
    // fetched separately inside each check branch, so a bind that touched
    // neither the agent nor Cal.com never validated that the venue existed.
    const venue = await getProvisioning(id);
    if (!venue) throw new AppError(404, "RESTAURANT_NOT_FOUND", "Restaurant not found.");

    if (body.retell_agent_id) {
      const conflict = await getRestaurantByRetellAgentId(body.retell_agent_id, id);
      if (conflict) {
        throw new AppError(
          409,
          "RETELL_AGENT_ALREADY_BOUND",
          `Agent ${body.retell_agent_id} is already bound to "${conflict.name}". Two venues ` +
            `sharing an agent means one of them answers in the other's voice. Build this venue ` +
            `its own agent and LLM — see deploy/runbooks/venue-onboarding.md.`
        );
      }

      // Skipped only where Retell is genuinely not configured, which the boot
      // gate makes impossible in production (and on staging, which runs the
      // production posture) — so this never weakens a real environment.
      if (env.RETELL_API_KEY) {
        const verdict = await verifyAgentForVenue(body.retell_agent_id, venue.name);
        if (!verdict.matchesVenue && !allowNameMismatch) {
          throw new AppError(
            409,
            "RETELL_AGENT_VENUE_MISMATCH",
            `Agent ${body.retell_agent_id} is named "${verdict.agentName ?? "(unnamed)"}", ` +
              `which does not look like "${venue.name}". Binding another venue's agent makes ` +
              `this line answer in that venue's voice. Re-send with ?allow_name_mismatch=true ` +
              `if this is deliberate.`
          );
        }
        if (!verdict.matchesVenue) {
          logger.warn({
            evt: "admin_agent_venue_mismatch_override",
            restaurant_id: id,
            agent_id: body.retell_agent_id,
            agent_name: verdict.agentName,
            venue_name: venue.name
          });
        }
      } else {
        logger.warn({
          evt: "admin_agent_verify_skipped_no_retell_key",
          restaurant_id: id,
          agent_id: body.retell_agent_id
        });
      }
    }

    // Prove the Cal.com event type before storing it, for the same reason the
    // agent is proved above: `calcom_event_type_id` is a bare integer that
    // decides which venue an inbound web booking belongs to, so a wrong one
    // seats this restaurant's online diners at another restaurant's tables,
    // with every name resolving correctly on the way through.
    if (body.calcom_event_type_id !== undefined) {

      const conflict = await getRestaurantByCalcomEventTypeId(body.calcom_event_type_id, id);
      if (conflict) {
        throw new AppError(
          409,
          "CALCOM_EVENT_TYPE_ALREADY_BOUND",
          `Cal.com event type ${body.calcom_event_type_id} is already bound to ` +
            `"${conflict.name}". Two venues sharing one event type means one venue's ` +
            `online diners book the other venue's tables. Create this venue its own ` +
            `event type — see deploy/runbooks/calcom-integration.md.`
        );
      }

      if (env.CALCOM_API_KEY) {
        const verdict = await verifyCalcomEventTypeForVenue(
          body.calcom_event_type_id,
          venue.name
        );
        // Refused, not warned. The mirror currently assumes one Cal.com booking
        // is one reservation; a seated event type puts every party in a slot
        // under one shared uid, which makes the inbound loop guard drop the
        // second party and makes a cancel take out the whole slot. Seats is a
        // deliberate, separate piece of work — until it lands, binding a seated
        // event type would lose real bookings silently.
        if (verdict.seatsPerTimeSlot !== null) {
          throw new AppError(
            409,
            "CALCOM_EVENT_TYPE_SEATED",
            `Cal.com event type ${body.calcom_event_type_id} has seats enabled ` +
              `(${verdict.seatsPerTimeSlot} per slot). VoxTable cannot mirror seated ` +
              `event types yet — every party in a slot would share one booking id, and ` +
              `one guest cancelling would cancel the rest. Turn seats off, or wait for ` +
              `seat support. See deploy/runbooks/calcom-integration.md.`
          );
        }
        if (!verdict.matchesVenue && !allowNameMismatch) {
          throw new AppError(
            409,
            "CALCOM_EVENT_TYPE_VENUE_MISMATCH",
            `Cal.com event type ${body.calcom_event_type_id} is titled ` +
              `"${verdict.title ?? "(untitled)"}", which does not look like "${venue.name}". ` +
              `Re-send with ?allow_name_mismatch=true if this is deliberate.`
          );
        }
        if (!verdict.matchesVenue) {
          logger.warn({
            evt: "admin_calcom_event_type_venue_mismatch_override",
            restaurant_id: id,
            event_type_id: body.calcom_event_type_id,
            event_type_title: verdict.title,
            venue_name: venue.name
          });
        }
        // Not fatal: the inbound handler already flags party_size_missing and
        // defaults to 2 rather than refusing a guest. But catching it here is
        // the difference between a config fix and staff ringing guests back to
        // ask how many are coming.
        if (!verdict.hasPartySizeField) {
          logger.warn({
            evt: "admin_calcom_event_type_missing_party_size",
            restaurant_id: id,
            event_type_id: body.calcom_event_type_id
          });
        }
      } else {
        logger.warn({
          evt: "admin_calcom_verify_skipped_no_api_key",
          restaurant_id: id,
          event_type_id: body.calcom_event_type_id
        });
      }
    }

    // Refuse a number another venue already holds — in either column. The
    // per-column unique indexes from 007 cannot see across columns, and the
    // dialled-number lookup ORs them, so a cross-column duplicate routes calls
    // to whichever venue sorts first (#221). Checked here for the readable
    // 409; migration 039's trigger is the backstop for writes that skip this
    // route.
    const normalizedTwilio = body.twilio_phone_number
      ? normalizePhone(body.twilio_phone_number) ?? body.twilio_phone_number
      : undefined;
    const normalizedRetell = body.retell_phone_number
      ? normalizePhone(body.retell_phone_number) ?? body.retell_phone_number
      : undefined;
    for (const number of new Set([normalizedTwilio, normalizedRetell])) {
      if (!number) continue;
      const holder = await getRestaurantByPhoneNumber(number, id);
      if (holder) {
        throw new AppError(
          409,
          "PHONE_NUMBER_ALREADY_BOUND",
          `${number} is already bound to "${holder.name}". A number can belong to exactly ` +
            `one venue — calls to a shared number would reach whichever venue the database ` +
            `returns first. Unbind it there before binding it here.`
        );
      }
    }

    const updated = await setProvisioningBindings(id, {
      twilioPhoneNumber: normalizedTwilio,
      retellPhoneNumber: normalizedRetell,
      retellAgentId: body.retell_agent_id,
      calcomEventTypeId: body.calcom_event_type_id
    });
    // Tell the owner their line is ready — but only when this bind is what made
    // it ready. The condition used to be "both columns are non-null now", which
    // is true on EVERY later bind too, so correcting a typo in the Cal.com field
    // re-sent the launch email. enqueueNotification has no per-kind dedupe, so
    // the venue simply received it again. Gate on the transition instead.
    const prov = await getProvisioning(id);
    if (becameLineReady(venue, prov)) {
      void notifyRestaurant("number_ready", id, { number: prov!.twilio_phone_number! });
    }
    await audit(request, "provisioning_bind", {
      restaurantId: id,
      params: { ...body, allow_name_mismatch: allowNameMismatch }
    });
    // The profile response omits binding columns; the fresh ProvisioningRow
    // lets the UI render the result without a second fetch.
    response.json({ profile: updated, provisioning: prov });
  })
);

// Clear bindings — the destructive counterpart of the COALESCE-only bind.
// Typed-name confirm always; a live venue additionally requires an explicit
// acknowledgement, because unbinding it disconnects the venue's phone line.
adminRouter.post(
  "/api/admin/restaurants/:id/unbind",
  adminActionLimiter,
  asyncHandler(async (request, response) => {
    const id = request.params.id!;
    const body = adminUnbindSchema.parse(request.body);

    const current = await getProvisioning(id);
    if (!current) throw new AppError(404, "RESTAURANT_NOT_FOUND", "Restaurant not found.");
    if (body.confirm_name !== current.name) {
      throw new AppError(
        409,
        "CONFIRM_NAME_MISMATCH",
        "Type the venue's exact name to confirm clearing its bindings."
      );
    }
    if (current.onboarding_status === "live" && !body.acknowledge_live) {
      throw new AppError(
        409,
        "VENUE_IS_LIVE",
        "This venue is live — clearing its bindings disconnects its phone line. Acknowledge that to continue."
      );
    }

    const updated = await clearProvisioningBindings(id, body.fields);
    await audit(request, "provisioning_unbind", {
      restaurantId: id,
      target: body.fields.join(","),
      params: { fields: body.fields, was_live: current.onboarding_status === "live" }
    });
    response.json({ provisioning: updated });
  })
);

// Per-venue phone kill switch (platform admin). The owner has the same control
// in their own dashboard; this is the support-desk equivalent. No typed
// confirmation — it is reversible in one click, unlike unbind.
adminRouter.post(
  "/api/admin/restaurants/:id/voice/pause",
  adminActionLimiter,
  asyncHandler(async (request, response) => {
    const id = request.params.id!;
    const pausedAt = await setVoicePaused(id, true);
    await audit(request, "voice_pause", { restaurantId: id });
    response.json({ voice_paused_at: pausedAt });
  })
);

adminRouter.post(
  "/api/admin/restaurants/:id/voice/resume",
  adminActionLimiter,
  asyncHandler(async (request, response) => {
    const id = request.params.id!;
    await setVoicePaused(id, false);
    await audit(request, "voice_resume", { restaurantId: id });
    response.json({ voice_paused_at: null });
  })
);

// Flip a fully-provisioned restaurant live. Requires the subscription gate
// (status past trial → provisioning) AND the telephony bindings in place.
adminRouter.post(
  "/api/admin/restaurants/:id/go-live",
  adminActionLimiter,
  asyncHandler(async (request, response) => {
    const id = request.params.id!;
    const status = await getOnboardingStatus(id);
    if (!status) throw new AppError(404, "RESTAURANT_NOT_FOUND", "Restaurant not found.");
    assertCanGoLive(status);

    const prov = await getProvisioning(id);
    if (!prov?.twilio_phone_number || !prov?.retell_agent_id) {
      throw new AppError(
        409,
        "PROVISIONING_INCOMPLETE",
        "Bind the Twilio number and Retell agent before going live."
      );
    }

    await setOnboardingStatus(id, "live");
    await audit(request, "go_live", { restaurantId: id, params: { from_status: status } });
    response.json({ onboarding_status: "live" });
  })
);

// --- Provisioning jobs (#151) ----------------------------------------------

const JOB_STATUSES = ["pending", "processing", "done", "failed"] as const;

adminRouter.get(
  "/api/admin/provisioning-jobs",
  asyncHandler(async (request, response) => {
    const statusParam = typeof request.query.status === "string" ? request.query.status : undefined;
    const status = JOB_STATUSES.find((s) => s === statusParam);
    const jobs = await listProvisioningJobs(status);
    // Surfaced so the UI can warn that a re-enqueued job will not run until
    // auto-provisioning is switched on — the worker no-ops otherwise.
    response.json({ jobs, worker_enabled: env.PROVISIONING_AUTO_ENABLED });
  })
);

adminRouter.post(
  "/api/admin/provisioning-jobs/:id/re-enqueue",
  adminActionLimiter,
  asyncHandler(async (request, response) => {
    const id = request.params.id!;
    const body = adminReenqueueSchema.parse(request.body ?? {});

    // Clearing the crash-window marker must happen BEFORE the reset: the
    // worker fails a job permanently when buy_started_at is set with no
    // recorded number, so a plain reset would re-fail on the next tick.
    if (body.clear_buy_marker) {
      await clearProvisioningPayloadKey(id, "buy_started_at");
    }

    const job = await resetFailedProvisioningJob(id);
    if (!job) {
      throw new AppError(
        409,
        "JOB_NOT_FAILED",
        "Only a failed job can be re-enqueued — this one doesn't exist or isn't failed."
      );
    }

    await audit(request, "provisioning_job_reenqueue", {
      restaurantId: job.restaurant_id,
      target: id,
      params: { clear_buy_marker: body.clear_buy_marker }
    });

    const warnings: string[] = [];
    if (job.payload.buy_started_at) {
      warnings.push(
        "The job still carries a purchase-started marker: it will fail again until someone checks the Twilio console for an orphaned number and re-enqueues with the marker cleared."
      );
    }
    if (!env.PROVISIONING_AUTO_ENABLED) {
      warnings.push("Auto-provisioning is off — this job will not run until it is switched on.");
    }
    response.json({ job, worker_enabled: env.PROVISIONING_AUTO_ENABLED, warnings });
  })
);

// --- Ops summary -------------------------------------------------------------

// One aggregation of the platform-wide health state the Slack alerter watches,
// so an operator can see it without waiting for a page. Read-only.
adminRouter.get(
  "/api/admin/ops-summary",
  asyncHandler(async (_request, response) => {
    const [
      outbox,
      inbox,
      breakerRow,
      quota,
      latches,
      notifications,
      failedNotifications,
      menuOcr,
      paymentsRow,
      kdsHeartbeats
    ] =
      await Promise.all([
        getOutboxStats(),
        getInboxStats(),
        getOpsState("calcom-breaker"),
        quotaSnapshotFromDb(),
        getOpsState("health-alerter-latches"),
        getNotificationOutboxStats(),
        // The rows, not just the counts: "failed: 1" cannot be acted on, and
        // the panel now offers a retry per row.
        listFailedNotifications(10),
        getMenuIngestionSummary(),
        pool.query<{ stuck: string; disputes: string; mismatches: string }>(
          `SELECT
             (SELECT count(*) FROM order_payments
               WHERE status IN ('created','sent','processing')
                 AND expires_at IS NOT NULL
                 AND expires_at < now() - interval '30 minutes') AS stuck,
             (SELECT count(*) FROM order_payments
               WHERE status = 'disputed' AND updated_at > now() - interval '24 hours') AS disputes,
             (SELECT count(*) FROM order_payments p
               WHERE p.status = 'paid'
                 AND p.updated_at > now() - interval '24 hours'
                 AND EXISTS (
                   SELECT 1 FROM orders o
                    WHERE o.id = p.order_id
                      AND (o.payment_status <> 'paid' OR o.status = 'cancelled'))) AS mismatches`
        ),
        listOpsStateByPrefix("kds-heartbeat:")
      ]);

    response.json({
      calcom: {
        enabled: env.CALCOM_SYNC_ENABLED,
        outbox,
        inbox,
        circuit_breaker: {
          state: String(breakerRow?.state ?? "closed"),
          consecutive_failures: Number(breakerRow?.consecutiveFailures ?? 0),
          opened_at:
            typeof breakerRow?.openedAt === "number"
              ? new Date(breakerRow.openedAt as number).toISOString()
              : null
        },
        quota
      },
      // The alerter's edge-trigger latches: any true flag is an alert that is
      // currently OPEN in Slack. Zero extra SQL — the worker maintains this row.
      alert_latches: latches ?? {},
      notifications,
      failed_notifications: failedNotifications.map((n) => ({
        id: n.id,
        restaurant_id: n.restaurant_id,
        channel: n.channel,
        kind: n.kind,
        recipient: n.recipient,
        attempts: n.attempts,
        last_error: n.last_error,
        created_at: n.created_at
      })),
      menu_ocr: menuOcr,
      order_payments: {
        stuck: Number(paymentsRow.rows[0]?.stuck ?? "0"),
        disputes_24h: Number(paymentsRow.rows[0]?.disputes ?? "0"),
        mismatches_24h: Number(paymentsRow.rows[0]?.mismatches ?? "0")
      },
      kds_tablets: kdsHeartbeats.map((row) => ({
        key: row.key,
        last_seen_at:
          typeof row.value.at === "number" ? new Date(row.value.at as number).toISOString() : null
      }))
    });
  })
);

// Per-venue voice/booking activity today + platform totals.
adminRouter.get(
  "/api/admin/activity",
  asyncHandler(async (_request, response) => {
    const result = await pool.query<{
      restaurant_id: string;
      name: string | null;
      calls_today: string;
      bookings_today: string;
      duration_seconds_today: string;
    }>(
      `
      WITH calls AS (
        SELECT restaurant_id,
               COUNT(*) AS calls,
               COALESCE(SUM(duration_seconds), 0) AS duration_seconds
          FROM call_logs
         WHERE started_at >= date_trunc('day', now())
         GROUP BY restaurant_id
      ), bookings AS (
        SELECT restaurant_id, COUNT(*) AS bookings
          FROM reservations
         WHERE created_at >= date_trunc('day', now())
         GROUP BY restaurant_id
      )
      SELECT r.id AS restaurant_id, r.name,
             COALESCE(c.calls, 0)::text AS calls_today,
             COALESCE(b.bookings, 0)::text AS bookings_today,
             COALESCE(c.duration_seconds, 0)::text AS duration_seconds_today
        FROM restaurants r
        LEFT JOIN calls c ON c.restaurant_id = r.id
        LEFT JOIN bookings b ON b.restaurant_id = r.id
       -- Every LIVE venue appears, including the silent ones. The old filter
       -- required a calls or bookings row, so it dropped any venue with no
       -- activity -- and "this venue has taken no calls today", the single most
       -- interesting thing on the page, was therefore invisible.
       WHERE r.onboarding_status = 'live'
          OR c.restaurant_id IS NOT NULL
          OR b.restaurant_id IS NOT NULL
       ORDER BY COALESCE(c.calls, 0) DESC, r.name ASC
      `
    );
    const venues = result.rows.map((row) => ({
      restaurant_id: row.restaurant_id,
      name: row.name,
      calls_today: Number(row.calls_today),
      bookings_today: Number(row.bookings_today),
      duration_seconds_today: Number(row.duration_seconds_today),
      // Rounded up per venue for display, because a 40-second call is a minute
      // of billable voice. Do NOT sum this column — see voice_minutes_today
      // below for the platform figure.
      voice_minutes_today: Math.ceil(Number(row.duration_seconds_today) / 60)
    }));
    response.json({
      venues,
      totals: {
        calls_today: venues.reduce((n, v) => n + v.calls_today, 0),
        bookings_today: venues.reduce((n, v) => n + v.bookings_today, 0),
        // Summed from SECONDS then rounded once. Summing the per-venue rounded
        // minutes over-counted by up to a minute per venue, so the column and
        // the total disagreed and neither was the real figure.
        voice_minutes_today: Math.ceil(
          venues.reduce((n, v) => n + v.duration_seconds_today, 0) / 60
        )
      }
    });
  })
);

/**
 * Everything waiting on a human, in one list.
 *
 * The Overview's only signal was "All quiet", which is true right up until it
 * isn't — a venue that paid and then sat in `provisioning` for hours showed up
 * nowhere, and that is exactly what happened on 7 Sep 2026. Each row carries
 * what it is, which venue, how long it has been waiting, and where to go.
 *
 * Three parallel queries rather than one: the restaurants signals collapse into
 * a single scan with FILTERs, and notifications and order payments are
 * different tables. Same shape as /ops-summary.
 */
adminRouter.get(
  "/api/admin/needs-attention",
  asyncHandler(async (_request, response) => {
    const [venueRows, notifRow, paymentRow, openSupport] = await Promise.all([
      pool.query<{
        id: string;
        name: string;
        reason: string;
        since: string;
      }>(
        `
        SELECT id, name, 'stuck_provisioning' AS reason, updated_at AS since
          FROM restaurants
         WHERE onboarding_status = 'provisioning'
        UNION ALL
        -- A venue marked live that cannot actually take a call. The admin used
        -- to render a green "Live" pill for exactly this state.
        SELECT id, name, 'live_without_line' AS reason, updated_at AS since
          FROM restaurants
         WHERE onboarding_status = 'live'
           AND (twilio_phone_number IS NULL OR retell_agent_id IS NULL)
        UNION ALL
        SELECT id, name, 'paused_over_24h' AS reason, voice_paused_at AS since
          FROM restaurants
         WHERE voice_paused_at IS NOT NULL
           AND voice_paused_at < now() - interval '24 hours'
        `
      ),
      pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM notifications_outbox WHERE status = 'failed'"
      ),
      // Same predicate as /ops-summary's `stuck` count, deliberately — two
      // surfaces disagreeing about what "stuck" means is worse than either
      // number being slightly off. ('pending' is not a valid
      // order_payment_status; the live states are created/sent/processing.)
      pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM order_payments
          WHERE status IN ('created','sent','processing')
            AND expires_at IS NOT NULL
            AND expires_at < now() - interval '30 minutes'`
      ),
      listSupportRequests({ status: "open" })
    ]);

    const items = venueRows.rows.map((row) => ({
      kind: row.reason,
      restaurant_id: row.id,
      venue: row.name,
      since: row.since,
      href: `/admin/venues?venue=${row.id}`
    }));

    const failedNotifications = Number(notifRow.rows[0]?.n ?? "0");
    const stuckPayments = Number(paymentRow.rows[0]?.n ?? "0");

    response.json({
      items,
      counts: {
        venues: items.length,
        failed_notifications: failedNotifications,
        stuck_payments: stuckPayments,
        open_support: openSupport.length
      },
      // One number for the tab badge and the headline tile.
      total: items.length + failedNotifications + stuckPayments + openSupport.length
    });
  })
);

// Put a dead notification back in the queue. The Ops panel showed "failed: 1"
// with no way to act on it, so a bounced welcome email just sat there.
adminRouter.post(
  "/api/admin/notifications/:id/retry",
  adminActionLimiter,
  asyncHandler(async (request, response) => {
    const id = request.params.id!;
    const row = await retryFailedNotification(id);
    if (!row) {
      throw new AppError(
        409,
        "NOTIFICATION_NOT_RETRYABLE",
        "That notification either doesn't exist or isn't in a failed state, so there is nothing to retry."
      );
    }
    await audit(request, "notification_retry", {
      restaurantId: row.restaurant_id,
      target: id,
      params: { kind: row.kind, channel: row.channel }
    });
    response.json({ notification: row });
  })
);

// Re-run a failed menu import. Capped per job from the audit log because this
// bypasses the daily cap and each run is a paid vision call — see
// rerunFailedIngestionJob.
const MAX_MENU_IMPORT_RERUNS = 3;

adminRouter.post(
  "/api/admin/menu-imports/:id/rerun",
  adminActionLimiter,
  asyncHandler(async (request, response) => {
    const id = request.params.id!;
    const already = await countAdminActions("menu_import_rerun", id);
    if (already >= MAX_MENU_IMPORT_RERUNS) {
      throw new AppError(
        409,
        "MENU_IMPORT_RERUN_LIMIT",
        `This import has already been re-run ${already} times. Each run is a paid vision call, ` +
          `so the limit is ${MAX_MENU_IMPORT_RERUNS} — the menu likely needs a different photo ` +
          `or a manual entry rather than another attempt.`
      );
    }
    const job = await rerunFailedIngestionJob(id);
    if (!job) {
      throw new AppError(
        409,
        "MENU_IMPORT_NOT_RETRYABLE",
        "That import either doesn't exist or isn't in a failed state, so there is nothing to re-run."
      );
    }
    await audit(request, "menu_import_rerun", {
      restaurantId: job.restaurant_id,
      target: id,
      params: { attempt: already + 1, of: MAX_MENU_IMPORT_RERUNS }
    });
    response.json({ job, reruns_used: already + 1, reruns_allowed: MAX_MENU_IMPORT_RERUNS });
  })
);

// What is switched on in THIS environment. Admin-gated: the flag set is a map
// of what's live and what's off.
adminRouter.get(
  "/api/admin/flags",
  asyncHandler(async (_request, response) => {
    let mode: "test" | "live" | null = null;
    try {
      mode = stripeMode();
    } catch {
      mode = null;
    }
    response.json({
      app_env: env.APP_ENV,
      app_version: env.APP_VERSION,
      stripe_mode: mode,
      flags: {
        voice_booking: env.VOICE_BOOKING_ENABLED,
        calcom_sync: env.CALCOM_SYNC_ENABLED,
        stripe_billing: env.STRIPE_BILLING_ENABLED,
        stripe_connect: env.STRIPE_CONNECT_ENABLED,
        order_payments: env.ORDER_PAYMENTS_ENABLED,
        menu_ocr: env.MENU_OCR_ENABLED,
        notifications: isNotificationsEnabled(),
        notifications_email: isEmailEnabled(),
        notifications_sms: isSmsEnabled(),
        email_verification_code: env.EMAIL_VERIFICATION_CODE_ENABLED,
        provisioning_auto: env.PROVISIONING_AUTO_ENABLED,
        self_serve_signup: env.SELF_SERVE_SIGNUP_ENABLED,
        terms_verification: legalDocumentsVerificationEnabled()
      }
    });
  })
);

// Recent admin actions — the audit trail, on screen.
adminRouter.get(
  "/api/admin/actions",
  asyncHandler(async (request, response) => {
    const limitParam = Number(request.query.limit);
    const actions = await listAdminActions(Number.isFinite(limitParam) ? limitParam : 50);
    response.json({ actions });
  })
);

// --- Support inbox -----------------------------------------------------------

const SUPPORT_STATUSES = ["open", "in_progress", "resolved", "closed"] as const;

adminRouter.get(
  "/api/admin/support-requests",
  asyncHandler(async (request, response) => {
    const statusParam = typeof request.query.status === "string" ? request.query.status : undefined;
    const status = SUPPORT_STATUSES.find((s) => s === statusParam);
    const requests = await listSupportRequests({ status });
    response.json({ support_requests: requests });
  })
);

adminRouter.patch(
  "/api/admin/support-requests/:id",
  adminActionLimiter,
  asyncHandler(async (request, response) => {
    const id = request.params.id!;
    const body = adminSupportStatusSchema.parse(request.body);
    const updated = await setSupportRequestStatus(id, body.status);
    if (!updated) throw new AppError(404, "SUPPORT_REQUEST_NOT_FOUND", "Support request not found.");
    await audit(request, "support_status_change", {
      restaurantId: updated.restaurant_id,
      target: id,
      params: { status: body.status }
    });
    response.json({ support_request: updated });
  })
);
