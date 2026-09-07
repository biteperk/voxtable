import { useState } from "react";

import { AdminAction } from "../../../components/admin/AdminAction";
import { Badge } from "../../../components/admin/Badge";
import { SectionCard } from "../../../components/admin/SectionCard";

const FIELDS = [
  {
    key: "twilio_phone_number",
    label: "Twilio number (the number guests dial)",
    placeholder: "+61…"
  },
  { key: "retell_phone_number", label: "Retell number", placeholder: "+61…" },
  { key: "retell_agent_id", label: "Retell agent id", placeholder: "agent_…" }
];

/**
 * Binding a venue's line. Every refusal is explained on click rather than by
 * greying the button out — on 7 Sep 2026 an operator believed they had bound a
 * live venue's line and no request had left the browser at all.
 */
export function PhoneLineCard({ prov, busy, onBind, onGoLive }) {
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
  const halfBound = Boolean(willHaveNumber) !== Boolean(willHaveAgent);

  const payload = () => {
    const out = {};
    for (const key of Object.keys(form)) {
      if (form[key].trim()) out[key] = form[key].trim();
    }
    return out;
  };

  const bindBlocked = halfBound
    ? willHaveNumber
      ? "Add the Retell agent id as well — a number without its agent would answer in another venue's voice, and the API refuses it."
      : "Add the Twilio number as well — an agent without a number binds nothing a guest can dial."
    : Object.keys(payload()).length === 0
      ? "Nothing to save — fill in the Twilio number and the Retell agent id first."
      : null;

  const goLiveBlocked =
    prov?.onboarding_status === "live"
      ? "This venue is already live."
      : !prov?.twilio_phone_number || !prov?.retell_agent_id
        ? "Save the Twilio number and the Retell agent id first — going live needs both bindings stored, and what is typed above isn't saved yet."
        : null;

  const dirty = FIELDS.concat({ key: "calcom_event_type_id" }).some(
    ({ key }) => form[key].trim() !== String(prov?.[key] ?? "")
  );

  return (
    <SectionCard
      title="Phone line"
      icon="phone_forwarded"
      badge={dirty ? <Badge state="info">Unsaved changes</Badge> : null}
      subtitle="The number and the agent are stored together — one without the other cannot answer a call."
    >
      {FIELDS.map(({ key, label, placeholder }) => (
        <label key={key} className="admin-field">
          <span>{label}</span>
          <input
            className="admin-input"
            value={form[key]}
            placeholder={placeholder}
            onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
          />
        </label>
      ))}

      <label className="admin-field">
        <span>Cal.com event type id — online bookings</span>
        <input
          className="admin-input"
          value={form.calcom_event_type_id}
          placeholder="e.g. 3414737 — leave blank for voice-only venues"
          inputMode="numeric"
          onChange={(e) => setForm((f) => ({ ...f, calcom_event_type_id: e.target.value }))}
        />
      </label>
      <p className="admin-muted">
        Optional and independent of the phone line. An inbound Cal.com webhook is matched
        against this, so another venue&apos;s event type would seat this restaurant&apos;s online
        diners at that venue&apos;s tables — the API refuses one another venue already holds.
      </p>

      <div className="adm-card-actions">
        <AdminAction
          tone="primary"
          icon="save"
          busy={busy}
          blocked={bindBlocked}
          busyLabel="Saving…"
          onAct={() => onBind(payload())}
        >
          Save bindings
        </AdminAction>
        <AdminAction icon="rocket_launch" busy={busy} blocked={goLiveBlocked} onAct={onGoLive}>
          Go live
        </AdminAction>
      </div>

      {/* The STORED state, so "did that actually save?" is answerable at a glance. */}
      <dl className="adm-kv-grid">
        <div className="adm-kv">
          <span className="adm-kv-label">Saved number</span>
          <span className="adm-kv-value">{prov?.twilio_phone_number ?? "none"}</span>
        </div>
        <div className="adm-kv">
          <span className="adm-kv-label">Saved agent</span>
          <span className="adm-kv-value">{prov?.retell_agent_id ?? "none"}</span>
        </div>
        <div className="adm-kv">
          <span className="adm-kv-label">Status</span>
          <span className="adm-kv-value">{prov?.onboarding_status ?? "—"}</span>
        </div>
      </dl>
    </SectionCard>
  );
}
