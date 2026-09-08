import { useCallback, useEffect, useState } from "react";

import {
  adminReplyToSupportRequest,
  adminSetSupportStatus,
  getAdminSupportRequest,
  getAdminSupportRequests
} from "../../api";
import { AdminAction } from "../../components/admin/AdminAction";
import { RefreshControl } from "../../components/admin/RefreshControl";
import { Badge } from "../../components/admin/Badge";
import { EmptyState } from "../../components/admin/EmptyState";
import { SectionCard } from "../../components/admin/SectionCard";
import { SkeletonLines } from "../../components/admin/Skeleton";
import { useToast } from "../../components/admin/Toast";
import { Icon } from "../../components/Icon";
import { useAdminData } from "../../hooks/useAdminData";
import { relativeTime } from "../../lib/format";

const STATUS_FLOW = {
  open: ["in_progress", "resolved", "closed"],
  in_progress: ["resolved", "closed", "open"],
  resolved: ["closed", "open"],
  closed: ["open"]
};

const STATUS_LABEL = {
  in_progress: "Start",
  open: "Reopen",
  resolved: "Resolve",
  closed: "Close"
};

const STATUS_TONE = {
  open: "warn",
  in_progress: "info",
  resolved: "ok",
  closed: "neutral"
};

export function AdminSupport({ goVenues }) {
  const [statusFilter, setStatusFilter] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const toast = useToast();

  const {
    data: requests,
    error,
    lastUpdatedAt,
    refreshing,
    announcement,
    refresh
  } = useAdminData(() => getAdminSupportRequests(statusFilter || undefined).then((r) => r.support_requests ?? []), {
    deps: [statusFilter]
  });

  // Keep a thread open across a refresh; otherwise resolving a request closes
  // the pane you were reading. Derived from the list rather than written during
  // the fetch, so a stale response cannot move the selection.
  useEffect(() => {
    if (!requests) return;
    setSelectedId((current) =>
      current && requests.some((r) => r.id === current) ? current : (requests[0]?.id ?? null)
    );
  }, [requests]);

  const openCount = (requests ?? []).filter((r) => r.status === "open").length;

  return (
    <div className="admin-stack">
      <SectionCard
        title="Support"
        icon="contact_support"
        badge={
          requests ? (
            openCount ? (
              <Badge state="warn">{openCount} open</Badge>
            ) : (
              <Badge state="ok">Nothing open</Badge>
            )
          ) : null
        }
        subtitle="A venue asked us something. Answering it is a reply, not a status change."
        actions={
          <RefreshControl
            lastUpdatedAt={lastUpdatedAt}
            refreshing={refreshing}
            announcement={announcement}
            onRefresh={refresh}
          />
        }
      >
        <div className="adm-toolbar">
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

        {error ? (
          <div className="adm-stale-notice" role="status">
            <Icon name="cloud_off" />
            <span>Couldn&apos;t refresh the inbox. {error}</span>
          </div>
        ) : null}

        {!requests ? (
          <SkeletonLines lines={4} label="Loading support requests" />
        ) : requests.length === 0 ? (
          <EmptyState icon="mark_email_read" title="Nothing to answer">
            No support requests{statusFilter ? " in this state" : ""}.
          </EmptyState>
        ) : (
          <div className="adm-inbox">
            <ul className="adm-inbox-list" aria-label="Support requests">
              {requests.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    className={`adm-inbox-item${selectedId === r.id ? " is-active" : ""}`}
                    aria-current={selectedId === r.id ? "true" : undefined}
                    onClick={() => setSelectedId(r.id)}
                  >
                    <span className="adm-inbox-subject">{r.subject}</span>
                    <span className="admin-muted">
                      {r.restaurant_name ?? "unknown venue"} · {relativeTime(new Date(r.created_at))}
                    </span>
                    <span className="adm-inbox-meta">
                      <Badge state={STATUS_TONE[r.status]} icon={null}>
                        {r.status.replace(/_/g, " ")}
                      </Badge>
                      {r.reply_count > 0 ? (
                        <span className="admin-muted">
                          <Icon name="forum" /> {r.reply_count}
                        </span>
                      ) : (
                        <span className="admin-muted">no reply yet</span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            {selectedId ? (
              <SupportThread
                key={selectedId}
                requestId={selectedId}
                goVenues={goVenues}
                onChanged={refresh}
                onError={(message) => toast.error(message)}
                onSuccess={(message) => toast.success(message)}
              />
            ) : null}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function SupportThread({ requestId, goVenues, onChanged, onError, onSuccess }) {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState("");
  const [channel, setChannel] = useState("email");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await getAdminSupportRequest(requestId));
    } catch (e) {
      onError(e.message ?? "Couldn't load that request");
    }
    // onError is a fresh closure each render; depending on it would reload the
    // thread on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!data) return <SkeletonLines lines={5} label="Loading this request" />;

  const request = data.support_request;
  const emailEnabled = data.email_enabled;

  const send = async () => {
    setBusy(true);
    try {
      await adminReplyToSupportRequest(requestId, { channel, body: draft.trim() });
      setDraft("");
      await load();
      onChanged();
      onSuccess(
        channel === "email"
          ? "Reply queued — it sends on the worker's next tick."
          : "Note saved for whoever picks this up next."
      );
    } catch (e) {
      onError(e.message ?? "That reply didn't go through.");
    } finally {
      setBusy(false);
    }
  };

  const move = async (status) => {
    setBusy(true);
    try {
      await adminSetSupportStatus(requestId, status);
      await load();
      onChanged();
      onSuccess(`Marked ${status.replace(/_/g, " ")}.`);
    } catch (e) {
      onError(e.message ?? "Couldn't update the request.");
    } finally {
      setBusy(false);
    }
  };

  const replyBlocked =
    draft.trim() === ""
      ? "Write something first."
      : channel === "email" && !request.user_email
        ? "This request has no email address on it, so there is nobody to reply to. Leave an internal note instead."
        : channel === "email" && !emailEnabled
          ? "Email is switched off in this environment, so a reply would sit unsent. Leave an internal note instead."
          : null;

  return (
    <div className="adm-thread">
      <header className="adm-thread-head">
        <div>
          <h4>{request.subject}</h4>
          <p className="admin-muted">
            {request.restaurant_name ?? "unknown venue"} ·{" "}
            {request.user_email ? (
              <a href={`mailto:${request.user_email}?subject=${encodeURIComponent(`Re: ${request.subject}`)}`}>
                {request.user_email}
              </a>
            ) : (
              "no email address"
            )}{" "}
            · {new Date(request.created_at).toLocaleString()}
          </p>
        </div>
        <div className="adm-card-actions">
          <Badge state={STATUS_TONE[request.status]} icon={null}>
            {request.status.replace(/_/g, " ")}
          </Badge>
          <Badge state="neutral" icon={null}>
            {request.category}
          </Badge>
          {request.restaurant_id ? (
            <AdminAction icon="storefront" onAct={() => goVenues?.(null, request.restaurant_id)}>
              Open venue
            </AdminAction>
          ) : null}
        </div>
      </header>

      <ol className="adm-thread-messages">
        <li className="adm-msg is-inbound">
          <span className="adm-msg-who">
            {request.user_email ?? "the venue"} · {relativeTime(new Date(request.created_at))}
          </span>
          <p>{request.message}</p>
        </li>
        {data.replies.map((reply) => (
          <li key={reply.id} className={`adm-msg is-${reply.channel === "internal" ? "note" : "outbound"}`}>
            <span className="adm-msg-who">
              {reply.channel === "internal" ? (
                <Badge state="neutral" icon="lock">
                  internal note
                </Badge>
              ) : (
                <Badge state="ok" icon="send">
                  sent
                </Badge>
              )}
              {reply.author_email ?? reply.author_uid} · {relativeTime(new Date(reply.created_at))}
            </span>
            <p>{reply.body}</p>
          </li>
        ))}
      </ol>

      <div className="adm-composer">
        <div className="adm-composer-tabs" role="group" aria-label="Reply type">
          <button
            type="button"
            className={channel === "email" ? "is-active" : ""}
            aria-pressed={channel === "email"}
            onClick={() => setChannel("email")}
          >
            <Icon name="send" /> Reply to the venue
          </button>
          <button
            type="button"
            className={channel === "internal" ? "is-active" : ""}
            aria-pressed={channel === "internal"}
            onClick={() => setChannel("internal")}
          >
            <Icon name="lock" /> Internal note
          </button>
        </div>
        <label className="admin-field">
          <span>
            {channel === "email"
              ? `Emailed to ${request.user_email ?? "nobody — no address on this request"}`
              : "Never sent. For whoever picks this up next."}
          </span>
          <textarea
            className="admin-input"
            rows={4}
            value={draft}
            maxLength={5000}
            placeholder={
              channel === "email"
                ? "Write the reply exactly as the venue should read it…"
                : "What you found, what you did, what is still outstanding…"
            }
            onChange={(e) => setDraft(e.target.value)}
          />
        </label>
        <div className="adm-card-actions">
          <AdminAction
            tone="primary"
            icon={channel === "email" ? "send" : "note_add"}
            busy={busy}
            blocked={replyBlocked}
            busyLabel="Saving…"
            onAct={send}
          >
            {channel === "email" ? "Send reply" : "Save note"}
          </AdminAction>
          {(STATUS_FLOW[request.status] ?? []).map((next) => (
            <AdminAction key={next} busy={busy} onAct={() => move(next)}>
              {STATUS_LABEL[next]}
            </AdminAction>
          ))}
        </div>
        {channel === "email" && !emailEnabled ? (
          <p className="admin-muted">
            Email is off in this environment (<code>NOTIFICATIONS_ENABLED</code> plus the
            provider credential), so the API refuses an emailed reply rather than queueing one
            nothing can send.
          </p>
        ) : null}
      </div>
    </div>
  );
}
