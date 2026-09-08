import { useState } from "react";

import { adminReenqueueJob, getAdminProvisioningJobs, getAdminProvisioningQueue } from "../../api";
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
import { nextAction, pipelineFor, waitingHours } from "../../lib/provisioningPipeline";

export function AdminJobs({ goVenues }) {
  const [reenqueueTarget, setReenqueueTarget] = useState(null);
  const toast = useToast();

  const { data, error, lastUpdatedAt, refreshing, announcement, refresh } = useAdminData(
    async () => {
      const [q, j] = await Promise.all([getAdminProvisioningQueue(), getAdminProvisioningJobs()]);
      return {
        queue: q.restaurants ?? [],
        jobs: j.jobs ?? [],
        // Not defaulted true: assuming auto-provisioning is on and correcting a
        // moment later flashed the warning in after first paint, which reads as
        // a glitch. Undefined until known, and it renders nothing.
        workerEnabled: Boolean(j.worker_enabled)
      };
    }
  );

  const queue = data?.queue ?? null;
  const jobs = data?.jobs ?? null;
  const workerEnabled = data ? data.workerEnabled : null;

  const failed = (jobs ?? []).filter((j) => j.status === "failed");
  const oldestWait = (queue ?? []).reduce(
    (max, r) => Math.max(max, waitingHours(r.created_at) ?? 0),
    0
  );

  return (
    <div className="admin-stack">
      <section className="adm-stat-grid" aria-label="Provisioning at a glance">
        <StatTile
          label="Waiting for a line"
          value={queue?.length ?? "—"}
          note="venues that have paid"
          icon="hourglass_top"
          state={(queue?.length ?? 0) > 0 ? "warn" : "default"}
        />
        <StatTile
          label="Longest wait"
          value={queue?.length ? `${oldestWait}h` : "—"}
          note="since the venue reached provisioning"
          icon="schedule"
          state={oldestWait >= 4 ? "warn" : "default"}
        />
        <StatTile
          label="Failed jobs"
          value={failed.length}
          note="automatic provisioning"
          icon="error"
          state={failed.length ? "danger" : "default"}
        />
      </section>

      {error ? (
        shouldBlockPage({ data, error }) ? (
          <SectionCard title="Couldn't load this tab" tone="danger" icon="error">
            <p className="admin-muted">{error}</p>
            <AdminAction onAct={refresh} icon="refresh" busy={refreshing} busyLabel="Retrying…">
              Try again
            </AdminAction>
          </SectionCard>
        ) : (
          <div className="adm-stale-notice" role="status">
            <Icon name="cloud_off" />
            <span>
              Couldn&apos;t refresh — showing the last good data from{" "}
              {lastUpdatedAt ? relativeTime(new Date(lastUpdatedAt)).toLowerCase() : "earlier"}. {error}
            </span>
          </div>
        )
      ) : null}

      {workerEnabled === false ? (
        <SectionCard
          title="Automatic provisioning is switched off"
          icon="toggle_off"
          badge={<Badge state="info">Manual</Badge>}
        >
          <p className="admin-muted">
            Every venue below is bound by hand, and a re-enqueued job will sit until the flag is
            on. It is <code>PROVISIONING_AUTO_ENABLED</code>, set per environment in the
            Terraform env map — not something this console can change.
          </p>
        </SectionCard>
      ) : null}

      <SectionCard
        title="Waiting for a phone line"
        icon="hourglass_top"
        subtitle="A venue here has paid and cannot take a call yet. The highlighted step is what it is waiting on."
        actions={
          <RefreshControl
            lastUpdatedAt={lastUpdatedAt}
            refreshing={refreshing}
            announcement={announcement}
            onRefresh={refresh}
          />
        }
      >
        {!queue ? (
          <SkeletonLines lines={4} label="Loading the provisioning queue" />
        ) : queue.length === 0 ? (
          <EmptyState icon="task_alt" title="Nobody is waiting">
            Every venue that has paid has a phone line bound.
          </EmptyState>
        ) : (
          <ul className="adm-pipeline-list">
            {queue.map((venue) => (
              <li key={venue.id} className="adm-pipeline-row">
                <div className="adm-pipeline-head">
                  <div>
                    <strong>{venue.name}</strong>
                    <span className="admin-muted">
                      {" "}
                      · {venue.contact_email ?? "no contact email"}
                    </span>
                  </div>
                  <div className="adm-card-actions">
                    <Badge state={(waitingHours(venue.created_at) ?? 0) >= 4 ? "warn" : "neutral"} icon="schedule">
                      waiting {waitingHours(venue.created_at) ?? 0}h
                    </Badge>
                    {/* The action is here, rather than "go to the Venues tab". */}
                    <AdminAction
                      icon="open_in_new"
                      blocked={goVenues ? null : "Open the Venues tab to bind this venue."}
                      onAct={() => goVenues?.(null, venue.id)}
                    >
                      Bind now
                    </AdminAction>
                  </div>
                </div>

                <ol className="adm-rail">
                  {pipelineFor(venue).map((step) => (
                    <li key={step.key} className={`adm-rail-step is-${step.state}`}>
                      <Icon
                        name={
                          step.state === "done"
                            ? "check_circle"
                            : step.state === "pending"
                              ? "radio_button_checked"
                              : "radio_button_unchecked"
                        }
                      />
                      <span>{step.label}</span>
                    </li>
                  ))}
                </ol>

                <p className="admin-muted">Next: {nextAction(venue) ?? "nothing — this venue is live."}</p>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="Provisioning jobs"
        icon="pending_actions"
        subtitle="Only automatic provisioning creates these — a hand-bound venue has no job."
      >
        {!jobs ? (
          <SkeletonLines lines={3} label="Loading provisioning jobs" />
        ) : (
          <DataTable
            caption="Automatic provisioning jobs, newest first"
            rows={jobs}
            rowKey={(row) => row.id}
            initialSort={{ key: "updated_at", direction: "descending" }}
            columns={[
              {
                key: "restaurant_name",
                label: "Venue",
                sortable: true,
                render: (row) => row.restaurant_name ?? row.restaurant_id
              },
              {
                key: "status",
                label: "Status",
                sortable: true,
                render: (row) => (
                  <Badge
                    state={row.status === "failed" ? "danger" : row.status === "done" ? "ok" : "info"}
                  >
                    {row.status}
                  </Badge>
                )
              },
              { key: "step", label: "Step", sortable: true, render: (row) => row.step.replace(/_/g, " ") },
              { key: "attempts", label: "Tries", sortable: true, align: "right" },
              {
                key: "last_error",
                label: "Last error",
                render: (row) => <span className="adm-error-text">{row.last_error ?? "—"}</span>
              },
              {
                key: "updated_at",
                label: "Updated",
                sortable: true,
                render: (row) => (row.updated_at ? relativeTime(new Date(row.updated_at)) : "—")
              },
              {
                key: "act",
                label: "",
                render: (row) => (
                  <AdminAction
                    icon="replay"
                    blocked={
                      row.status === "failed" ? null : `A ${row.status} job has nothing to re-enqueue.`
                    }
                    onAct={() => setReenqueueTarget(row)}
                  >
                    Re-enqueue…
                  </AdminAction>
                )
              }
            ]}
            empty={
              <EmptyState icon="pending_actions" title="No jobs yet">
                Every venue so far has been provisioned by hand, so nothing has queued.
              </EmptyState>
            }
          />
        )}
      </SectionCard>

      {reenqueueTarget ? (
        <ReenqueueModal
          job={reenqueueTarget}
          onClose={() => setReenqueueTarget(null)}
          onDone={(message) => {
            setReenqueueTarget(null);
            toast.success(message);
            refresh();
          }}
          onError={(message) => {
            setReenqueueTarget(null);
            toast.error(message);
          }}
        />
      ) : null}
    </div>
  );
}

function ReenqueueModal({ job, onClose, onDone, onError }) {
  const [clearMarker, setClearMarker] = useState(false);
  const [busy, setBusy] = useState(false);
  const hasBuyMarker = Boolean(job.payload?.buy_started_at);

  const submit = async () => {
    setBusy(true);
    try {
      const result = await adminReenqueueJob(job.id, { clear_buy_marker: clearMarker });
      onDone(
        result.warnings?.length
          ? `Job re-enqueued. ${result.warnings.join(" ")}`
          : "Job re-enqueued — the worker picks it up on its next tick."
      );
    } catch (e) {
      onError(e.message ?? "That re-enqueue didn't go through.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="adm-modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="adm-modal" role="dialog" aria-modal="true" aria-labelledby="reenqueue-title">
        <header className="adm-modal-head">
          <h3 id="reenqueue-title">
            <Icon name="replay" /> Re-enqueue this job?
          </h3>
          <button type="button" className="ghost-button" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <p className="admin-muted">
          The failed job is reset in place, so its progress — numbers already bought, agents
          already created — is kept and nothing is purchased twice.
        </p>
        {hasBuyMarker ? (
          <>
            <p className="adm-modal-consequence">
              This job died inside a number purchase. Until the marker is cleared it fails again
              immediately — deliberately, so an interrupted purchase cannot quietly buy a second
              number.
            </p>
            <label className="adm-check">
              <input
                type="checkbox"
                checked={clearMarker}
                onChange={(e) => setClearMarker(e.target.checked)}
              />
              <span className="adm-check-label">
                I checked the Twilio console for an unassigned AU number — clear the purchase
                marker and retry the buy step.
              </span>
            </label>
          </>
        ) : null}
        <footer className="adm-modal-actions">
          <AdminAction onAct={onClose}>Cancel</AdminAction>
          <AdminAction tone="primary" icon="replay" busy={busy} onAct={submit} busyLabel="Re-enqueuing…">
            Re-enqueue
          </AdminAction>
        </footer>
      </div>
    </div>
  );
}
