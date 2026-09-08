import { useState } from "react";

import {
  adminDiscardNotification,
  adminRerunMenuImport,
  adminRetryNotification,
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

const STRIPE_DISPUTES_URL = "https://dashboard.stripe.com/disputes";

// A panel says OK / Warning / Failing. Bare numbers made the reader work out
// whether "3" was fine, and an absent value read as healthy.
function health(state) {
  if (state === "unknown") return <Badge state="neutral">Unknown</Badge>;
  if (state === "failing") return <Badge state="danger">Failing</Badge>;
  if (state === "warn") return <Badge state="warn">Warning</Badge>;
  return <Badge state="ok">OK</Badge>;
}

function Row({ label, children }) {
  return (
    <div className="adm-kv">
      <span className="adm-kv-label">{label}</span>
      <span className="adm-kv-value">{children}</span>
    </div>
  );
}

export function AdminOps({ flags }) {
  const [busy, setBusy] = useState(null);
  const toast = useToast();

  const { data, error, lastUpdatedAt, refreshing, announcement, refresh } = useAdminData(
    () => getAdminOpsSummary(),
    { intervalMs: 30000 }
  );

  if (shouldBlockPage({ data, error })) {
    return (
      <div className="admin-stack">
        <SectionCard title="Couldn't load platform health" tone="danger" icon="error">
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
        <SectionCard title="Platform health">
          <SkeletonLines lines={5} label="Loading platform health" />
        </SectionCard>
      </div>
    );
  }

  const calcom = data.calcom ?? {};
  const notifications = data.notifications ?? {};
  const failedNotifications = data.failed_notifications ?? [];
  const menuOcr = data.menu_ocr ?? {};
  const payments = data.order_payments ?? {};
  const tablets = data.kds_tablets ?? [];

  // A missing breaker state is UNKNOWN, not closed. It used to render through
  // the same green pill as "closed", so an absent value looked healthy.
  const rawBreaker = calcom.circuit_breaker?.state;
  const breakerState = rawBreaker ? String(rawBreaker) : null;
  const breakerHealth = !breakerState ? "unknown" : breakerState === "closed" ? "ok" : "failing";

  const calcomHealth = !calcom.enabled
    ? "unknown"
    : breakerHealth === "failing" ||
        (calcom.outbox?.failedLast24h ?? 0) > 0 ||
        (calcom.inbox?.unprocessedDepth ?? 0) > 0
      ? "failing"
      : (calcom.outbox?.pendingDepth ?? 0) > 20
        ? "warn"
        : "ok";

  const notifHealth = failedNotifications.length
    ? "failing"
    : (notifications.pendingDepth ?? 0) > 20
      ? "warn"
      : "ok";

  const paymentsRisk =
    (payments.disputes_24h ?? 0) > 0
      ? "failing"
      : (payments.stuck ?? 0) > 0 || (payments.mismatches_24h ?? 0) > 0
        ? "warn"
        : "ok";

  const menuHealth =
    (menuOcr.recentFailures?.length ?? 0) > 0 || (menuOcr.stuckProcessing ?? 0) > 0
      ? "warn"
      : "ok";

  const retryNotification = async (id) => {
    setBusy(`notif-${id}`);
    try {
      await adminRetryNotification(id);
      toast.success("Queued again — the worker picks it up within a few minutes.");
      await refresh();
    } catch (e) {
      toast.error(e.message ?? "That retry didn't go through.");
    } finally {
      setBusy(null);
    }
  };

  // Retrying an email with no provider configured is theatre — the row would
  // be claimed by nothing and sit pending. The button says so instead.
  const emailOff = flags?.flags?.notifications_email === false;
  const retryBlocked = (row) =>
    row.channel === "email" && emailOff
      ? "Email is switched off in this environment, so a retry would sit unsent. Discard it instead."
      : null;

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

  const rerunImport = async (id) => {
    setBusy(`import-${id}`);
    try {
      await adminRerunMenuImport(id);
      toast.success("Import re-queued. Each run is a paid vision call, so watch this one.");
      await refresh();
    } catch (e) {
      toast.error(e.message ?? "That re-run didn't go through.");
    } finally {
      setBusy(null);
    }
  };

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
      <section className="adm-stat-grid" aria-label="Platform health at a glance">
        <StatTile
          label="Cal.com mirror"
          value={calcom.enabled ? (calcom.outbox?.pendingDepth ?? 0) : "off"}
          note={calcom.enabled ? "bookings waiting to mirror" : "sync switched off"}
          icon="sync"
          state={calcomHealth === "failing" ? "danger" : calcomHealth === "warn" ? "warn" : "default"}
        />
        <StatTile
          label="Messages failed"
          value={failedNotifications.length}
          note="emails and texts needing a retry"
          icon="mark_email_unread"
          state={failedNotifications.length ? "danger" : "default"}
        />
        <StatTile
          label="Guest payments at risk"
          value={(payments.stuck ?? 0) + (payments.disputes_24h ?? 0) + (payments.mismatches_24h ?? 0)}
          note="stuck, disputed or unsettled"
          icon="credit_card"
          state={paymentsRisk === "failing" ? "danger" : paymentsRisk === "warn" ? "warn" : "default"}
        />
        <StatTile
          label="Menu imports failing"
          value={menuOcr.recentFailures?.length ?? 0}
          note="in the last 7 days"
          icon="restaurant_menu"
          state={menuHealth === "warn" ? "warn" : "default"}
        />
      </section>

      <SectionCard
        title="Cal.com mirror"
        subtitle={
          calcom.enabled
            ? "Bookings are mirrored asynchronously; the voice path never waits on Cal.com."
            : "Sync is switched off in this environment, so these numbers are historical."
        }
        icon="sync"
        badge={health(calcomHealth)}
        actions={
          <RefreshControl
            lastUpdatedAt={lastUpdatedAt}
            refreshing={refreshing}
            announcement={announcement}
            onRefresh={refresh}
          />
        }
      >
        <div className="adm-kv-grid">
          <Row label="Outbox pending">
            {calcom.outbox?.pendingDepth ?? 0}
            {calcom.outbox?.oldestPendingAt
              ? ` · oldest ${relativeTime(new Date(calcom.outbox.oldestPendingAt))}`
              : ""}
          </Row>
          <Row label="Failed (24h)">{calcom.outbox?.failedLast24h ?? 0}</Row>
          <Row label="Inbox unprocessed">{calcom.inbox?.unprocessedDepth ?? 0}</Row>
          <Row label="Circuit breaker">
            {health(breakerHealth)}
            {breakerState ? <span className="admin-muted"> {breakerState}</span> : null}
          </Row>
          <Row label="Daily quota">
            {calcom.quota?.count ?? 0} / {calcom.quota?.daily_threshold ?? "—"}
          </Row>
        </div>
        {breakerState ? null : (
          <p className="admin-muted">
            No breaker state has been mirrored yet. The breaker itself lives in the worker
            process, so this reads Unknown until the worker records a tick — it does not mean
            the breaker is closed.
          </p>
        )}
      </SectionCard>

      <SectionCard
        title="Messages"
        subtitle="Emails and texts to venues and guests. A failed row can be put back in the queue."
        icon="mail"
        badge={health(notifHealth)}
      >
        <div className="adm-kv-grid">
          <Row label="Pending">{notifications.pendingDepth ?? 0}</Row>
          <Row label="Failed (24h)">{notifications.failedLast24h ?? 0}</Row>
          <Row label="Sent (1h)">{notifications.sentLast1h ?? 0}</Row>
        </div>

        <DataTable
          caption="Failed messages, newest first"
          rows={failedNotifications}
          rowKey={(row) => row.id}
          columns={[
            {
              key: "kind",
              label: "Message",
              sortable: true,
              render: (row) => `${row.channel} · ${row.kind.replace(/_/g, " ")}`
            },
            { key: "recipient", label: "To", sortable: true },
            { key: "attempts", label: "Tries", sortable: true, align: "right" },
            {
              key: "last_error",
              label: "Why it failed",
              render: (row) => <span className="adm-error-text">{row.last_error ?? "—"}</span>
            },
            {
              key: "created_at",
              label: "Age",
              sortable: true,
              render: (row) => (row.created_at ? relativeTime(new Date(row.created_at)) : "—")
            },
            {
              key: "act",
              label: "",
              render: (row) => (
                <div className="adm-row-actions">
                  <AdminAction
                    onAct={() => retryNotification(row.id)}
                    busy={busy === `notif-${row.id}`}
                    blocked={retryBlocked(row)}
                    icon="replay"
                  >
                    Retry
                  </AdminAction>
                  <AdminAction
                    onAct={() => discardNotification(row.id)}
                    busy={busy === `discard-${row.id}`}
                    tone="danger"
                    icon="delete"
                    busyLabel="Discarding…"
                  >
                    Discard
                  </AdminAction>
                </div>
              )
            }
          ]}
          empty={
            <EmptyState icon="mark_email_read" title="Nothing has failed">
              Every queued email and text has either sent or is still waiting its turn.
            </EmptyState>
          }
        />
      </SectionCard>

      <SectionCard
        title="Guest payments"
        subtitle="Payment links texted to callers for voice orders."
        icon="credit_card"
        badge={health(paymentsRisk)}
        actions={
          payments.disputes_24h ? (
            <a className="ghost-button" href={STRIPE_DISPUTES_URL} target="_blank" rel="noreferrer">
              Respond in Stripe
            </a>
          ) : null
        }
      >
        <div className="adm-kv-grid">
          <Row label="Stuck past expiry">{payments.stuck ?? 0}</Row>
          <Row label="Disputes (24h)">{payments.disputes_24h ?? 0}</Row>
          <Row label="Paid but unsettled (24h)">{payments.mismatches_24h ?? 0}</Row>
        </div>
        {payments.disputes_24h ? (
          <p className="admin-muted">
            A dispute debits the BitePerk platform account, so it needs a response in Stripe
            before the deadline.
          </p>
        ) : null}
      </SectionCard>

      <SectionCard
        title="Menu imports"
        subtitle="Photo and PDF menus read by the vision model during onboarding."
        icon="restaurant_menu"
        badge={health(menuHealth)}
      >
        <div className="adm-flag-wrap">
          {Object.entries(menuOcr.byStatus ?? {}).map(([status, n]) => (
            <Badge key={status} state="neutral" icon={null}>
              {status}: {n}
            </Badge>
          ))}
          {menuOcr.stuckProcessing ? (
            <Badge state="warn">stuck &gt; 30 min: {menuOcr.stuckProcessing}</Badge>
          ) : null}
          {menuOcr.parsedNeverCommitted ? (
            <Badge state="warn">parsed, never committed: {menuOcr.parsedNeverCommitted}</Badge>
          ) : null}
        </div>

        <DataTable
          caption="Failed imports in the last 7 days"
          rows={menuOcr.recentFailures ?? []}
          rowKey={(row) => row.id}
          columns={[
            {
              key: "restaurant_name",
              label: "Venue",
              sortable: true,
              render: (row) => row.restaurant_name ?? row.restaurant_id
            },
            { key: "attempts", label: "Tries", sortable: true, align: "right" },
            {
              key: "last_error",
              label: "Why it failed",
              render: (row) => <span className="adm-error-text">{row.last_error ?? "—"}</span>
            },
            {
              key: "created_at",
              label: "Age",
              sortable: true,
              render: (row) => (row.created_at ? relativeTime(new Date(row.created_at)) : "—")
            },
            {
              key: "act",
              label: "",
              render: (row) => (
                <AdminAction
                  onAct={() => rerunImport(row.id)}
                  busy={busy === `import-${row.id}`}
                  icon="replay"
                >
                  Re-run
                </AdminAction>
              )
            }
          ]}
          empty={
            <EmptyState icon="task_alt" title="No failed imports">
              Nothing has failed in the last seven days.
            </EmptyState>
          }
        />
        <p className="admin-muted">
          Each re-run is a paid vision call and bypasses the daily cap, so it is limited to three
          per import and recorded in the audit log.
        </p>
      </SectionCard>

      <SectionCard
        title="Kitchen tablets"
        subtitle="A tablet that stops sending a heartbeat has stopped showing orders."
        icon="tablet"
      >
        {tablets.length === 0 ? (
          <EmptyState icon="tablet" title="No tablets have checked in">
            No kitchen display has ever sent a heartbeat in this environment.
          </EmptyState>
        ) : (
          <ul className="adm-audit-list">
            {tablets.map((t) => {
              const last = t.last_seen_at ? new Date(t.last_seen_at) : null;
              const silentMinutes = last ? Math.round((Date.now() - last.getTime()) / 60000) : null;
              // A tablet that has NEVER checked in is the worst case, not a
              // neutral one — `null > 5` is false, so it used to show plain.
              const stale = silentMinutes === null || silentMinutes > 5;
              return (
                <li key={t.key}>
                  <span className="adm-audit-what">{t.key.replace("kds-heartbeat:", "")}</span>
                  {stale ? (
                    <Badge state="warn">{last ? `silent ${silentMinutes} min` : "never seen"}</Badge>
                  ) : (
                    <Badge state="ok">{`seen ${silentMinutes} min ago`}</Badge>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
