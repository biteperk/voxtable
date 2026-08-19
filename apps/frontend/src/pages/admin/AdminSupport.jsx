import { useCallback, useEffect, useState } from "react";

import { adminSetSupportStatus, getAdminSupportRequests } from "../../api";

const STATUS_FLOW = {
  open: ["in_progress", "resolved", "closed"],
  in_progress: ["resolved", "closed", "open"],
  resolved: ["closed", "open"],
  closed: ["open"]
};

export function AdminSupport() {
  const [statusFilter, setStatusFilter] = useState("");
  const [requests, setRequests] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const result = await getAdminSupportRequests(statusFilter || undefined);
      setRequests(result.support_requests ?? []);
      setError(null);
    } catch (e) {
      setError(e.message ?? "Failed to load");
    }
  }, [statusFilter]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const move = async (id, status) => {
    setBusyId(id);
    try {
      await adminSetSupportStatus(id, status);
      await refresh();
    } catch (e) {
      setError(e.message ?? "Couldn't update the request");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="admin-stack">
      <div className="admin-toolbar">
        <select
          className="admin-input"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label="Filter by status"
        >
          <option value="">All requests</option>
          <option value="open">Open</option>
          <option value="in_progress">In progress</option>
          <option value="resolved">Resolved</option>
          <option value="closed">Closed</option>
        </select>
      </div>

      {error ? <div className="menu-error" role="alert">{error}</div> : null}
      {!requests ? <p className="admin-muted">Loading…</p> : null}
      {requests && requests.length === 0 ? (
        <p className="admin-muted">No support requests{statusFilter ? " in this state" : ""}.</p>
      ) : null}

      {requests?.map((r) => (
        <section key={r.id} className="onboarding-card admin-card admin-support-card">
          <div className="admin-support-head">
            <strong>{r.subject}</strong>
            <span className={`status-pill ${r.status === "open" ? "cancelled" : r.status === "resolved" || r.status === "closed" ? "confirmed" : ""}`}>
              {r.status.replace(/_/g, " ")}
            </span>
            <span className="admin-flag">{r.category}</span>
          </div>
          <p className="admin-muted">
            {r.restaurant_name ?? "unknown venue"} · {r.user_email ?? "no email"} ·{" "}
            {new Date(r.created_at).toLocaleString()}
            {r.resolved_at ? ` · resolved ${new Date(r.resolved_at).toLocaleDateString()}` : ""}
          </p>
          <p className="admin-support-message">{r.message}</p>
          <div className="admin-panel-actions">
            {(STATUS_FLOW[r.status] ?? []).map((next) => (
              <button
                key={next}
                className="ghost-button"
                type="button"
                disabled={busyId === r.id}
                onClick={() => move(r.id, next)}
              >
                {next === "in_progress" ? "Start" : next === "open" ? "Reopen" : next === "resolved" ? "Resolve" : "Close"}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
