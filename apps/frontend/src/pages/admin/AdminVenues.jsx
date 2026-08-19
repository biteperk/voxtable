import { useCallback, useEffect, useState } from "react";

import {
  adminBindProvisioning,
  adminGoLive,
  adminUnbindProvisioning,
  getAdminRestaurant,
  getAdminRestaurantSubscription,
  getAdminRestaurants
} from "../../api";

const STATUSES = [
  "",
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

export function AdminVenues() {
  const [filter, setFilter] = useState({ status: "", q: "" });
  const [list, setList] = useState(null);
  const [publishedTerms, setPublishedTerms] = useState(null);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const result = await getAdminRestaurants({
        status: filter.status || undefined,
        q: filter.q || undefined
      });
      setList(result.restaurants ?? []);
      setPublishedTerms(result.published_terms_version ?? null);
      setError(null);
    } catch (e) {
      setError(e.message ?? "Failed to load venues");
    }
  }, [filter]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="admin-stack">
      <div className="admin-toolbar">
        <input
          className="admin-input"
          type="search"
          placeholder="Search venues by name…"
          value={filter.q}
          onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))}
          aria-label="Search venues"
        />
        <select
          className="admin-input"
          value={filter.status}
          onChange={(e) => setFilter((f) => ({ ...f, status: e.target.value }))}
          aria-label="Filter by onboarding status"
        >
          {STATUSES.map((s) => (
            <option key={s || "all"} value={s}>
              {s ? s.replace(/_/g, " ") : "All statuses"}
            </option>
          ))}
        </select>
      </div>

      {error ? <div className="menu-error" role="alert">{error}</div> : null}
      {!list ? <p className="admin-muted">Loading…</p> : null}
      {list && list.length === 0 ? <p className="admin-muted">No venues match.</p> : null}

      {list?.map((venue) => (
        <VenueCard
          key={venue.id}
          venue={venue}
          publishedTerms={publishedTerms}
          expanded={expandedId === venue.id}
          onToggle={() => setExpandedId((id) => (id === venue.id ? null : venue.id))}
          onChanged={refresh}
        />
      ))}
    </div>
  );
}

function VenueCard({ venue, publishedTerms, expanded, onToggle, onChanged }) {
  const bothBound = Boolean(venue.twilio_phone_number && venue.retell_agent_id);
  const termsDrift =
    publishedTerms && venue.terms_version && venue.terms_version !== publishedTerms;

  return (
    <section className="onboarding-card admin-card admin-venue">
      <button type="button" className="admin-venue-head" onClick={onToggle} aria-expanded={expanded}>
        <span className="admin-venue-name">{venue.name}</span>
        <span className={`status-pill ${venue.onboarding_status === "live" ? "confirmed" : ""}`}>
          {venue.onboarding_status.replace(/_/g, " ")}
        </span>
        <span className={`admin-flag ${bothBound ? "is-on" : ""}`}>
          {bothBound ? "phone line bound" : "no phone line"}
        </span>
        {venue.terms_version ? (
          <span className={`admin-flag ${termsDrift ? "is-warn" : "is-on"}`}>
            terms {venue.terms_version}
            {termsDrift ? ` → ${publishedTerms} published` : ""}
          </span>
        ) : (
          <span className="admin-flag">no terms recorded</span>
        )}
        {venue.has_stripe_customer ? <span className="admin-flag is-on">stripe</span> : null}
      </button>
      {expanded ? <VenueDetail venueId={venue.id} venueName={venue.name} onChanged={onChanged} /> : null}
    </section>
  );
}

function VenueDetail({ venueId, venueName, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [subscription, setSubscription] = useState(undefined); // undefined = not loaded yet
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetail(await getAdminRestaurant(venueId));
      setError(null);
    } catch (e) {
      setError(e.message ?? "Failed to load venue");
    }
  }, [venueId]);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (label, fn) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(label);
      await load();
      onChanged();
    } catch (e) {
      setError(e.message ?? "That didn't work");
    } finally {
      setBusy(false);
    }
  };

  if (error && !detail) return <div className="menu-error" role="alert">{error}</div>;
  if (!detail) return <p className="admin-muted">Loading…</p>;

  const prov = detail.provisioning;

  return (
    <div className="admin-venue-detail">
      {error ? <div className="menu-error" role="alert">{error}</div> : null}
      {notice ? (
        <div className="menu-error admin-notice" role="status">
          {notice}
        </div>
      ) : null}

      <div className="admin-detail-grid">
        <BindPanel prov={prov} busy={busy} run={run} venueId={venueId} />

        <div className="admin-panel">
          <h4>Legal</h4>
          <dl className="admin-dl">
            <dt>Terms version</dt>
            <dd>{detail.legal?.terms_version ?? "—"}</dd>
            <dt>Last acceptance</dt>
            <dd>
              {detail.legal?.latest_acceptance
                ? `${detail.legal.latest_acceptance.document_set_version} · ${new Date(
                    detail.legal.latest_acceptance.accepted_at
                  ).toLocaleDateString()} · ${detail.legal.latest_acceptance.channel}`
                : "none recorded"}
            </dd>
            <dt>Retention</dt>
            <dd>
              {detail.legal?.elections?.retention_days
                ? `${detail.legal.elections.retention_days} days · ${detail.legal.elections.storage_tier ?? ""}`
                : "—"}
            </dd>
            <dt>Legal entity</dt>
            <dd>
              {detail.legal?.elections?.client_legal_name ?? "—"}
              {detail.legal?.elections?.client_abn ? ` · ABN ${detail.legal.elections.client_abn}` : ""}
            </dd>
          </dl>
        </div>

        <div className="admin-panel">
          <h4>Billing</h4>
          <dl className="admin-dl">
            <dt>Stripe customer</dt>
            <dd>{detail.billing?.has_stripe_customer ? "yes" : "no"}</dd>
            <dt>Connect</dt>
            <dd>
              charges {detail.billing?.connect_charges_enabled ? "on" : "off"} · payouts{" "}
              {detail.billing?.connect_payouts_enabled ? "on" : "off"}
            </dd>
            <dt>Subscription</dt>
            <dd>
              {subscription === undefined ? (
                <button
                  className="ghost-button"
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    try {
                      const result = await getAdminRestaurantSubscription(venueId);
                      setSubscription(result.subscription ?? null);
                    } catch (e) {
                      setError(e.message ?? "Couldn't load the subscription");
                    }
                  }}
                >
                  Load from Stripe
                </button>
              ) : subscription === null ? (
                "none"
              ) : (
                `${subscription.plan_name ?? "plan"} · ${subscription.status} · renews ${subscription.current_period_end ?? "?"}`
              )}
            </dd>
          </dl>
        </div>

        <div className="admin-panel">
          <h4>Team</h4>
          {detail.members?.length ? (
            <ul className="admin-audit">
              {detail.members.map((m) => (
                <li key={m.userId ?? m.user_id ?? m.email}>
                  <span>{m.email ?? m.name ?? m.userId ?? m.user_id}</span>
                  <span className="admin-audit-action">{m.role}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="admin-muted">No members.</p>
          )}
          <p className="admin-muted">
            Today: {detail.activity_today?.calls ?? 0} calls · {detail.activity_today?.bookings ?? 0}{" "}
            bookings
          </p>
        </div>
      </div>

      <DangerZone prov={prov} venueId={venueId} venueName={venueName} busy={busy} run={run} />
    </div>
  );
}

function BindPanel({ prov, busy, run, venueId }) {
  const [form, setForm] = useState({
    twilio_phone_number: prov?.twilio_phone_number ?? "",
    retell_phone_number: prov?.retell_phone_number ?? "",
    retell_agent_id: prov?.retell_agent_id ?? "",
    calcom_event_type_id:
      prov?.calcom_event_type_id === null || prov?.calcom_event_type_id === undefined
        ? ""
        : String(prov.calcom_event_type_id)
  });

  const willHaveNumber = form.twilio_phone_number.trim() || prov?.twilio_phone_number;
  const willHaveAgent = form.retell_agent_id.trim() || prov?.retell_agent_id;
  const halfBound = (willHaveNumber && !willHaveAgent) || (!willHaveNumber && willHaveAgent);

  const submit = () => {
    const payload = {};
    for (const key of [
      "twilio_phone_number",
      "retell_phone_number",
      "retell_agent_id",
      "calcom_event_type_id"
    ]) {
      if (form[key].trim()) payload[key] = form[key].trim();
    }
    if (Object.keys(payload).length === 0) return;
    run("Bindings saved.", () => adminBindProvisioning(venueId, payload));
  };

  const canGoLive = prov?.twilio_phone_number && prov?.retell_agent_id && prov?.onboarding_status !== "live";

  return (
    <div className="admin-panel">
      <h4>Phone line</h4>
      <label className="admin-field">
        <span>Twilio number (the dialled number)</span>
        <input
          className="admin-input"
          value={form.twilio_phone_number}
          placeholder="+61…"
          onChange={(e) => setForm((f) => ({ ...f, twilio_phone_number: e.target.value }))}
        />
      </label>
      <label className="admin-field">
        <span>Retell number</span>
        <input
          className="admin-input"
          value={form.retell_phone_number}
          placeholder="+61…"
          onChange={(e) => setForm((f) => ({ ...f, retell_phone_number: e.target.value }))}
        />
      </label>
      <label className="admin-field">
        <span>Retell agent id</span>
        <input
          className="admin-input"
          value={form.retell_agent_id}
          placeholder="agent_…"
          onChange={(e) => setForm((f) => ({ ...f, retell_agent_id: e.target.value }))}
        />
      </label>
      <h4>Online bookings (Cal.com)</h4>
      <label className="admin-field">
        <span>Cal.com event type id</span>
        <input
          className="admin-input"
          value={form.calcom_event_type_id}
          placeholder="e.g. 3414737 — leave blank for voice-only venues"
          inputMode="numeric"
          onChange={(e) => setForm((f) => ({ ...f, calcom_event_type_id: e.target.value }))}
        />
      </label>
      <p className="admin-muted">
        Optional, and independent of the phone line. This is what an inbound Cal.com webhook
        is matched against, so binding another venue's event type would seat this
        restaurant's online diners at that venue's tables — the API refuses an event type
        another venue already holds. Clearing it stops new bookings mirroring while leaving
        bookings already on Cal.com cancellable.
      </p>
      {halfBound ? (
        <p className="admin-warning" role="alert">
          Set BOTH the Twilio number and the Retell agent. Saving one alone keeps the other's
          previous value, which points the new number at the old venue's agent — the line then
          answers in the wrong restaurant's voice. The API rejects a half-bind for that reason.
          To remove a binding, use “Clear bindings” below.
        </p>
      ) : null}
      <div className="admin-panel-actions">
        <button
          className="primary-button"
          type="button"
          disabled={busy || halfBound}
          title={halfBound ? "Bind the number and the agent together" : ""}
          onClick={submit}
        >
          Save bindings
        </button>
        <button
          className="ghost-button"
          type="button"
          disabled={busy || !canGoLive}
          title={canGoLive ? "" : "Needs both bindings, and a venue that isn't already live"}
          onClick={() => run("Venue is live.", () => adminGoLive(venueId))}
        >
          Go live
        </button>
      </div>
    </div>
  );
}

function DangerZone({ prov, venueId, venueName, busy, run }) {
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState([]);
  const [confirmName, setConfirmName] = useState("");
  const [ackLive, setAckLive] = useState(false);
  const isLive = prov?.onboarding_status === "live";

  const toggleField = (name) =>
    setFields((f) => (f.includes(name) ? f.filter((x) => x !== name) : [...f, name]));

  const canSubmit = fields.length > 0 && confirmName === venueName && (!isLive || ackLive);

  return (
    <div className="admin-danger">
      <button className="ghost-button" type="button" onClick={() => setOpen((o) => !o)}>
        {open ? "Close danger zone" : "Danger zone…"}
      </button>
      {open ? (
        <div className="admin-panel admin-danger-panel">
          <h4>Clear bindings</h4>
          <p className="admin-muted">
            {isLive
              ? "This venue is LIVE. Clearing its bindings disconnects its phone line — callers get dead air until a new number and agent are bound."
              : "Clears the selected bindings. The venue can be re-bound at any time."}
          </p>
          {[
            ["twilio_phone_number", prov?.twilio_phone_number],
            ["retell_phone_number", prov?.retell_phone_number],
            ["retell_agent_id", prov?.retell_agent_id],
            ["calcom_event_type_id", prov?.calcom_event_type_id]
          ].map(([name, value]) => (
            <label key={name} className="admin-check">
              <input
                type="checkbox"
                checked={fields.includes(name)}
                disabled={!value}
                onChange={() => toggleField(name)}
              />
              <span>
                {name.replace(/_/g, " ")} {value ? `(${value})` : "(not set)"}
              </span>
            </label>
          ))}
          <label className="admin-field">
            <span>Type the venue's exact name to confirm</span>
            <input
              className="admin-input"
              value={confirmName}
              placeholder={venueName}
              onChange={(e) => setConfirmName(e.target.value)}
            />
          </label>
          {isLive ? (
            <label className="admin-check">
              <input type="checkbox" checked={ackLive} onChange={(e) => setAckLive(e.target.checked)} />
              <span>I understand this disconnects the venue's phone line.</span>
            </label>
          ) : null}
          <button
            className="primary-button admin-danger-button"
            type="button"
            disabled={busy || !canSubmit}
            onClick={() =>
              run("Bindings cleared.", () =>
                adminUnbindProvisioning(venueId, {
                  fields,
                  confirm_name: confirmName,
                  acknowledge_live: ackLive
                })
              ).then(() => {
                setFields([]);
                setConfirmName("");
                setAckLive(false);
                setOpen(false);
              })
            }
          >
            Clear the selected bindings
          </button>
        </div>
      ) : null}
    </div>
  );
}
