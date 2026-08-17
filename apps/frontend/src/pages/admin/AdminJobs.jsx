import { useCallback, useEffect, useState } from "react";

import { adminReenqueueJob, getAdminProvisioningJobs, getAdminProvisioningQueue } from "../../api";

export function AdminJobs() {
  const [queue, setQueue] = useState(null);
  const [jobs, setJobs] = useState(null);
  const [workerEnabled, setWorkerEnabled] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [reenqueueTarget, setReenqueueTarget] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const [q, j] = await Promise.all([getAdminProvisioningQueue(), getAdminProvisioningJobs()]);
      setQueue(q.restaurants ?? []);
      setJobs(j.jobs ?? []);
      setWorkerEnabled(Boolean(j.worker_enabled));
      setError(null);
    } catch (e) {
      setError(e.message ?? "Failed to load");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="admin-stack">
      {error ? <div className="menu-error" role="alert">{error}</div> : null}
      {notice ? (
        <div className="menu-error admin-notice" role="status">
          {notice}
        </div>
      ) : null}

      <section className="onboarding-card admin-card">
        <h3>Waiting for a phone line</h3>
        <p className="admin-muted">
          Venues at the provisioning step. Bind their number and agent from the Venues tab —
          the wizard shows “Provisioning in progress” until both are set.
        </p>
        {!queue ? <p className="admin-muted">Loading…</p> : null}
        {queue && queue.length === 0 ? <p className="admin-muted">Queue is empty.</p> : null}
        {queue && queue.length > 0 ? (
          <div className="booking-table-wrap">
            <table className="booking-table">
              <thead>
                <tr>
                  <th>Venue</th>
                  <th>Contact</th>
                  <th>Twilio number</th>
                  <th>Retell agent</th>
                  <th>Waiting since</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((r) => (
                  <tr key={r.id}>
                    <td>{r.name}</td>
                    <td>{r.contact_email ?? "—"}</td>
                    <td>{r.twilio_phone_number ?? "—"}</td>
                    <td>{r.retell_agent_id ?? "—"}</td>
                    <td>{new Date(r.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="onboarding-card admin-card">
        <h3>Provisioning jobs</h3>
        {!workerEnabled ? (
          <p className="admin-warning" role="alert">
            Auto-provisioning is switched off — re-enqueued jobs will not run until it's switched
            on. (Jobs only exist once automatic provisioning is in use.)
          </p>
        ) : null}
        {!jobs ? <p className="admin-muted">Loading…</p> : null}
        {jobs && jobs.length === 0 ? (
          <p className="admin-muted">No jobs — all provisioning has been manual so far.</p>
        ) : null}
        {jobs && jobs.length > 0 ? (
          <div className="booking-table-wrap">
            <table className="booking-table">
              <thead>
                <tr>
                  <th>Venue</th>
                  <th>Status</th>
                  <th>Step</th>
                  <th>Attempts</th>
                  <th>Last error</th>
                  <th>Updated</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td>{job.restaurant_name ?? job.restaurant_id}</td>
                    <td>
                      <span className={`status-pill ${job.status === "failed" ? "cancelled" : job.status === "done" ? "confirmed" : ""}`}>
                        {job.status}
                      </span>
                    </td>
                    <td>{job.step.replace(/_/g, " ")}</td>
                    <td>{job.attempts}</td>
                    <td className="admin-error-cell">{job.last_error ?? "—"}</td>
                    <td>{new Date(job.updated_at).toLocaleString()}</td>
                    <td>
                      {job.status === "failed" ? (
                        <button className="ghost-button" type="button" onClick={() => setReenqueueTarget(job)}>
                          Re-enqueue…
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {reenqueueTarget ? (
        <ReenqueueModal
          job={reenqueueTarget}
          onClose={() => setReenqueueTarget(null)}
          onDone={(message) => {
            setReenqueueTarget(null);
            setNotice(message);
            refresh();
          }}
          onError={(message) => setError(message)}
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
          : "Job re-enqueued — the worker will pick it up on its next tick."
      );
    } catch (e) {
      onError(e.message ?? "Re-enqueue failed");
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Re-enqueue job">
      <div className="modal-card">
        <h3 className="modal-title">Re-enqueue this job?</h3>
        <p className="modal-description">
          The failed job is reset in place — its progress (numbers already bought, agents already
          created) is kept, so nothing is purchased twice.
        </p>
        {hasBuyMarker ? (
          <>
            <p className="admin-warning" role="alert">
              This job died inside a number purchase. Until the marker is cleared it will fail
              again immediately — that's deliberate, so an interrupted purchase can't silently buy
              a second number.
            </p>
            <label className="admin-check">
              <input
                type="checkbox"
                checked={clearMarker}
                onChange={(e) => setClearMarker(e.target.checked)}
              />
              <span>
                I checked the Twilio console for an unassigned AU number — clear the purchase
                marker and retry the buy step.
              </span>
            </label>
          </>
        ) : null}
        <div className="modal-actions">
          <button className="modal-button ghost" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" type="button" disabled={busy} onClick={submit}>
            Re-enqueue
          </button>
        </div>
      </div>
    </div>
  );
}
