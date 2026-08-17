import { useCallback, useEffect, useState } from "react";

import { getAdminOpsSummary } from "../../api";

export function AdminOps() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      setData(await getAdminOpsSummary());
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

  const calcom = data.calcom ?? {};
  const notifications = data.notifications ?? {};
  const menuOcr = data.menu_ocr ?? {};
  const payments = data.order_payments ?? {};
  const tablets = data.kds_tablets ?? [];

  return (
    <div className="admin-stack">
      <div className="admin-card-row">
        <section className="onboarding-card admin-card">
          <h3>Cal.com mirror {calcom.enabled ? "" : "(sync off)"}</h3>
          <dl className="admin-dl">
            <dt>Outbox pending</dt>
            <dd>
              {calcom.outbox?.pendingDepth ?? 0}
              {calcom.outbox?.oldestPendingAt
                ? ` · oldest ${new Date(calcom.outbox.oldestPendingAt).toLocaleTimeString()}`
                : ""}
            </dd>
            <dt>Failed (24h)</dt>
            <dd>{calcom.outbox?.failedLast24h ?? 0}</dd>
            <dt>Inbox unprocessed</dt>
            <dd>{calcom.inbox?.unprocessedDepth ?? 0}</dd>
            <dt>Circuit breaker</dt>
            <dd>
              <span
                className={`status-pill ${calcom.circuit_breaker?.state === "closed" ? "confirmed" : "cancelled"}`}
              >
                {calcom.circuit_breaker?.state ?? "closed"}
              </span>
            </dd>
            <dt>Daily quota</dt>
            <dd>
              {calcom.quota?.count ?? 0} / {calcom.quota?.daily_threshold ?? "—"}
            </dd>
          </dl>
        </section>

        <section className="onboarding-card admin-card">
          <h3>Notifications</h3>
          <dl className="admin-dl">
            <dt>Pending</dt>
            <dd>{notifications.pendingDepth ?? 0}</dd>
            <dt>Failed (24h)</dt>
            <dd>{notifications.failedLast24h ?? 0}</dd>
            <dt>Sent (1h)</dt>
            <dd>{notifications.sentLast1h ?? 0}</dd>
          </dl>
          {notifications.byKind?.length ? (
            <ul className="admin-audit">
              {notifications.byKind.map((row) => (
                <li key={`${row.channel}-${row.kind}`}>
                  <span>
                    {row.channel} · {row.kind}
                  </span>
                  <span className="admin-audit-action">
                    {row.pending} pending{row.failed_24h ? ` · ${row.failed_24h} failed` : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="admin-muted">Queue is clear.</p>
          )}
        </section>

        <section className="onboarding-card admin-card">
          <h3>Guest payments at risk</h3>
          <dl className="admin-dl">
            <dt>Stuck past expiry</dt>
            <dd>{payments.stuck ?? 0}</dd>
            <dt>Disputes (24h)</dt>
            <dd>{payments.disputes_24h ?? 0}</dd>
            <dt>Paid but unsettled (24h)</dt>
            <dd>{payments.mismatches_24h ?? 0}</dd>
          </dl>
          <p className="admin-muted">
            Disputes debit the BitePerk platform account — respond in the Stripe dashboard.
          </p>
        </section>
      </div>

      <section className="onboarding-card admin-card">
        <h3>Menu imports</h3>
        <dl className="admin-dl admin-dl-inline">
          {Object.entries(menuOcr.byStatus ?? {}).map(([status, n]) => (
            <span key={status} className="admin-flag">
              {status}: {n}
            </span>
          ))}
          {menuOcr.stuckProcessing ? (
            <span className="admin-flag is-warn">stuck &gt;30 min: {menuOcr.stuckProcessing}</span>
          ) : null}
          {menuOcr.parsedNeverCommitted ? (
            <span className="admin-flag is-warn">
              parsed, never committed: {menuOcr.parsedNeverCommitted}
            </span>
          ) : null}
        </dl>
        {menuOcr.recentFailures?.length ? (
          <div className="booking-table-wrap">
            <table className="booking-table">
              <thead>
                <tr>
                  <th>Venue</th>
                  <th>Attempts</th>
                  <th>Error</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {menuOcr.recentFailures.map((f) => (
                  <tr key={f.id}>
                    <td>{f.restaurant_name ?? f.restaurant_id}</td>
                    <td>{f.attempts}</td>
                    <td className="admin-error-cell">{f.last_error ?? "—"}</td>
                    <td>{new Date(f.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="admin-muted">No failures in the last 7 days.</p>
        )}
      </section>

      <section className="onboarding-card admin-card">
        <h3>Kitchen tablets</h3>
        {tablets.length === 0 ? (
          <p className="admin-muted">No tablet heartbeats recorded.</p>
        ) : (
          <ul className="admin-audit">
            {tablets.map((t) => {
              const last = t.last_seen_at ? new Date(t.last_seen_at) : null;
              const silentMinutes = last ? Math.round((Date.now() - last.getTime()) / 60000) : null;
              return (
                <li key={t.key}>
                  <span>{t.key.replace("kds-heartbeat:", "")}</span>
                  <span className={`admin-audit-action ${silentMinutes > 5 ? "admin-warning" : ""}`}>
                    {last ? `${silentMinutes} min ago` : "never"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
