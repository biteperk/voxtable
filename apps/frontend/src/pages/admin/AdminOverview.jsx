import { useCallback, useEffect, useState } from "react";

import { getAdminActions, getAdminActivity, getAdminOnboardingHealth, getAdminOpsSummary } from "../../api";

const FUNNEL_ORDER = [
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

export function AdminOverview({ flags }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const [activity, health, ops, actions] = await Promise.all([
        getAdminActivity(),
        getAdminOnboardingHealth(),
        getAdminOpsSummary(),
        getAdminActions(15)
      ]);
      setData({ activity, health, ops, actions: actions.actions ?? [] });
      setError(null);
    } catch (e) {
      setError(e.message ?? "Failed to load");
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(() => {
      if (!document.hidden) refresh();
    }, 30000);
    return () => clearInterval(timer);
  }, [refresh]);

  if (error) return <div className="menu-error" role="alert">{error}</div>;
  if (!data) return <p className="admin-muted">Loading…</p>;

  const funnel = data.health?.funnel ?? {};
  const openLatches = Object.entries(data.ops?.alert_latches ?? {}).filter(
    ([key, value]) => value === true && LATCH_LABELS[key]
  );
  const venues = data.activity?.venues ?? [];

  return (
    <div className="admin-stack">
      {openLatches.length > 0 ? (
        <section className="onboarding-card admin-card admin-incidents" aria-label="Open alerts">
          <h3>Open alerts</h3>
          <ul>
            {openLatches.map(([key]) => (
              <li key={key}>
                <span className="status-pill cancelled">{LATCH_LABELS[key]}</span>
              </li>
            ))}
          </ul>
          <p className="admin-muted">These are latched open in Slack right now — details in the Ops tab.</p>
        </section>
      ) : (
        <section className="onboarding-card admin-card" aria-label="Open alerts">
          <h3>All quiet</h3>
          <p className="admin-muted">No alerts are latched open.</p>
        </section>
      )}

      <section className="admin-card-row">
        <div className="onboarding-card admin-card admin-stat">
          <span className="admin-stat-number">{data.activity?.totals?.calls_today ?? 0}</span>
          <span className="admin-muted">calls today</span>
        </div>
        <div className="onboarding-card admin-card admin-stat">
          <span className="admin-stat-number">{data.activity?.totals?.bookings_today ?? 0}</span>
          <span className="admin-muted">bookings today</span>
        </div>
        <div className="onboarding-card admin-card admin-stat">
          <span className="admin-stat-number">{data.health?.menu_ocr_today?.jobs ?? 0}</span>
          <span className="admin-muted">menu imports today</span>
        </div>
      </section>

      <section className="onboarding-card admin-card">
        <h3>Onboarding funnel</h3>
        <div className="admin-funnel">
          {FUNNEL_ORDER.map((status) => (
            <div key={status} className="admin-funnel-step">
              <span className="admin-stat-number">{funnel[status] ?? 0}</span>
              <span className="admin-muted">{status.replace(/_/g, " ")}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="onboarding-card admin-card">
        <h3>Venue activity today</h3>
        {venues.length === 0 ? (
          <p className="admin-muted">No calls or bookings yet today.</p>
        ) : (
          <div className="booking-table-wrap">
            <table className="booking-table">
              <thead>
                <tr>
                  <th>Venue</th>
                  <th>Calls</th>
                  <th>Bookings</th>
                  <th>Voice minutes</th>
                </tr>
              </thead>
              <tbody>
                {venues.map((v) => (
                  <tr key={v.restaurant_id}>
                    <td>{v.name ?? v.restaurant_id}</td>
                    <td>{v.calls_today}</td>
                    <td>{v.bookings_today}</td>
                    <td>{Math.ceil((v.duration_seconds_today ?? 0) / 60)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="onboarding-card admin-card">
        <h3>What's switched on</h3>
        <div className="admin-flags">
          {Object.entries(flags?.flags ?? {}).map(([name, on]) => (
            <span key={name} className={`admin-flag ${on ? "is-on" : ""}`}>
              {name.replace(/_/g, " ")}
            </span>
          ))}
          {flags?.stripe_mode ? (
            <span className={`admin-flag ${flags.stripe_mode === "live" ? "is-on" : ""}`}>
              stripe {flags.stripe_mode}
            </span>
          ) : null}
        </div>
      </section>

      <section className="onboarding-card admin-card">
        <h3>Recent admin actions</h3>
        {data.actions.length === 0 ? (
          <p className="admin-muted">Nothing yet — mutations from this console will appear here.</p>
        ) : (
          <ul className="admin-audit">
            {data.actions.map((a) => (
              <li key={a.id}>
                <span>{a.actor_email ?? a.actor_uid}</span>
                <span className="admin-audit-action">{a.action.replace(/_/g, " ")}</span>
                <span className="admin-muted">{new Date(a.created_at).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
