import { useState } from "react";

import {
  adminDiscardNotification,
  adminRetryNotification,
  getAdminActions,
  getAdminActivity,
  getAdminNeedsAttention,
  getAdminOnboardingHealth,
  getAdminOpsSummary
} from "../../api";
import { AdminAction } from "../../components/admin/AdminAction";
import { RefreshControl } from "../../components/admin/RefreshControl";
import { Badge } from "../../components/admin/Badge";
import { DataTable } from "../../components/admin/DataTable";
import { EmptyState } from "../../components/admin/EmptyState";
import { SectionCard } from "../../components/admin/SectionCard";
import { SkeletonLines } from "../../components/admin/Skeleton";
import { StatTile } from "../../components/admin/StatTile";
import { useToast } from "../../components/admin/Toast";
import { Icon } from "../../components/Icon";
import { useAdminData } from "../../hooks/useAdminData";
import { shouldBlockPage } from "../../lib/adminRefresh";
import { relativeTime } from "../../lib/format";

const FUNNEL_ORDER = [
  ["account_created", "Signed up"],
  ["profile", "Profile"],
  ["agreement", "Agreement"],
  ["menu", "Menu"],
  ["trial", "Trial"],
  ["provisioning", "Provisioning"],
  ["live", "Live"],
  ["suspended", "Suspended"],
  ["cancelled", "Cancelled"]
];

// Plain-language labels for the alerter's latch keys — a true latch is an
// alert currently open in Slack.
const LATCH_LABELS = {
  outboxDepthAlerted: "Cal.com outbox backing up",
  breakerOpenAlerted: "Cal.com circuit breaker open",
  inboxFailuresAlerted: "Cal.com inbox failures",
  deadLetterAlerted: "Cal.com dead-lettered bookings",
  kdsStuckAlerted: "Kitchen orders waiting too long",
  kdsHeartbeatAlerted: "Kitchen tablet silent",
  retellAuthAlerted: "Retell webhook auth failures",
  provisioningStuckAlerted: "Provisioning jobs stuck or failed",
  notificationsStuckAlerted: "Notifications failing to send",
  stripeUnprocessedAlerted: "Stripe webhooks unprocessed",
  menuImportsFailedAlerted: "Menu imports failing",
  noBookingsAlerted: "Calls arriving but no bookings",
  orderPaymentsStuckAlerted: "Payment links stuck past expiry",
  orderPaymentsDisputeAlerted: "Guest payment disputed",
  orderPaymentsMismatchAlerted: "Paid orders not settled"
};

// What each attention row MEANS and what the operator does about it. The list
// used to be a single "All quiet", which is true right up until it isn't.
const ATTENTION = {
  stuck_provisioning: {
    title: "Waiting for a phone line",
    body: "This venue has paid and is sitting in provisioning. Bind its number and agent.",
    state: "warn",
    cta: "Open venue"
  },
  live_without_line: {
    title: "Live with no phone line",
    body: "Marked live, but there is no Twilio number or Retell agent — nothing answers a call.",
    state: "danger",
    cta: "Fix bindings"
  },
  paused_over_24h: {
    title: "Voice paused over 24 hours",
    body: "Callers are being told this venue isn't taking phone bookings. Check it was meant to stay off.",
    state: "warn",
    cta: "Open venue"
  }
};

export function AdminOverview({ flags, goVenues, goTab }) {
  const [busy, setBusy] = useState(null);
  const toast = useToast();

  const { data, error, lastUpdatedAt, refreshing, announcement, refresh } = useAdminData(
    async () => {
      const [activity, health, ops, actions, attention] = await Promise.all([
        getAdminActivity(),
        getAdminOnboardingHealth(),
        getAdminOpsSummary(),
        getAdminActions(15),
        getAdminNeedsAttention()
      ]);
      return { activity, health, ops, actions: actions.actions ?? [], attention };
    },
    { intervalMs: 30000 }
  );

  // Only when there is nothing to show. With data on screen a failure is
  // reported beside it — one flaky endpoint out of five used to replace a
  // fully-read overview with an error card.
  if (shouldBlockPage({ data, error })) {
    return (
      <div className="admin-stack">
        <SectionCard title="Couldn't load the overview" tone="danger" icon="error">
          <p className="admin-muted">{error}</p>
          <AdminAction onAct={refresh} icon="refresh" busy={refreshing} busyLabel="Retrying…">
            Try again
          </AdminAction>
        </SectionCard>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="admin-stack">
        <SectionCard title="Needs attention">
          <SkeletonLines lines={4} label="Loading the overview" />
        </SectionCard>
      </div>
    );
  }

  const totals = data.activity?.totals ?? {};
  const funnel = data.health?.funnel ?? {};
  const venues = data.activity?.venues ?? [];
  const attention = data.attention ?? { items: [], counts: {}, total: 0 };
  const failedNotifications = data.ops?.failed_notifications ?? [];
  const openLatches = Object.entries(data.ops?.alert_latches ?? {}).filter(
    ([key, value]) => value === true && LATCH_LABELS[key]
  );

  // Email off means a retry cannot succeed — see AdminOps for the same rule.
  const emailOff = flags?.flags?.notifications_email === false;

  const discardNotification = async (id) => {
    setBusy(`discard-${id}`);
    try {
      await adminDiscardNotification(id);
      toast.success("Discarded — it will not be sent, and the audit log records what it was.");
      await refresh();
    } catch (e) {
      toast.error(e.message ?? "That discard didn't go through.");
    } finally {
      setBusy(null);
    }
  };

  const retryNotification = async (id) => {
    setBusy(`notif-${id}`);
    try {
      await adminRetryNotification(id);
      toast.success("Back in the queue — the worker will try it again within a few minutes.");
      await refresh();
    } catch (e) {
      toast.error(e.message ?? "That retry didn't go through.");
    } finally {
      setBusy(null);
    }
  };

  const attentionState = attention.total === 0 ? "default" : "warn";

  return (
    <div className="admin-stack">
      {error ? (
        <div className="adm-stale-notice" role="status">
          <Icon name="cloud_off" />
          <span>
            Couldn&apos;t refresh — showing the last good data from{" "}
            {lastUpdatedAt ? relativeTime(new Date(lastUpdatedAt)).toLowerCase() : "earlier"}. {error}
          </span>
        </div>
      ) : null}
      <section className="adm-stat-grid" aria-label="Today at a glance">
        <StatTile
          label="Calls today"
          value={totals.calls_today ?? 0}
          note={`${totals.voice_minutes_today ?? 0} voice minutes`}
          icon="call"
        />
        <StatTile
          label="Bookings today"
          value={totals.bookings_today ?? 0}
          note="Across every venue"
          icon="event_available"
        />
        <StatTile
          label="Venues live"
          value={funnel.live ?? 0}
          note="Answering calls"
          icon="storefront"
          onClick={() => goVenues?.("live")}
          ariaLabel="Show live venues"
        />
        <StatTile
          label="Needs attention"
          value={attention.total}
          note={attention.total === 0 ? "Nothing waiting" : "Waiting on a human"}
          icon="pending_actions"
          state={attentionState}
        />
      </section>

      <SectionCard
        title="Needs attention"
        subtitle="Everything waiting on a human, oldest first."
        icon="pending_actions"
        badge={
          attention.total > 0 ? (
            <Badge state="warn">{attention.total} open</Badge>
          ) : (
            <Badge state="ok">Clear</Badge>
          )
        }
        actions={
          <RefreshControl
            lastUpdatedAt={lastUpdatedAt}
            refreshing={refreshing}
            announcement={announcement}
            onRefresh={refresh}
          />
        }
      >
        {attention.total === 0 && openLatches.length === 0 ? (
          <EmptyState icon="task_alt" title="Nothing is waiting on you">
            No stuck venues, no failed messages, no open support requests, and no alerts latched
            open in Slack.
          </EmptyState>
        ) : (
          <ul className="adm-attention">
            {attention.items.map((item) => {
              const meta = ATTENTION[item.kind] ?? {
                title: item.kind.replace(/_/g, " "),
                body: "",
                state: "warn",
                cta: "Open venue"
              };
              return (
                <li key={`${item.kind}-${item.restaurant_id}`} className="adm-attention-row">
                  <Badge state={meta.state}>{meta.title}</Badge>
                  <div className="adm-attention-body">
                    <strong>{item.venue ?? item.restaurant_id}</strong>
                    <p className="admin-muted">{meta.body}</p>
                  </div>
                  <span className="admin-muted adm-attention-age">
                    {item.since ? relativeTime(new Date(item.since)) : "—"}
                  </span>
                  <AdminAction
                    onAct={() => goVenues?.(null, item.restaurant_id)}
                    icon="open_in_new"
                    blocked={goVenues ? null : "Open the Venues tab to act on this."}
                  >
                    {meta.cta}
                  </AdminAction>
                </li>
              );
            })}

            {failedNotifications.map((n) => (
              <li key={`notif-${n.id}`} className="adm-attention-row">
                <Badge state="danger">Message failed</Badge>
                <div className="adm-attention-body">
                  <strong>
                    {n.kind.replace(/_/g, " ")} · {n.recipient}
                  </strong>
                  <p className="admin-muted">{n.last_error ?? "No error recorded."}</p>
                </div>
                <span className="admin-muted adm-attention-age">
                  {n.created_at ? relativeTime(new Date(n.created_at)) : "—"}
                </span>
                <div className="adm-row-actions">
                  <AdminAction
                    onAct={() => retryNotification(n.id)}
                    busy={busy === `notif-${n.id}`}
                    blocked={
                      n.channel === "email" && emailOff
                        ? "Email is switched off in this environment, so a retry would sit unsent. Discard it instead."
                        : null
                    }
                    icon="replay"
                  >
                    Retry
                  </AdminAction>
                  <AdminAction
                    onAct={() => discardNotification(n.id)}
                    busy={busy === `discard-${n.id}`}
                    tone="danger"
                    icon="delete"
                    busyLabel="Discarding…"
                  >
                    Discard
                  </AdminAction>
                </div>
              </li>
            ))}

            {attention.counts?.stuck_payments ? (
              <li className="adm-attention-row">
                <Badge state="warn">Payment links stuck</Badge>
                <div className="adm-attention-body">
                  <strong>
                    {attention.counts.stuck_payments} link
                    {attention.counts.stuck_payments === 1 ? "" : "s"} past expiry
                  </strong>
                  <p className="admin-muted">
                    A guest was sent a payment link that never completed or expired cleanly.
                  </p>
                </div>
                <span className="admin-muted adm-attention-age">—</span>
                <AdminAction onAct={() => goTab?.("/admin/ops")} icon="arrow_forward">
                  Open Ops
                </AdminAction>
              </li>
            ) : null}

            {attention.counts?.open_support ? (
              <li className="adm-attention-row">
                <Badge state="info">Support waiting</Badge>
                <div className="adm-attention-body">
                  <strong>
                    {attention.counts.open_support} open request
                    {attention.counts.open_support === 1 ? "" : "s"}
                  </strong>
                  <p className="admin-muted">A venue has asked us something and has no reply yet.</p>
                </div>
                <span className="admin-muted adm-attention-age">—</span>
                <AdminAction onAct={() => goTab?.("/admin/support")} icon="arrow_forward">
                  Open Support
                </AdminAction>
              </li>
            ) : null}

            {openLatches.map(([key]) => (
              <li key={key} className="adm-attention-row">
                <Badge state="danger">Alert open in Slack</Badge>
                <div className="adm-attention-body">
                  <strong>{LATCH_LABELS[key]}</strong>
                  <p className="admin-muted">
                    Latched open right now — it clears itself when the condition goes away.
                  </p>
                </div>
                <span className="admin-muted adm-attention-age">—</span>
                <AdminAction onAct={() => goTab?.("/admin/ops")} icon="arrow_forward">
                  Open Ops
                </AdminAction>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="Onboarding funnel"
        subtitle="Where every venue currently sits. Pick a stage to see those venues."
        icon="conversion_path"
      >
        <div className="adm-funnel">
          {FUNNEL_ORDER.map(([status, label]) => (
            <button
              key={status}
              type="button"
              className="adm-funnel-step"
              onClick={() => goVenues?.(status)}
              aria-label={`Show venues at ${label}`}
            >
              <span className="adm-funnel-value">{funnel[status] ?? 0}</span>
              <span className="adm-funnel-label">{label}</span>
            </button>
          ))}
        </div>
      </SectionCard>

      <SectionCard
        title="Venue activity today"
        subtitle="Every live venue, including the quiet ones — a venue with no calls is the interesting row."
        icon="insights"
      >
        <DataTable
          caption="Calls, bookings and voice minutes per venue since midnight"
          rowKey={(row) => row.restaurant_id}
          initialSort={{ key: "calls_today", direction: "descending" }}
          onRowClick={(row) => goVenues?.(null, row.restaurant_id)}
          rows={venues}
          columns={[
            {
              key: "name",
              label: "Venue",
              sortable: true,
              render: (row) => row.name ?? row.restaurant_id
            },
            { key: "calls_today", label: "Calls", sortable: true, align: "right" },
            { key: "bookings_today", label: "Bookings", sortable: true, align: "right" },
            {
              key: "voice_minutes_today",
              label: "Voice minutes",
              sortable: true,
              align: "right"
            }
          ]}
          empty={
            <EmptyState icon="storefront" title="No live venues yet">
              Once a venue goes live it appears here whether or not it has taken a call.
            </EmptyState>
          }
        />
      </SectionCard>

      <SectionCard
        title="Feature flags"
        subtitle="What this environment has switched on, in words — not by colour alone."
        icon="toggle_on"
      >
        <FlagGroups flags={flags} />
      </SectionCard>

      <SectionCard
        title="Recent admin actions"
        subtitle="Every mutation from this console is audited."
        icon="history"
      >
        {data.actions.length === 0 ? (
          <EmptyState icon="history" title="Nothing yet">
            Actions taken here — binds, pauses, retries — will appear in this list.
          </EmptyState>
        ) : (
          <ul className="adm-audit-list">
            {data.actions.map((a) => (
              <li key={a.id}>
                <Icon name="bolt" />
                <span className="adm-audit-what">{a.action.replace(/_/g, " ")}</span>
                <span className="admin-muted">{a.actor_email ?? a.actor_uid}</span>
                <span className="admin-muted">
                  {a.created_at ? relativeTime(new Date(a.created_at)) : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

/**
 * On and Off are separate groups with the word rendered. The old panel was
 * titled "What's switched on" and then listed every flag regardless of value,
 * distinguished only by a border colour — so a flag that was OFF read as ON.
 */
function FlagGroups({ flags }) {
  const entries = Object.entries(flags?.flags ?? {});
  if (flags?.stripe_mode) {
    entries.push([`stripe ${flags.stripe_mode}`, flags.stripe_mode === "live"]);
  }
  const on = entries.filter(([, value]) => value);
  const off = entries.filter(([, value]) => !value);

  return (
    <div className="adm-flag-groups">
      <div>
        <h4 className="adm-flag-heading">
          <Icon name="check_circle" /> On · {on.length}
        </h4>
        <div className="adm-flag-wrap">
          {on.length === 0 ? (
            <span className="admin-muted">Nothing switched on.</span>
          ) : (
            on.map(([name]) => (
              <Badge key={name} state="ok">
                {name.replace(/_/g, " ")}
              </Badge>
            ))
          )}
        </div>
      </div>
      <div>
        <h4 className="adm-flag-heading">
          <Icon name="do_not_disturb_on" /> Off · {off.length}
        </h4>
        <div className="adm-flag-wrap">
          {off.length === 0 ? (
            <span className="admin-muted">Everything is on.</span>
          ) : (
            off.map(([name]) => (
              <Badge key={name} state="neutral" icon={null}>
                {name.replace(/_/g, " ")}
              </Badge>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
