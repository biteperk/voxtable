import { useEffect, useState } from "react";
import { getAgreement, submitAgreement } from "../../../api";
import { Icon } from "../../../components/Icon";

// ===== Agreement step (legal layer) =====
// The Order Form rendered as a form: service + data elections, then three
// SEPARATE consents (contract, overseas processing, caller disclosure — they
// do different legal jobs, so they are never bundled into one checkbox).
// Fees are shown on the trial step; languages are fixed server-side (en-AU).

const SERVICE_LABELS = {
  voxtable: "VoxTable — table bookings",
  voxorder: "VoxOrder — takeaway & pickup",
  voxconcierge: "VoxConcierge — front of house"
};

export function AgreementStep({ onSaved, onBack = null }) {
  const [config, setConfig] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Validation messages pinned to a specific input, keyed by API field name.
  const [fieldErrors, setFieldErrors] = useState({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await getAgreement();
        if (cancelled) return;
        const prior = cfg.accepted?.order_form ?? null;
        setConfig(cfg);
        setForm({
          client_legal_name: prior?.client_legal_name ?? "",
          client_abn: prior?.client_abn ?? "",
          services: prior?.services ?? ["voxtable"],
          phone_mode: prior?.phone_mode ?? "forward_existing",
          extra_email: prior?.delivery_targets?.emails?.[0] ?? "",
          retention_days: prior?.retention_days ?? 30,
          storage_tier: prior?.storage_tier ?? "everything",
          pii_redaction: prior?.pii_redaction ?? false,
          consent_terms: false,
          consent_overseas: false,
          consent_disclosure: false
        });
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!form || !config) {
    return (
      <div className="onboarding-card is-loading">
        <p style={{ color: "var(--on-surface-variant)" }}>{error ? `Couldn't load: ${error}` : "Loading…"}</p>
      </div>
    );
  }

  // Clear a field's error as soon as the owner starts correcting it — leaving
  // it up while they retype reads as "still wrong" and is quietly demoralising.
  const clearFieldError = (field) =>
    setFieldErrors((prev) => (prev[field] ? { ...prev, [field]: null } : prev));

  const set = (field) => (e) => {
    clearFieldError(field);
    setForm((prev) => ({ ...prev, [field]: e.target.value }));
  };
  const setCheck = (field) => (e) => setForm((prev) => ({ ...prev, [field]: e.target.checked }));
  const toggleService = (s) =>
    setForm((prev) => ({
      ...prev,
      services: prev.services.includes(s)
        ? prev.services.filter((x) => x !== s)
        : [...prev.services, s]
    }));

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    if (form.services.length === 0) {
      setError("Select at least one service.");
      return;
    }
    setBusy(true);
    setError(null);
    setFieldErrors({});
    const payload = {
      document_set_version: config.document_set_version,
      csa_url: config.csa_url,
      schedule_url: config.schedule_url,
      csa_sha256: config.csa_sha256,
      schedule_sha256: config.schedule_sha256,
      client_legal_name: form.client_legal_name.trim(),
      client_abn: form.client_abn.trim(),
      services: form.services,
      phone_mode: form.phone_mode,
      delivery_targets: {
        emails: form.extra_email.trim() ? [form.extra_email.trim()] : [],
        dashboard: true
      },
      retention_days: form.retention_days,
      storage_tier: form.storage_tier,
      pii_redaction: form.pii_redaction,
      consent_terms: form.consent_terms,
      consent_overseas: form.consent_overseas,
      consent_disclosure: form.consent_disclosure
    };
    try {
      await submitAgreement(payload);
      await onSaved();
    } catch (e) {
      // The API returns per-field detail alongside the summary
      // (`{ error: { message, details: { fieldErrors } } }`). Pin what we can
      // to its input so the owner sees which box to fix; anything we can't
      // place still shows in the summary line at the foot of the card.
      const perField = e.details?.fieldErrors ?? {};
      const placed = Object.fromEntries(
        Object.entries(perField)
          .filter(([, messages]) => Array.isArray(messages) && messages.length > 0)
          .map(([field, messages]) => [field, messages[0]])
      );
      setFieldErrors(placed);
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <div className="onboarding-card">
      <h1>Your agreement &amp; data choices</h1>
      <p className="onboarding-lead">
        A couple of decisions about your service and your callers' data — then Bella can get to work.
      </p>
      {config.document_set_version === "DRAFT" && (
        <p className="onboarding-field-help">
          <Icon name="info" /> Preview environment — the agreement documents are not final yet.
        </p>
      )}
      <form onSubmit={submit} className="onboarding-form">
        <div className="onboarding-field-row">
          <label className="onboarding-field">
            <span>Legal / trading name</span>
            <input
              type="text"
              value={form.client_legal_name}
              onChange={set("client_legal_name")}
              maxLength={200}
              required
            />
          </label>
          <label className="onboarding-field">
            <span>ABN</span>
            <input
              type="text"
              inputMode="numeric"
              value={form.client_abn}
              onChange={set("client_abn")}
              placeholder="12 345 678 901"
              maxLength={14}
              required
              aria-invalid={fieldErrors.client_abn ? "true" : undefined}
              aria-describedby={fieldErrors.client_abn ? "abn-error" : undefined}
            />
            {/* Shown against the field rather than only at the foot of the
                card — an ABN typo is 20 lines above the submit button, and a
                message down there gives no clue which box to fix. */}
            {fieldErrors.client_abn && (
              <span className="onboarding-field-error" id="abn-error" role="alert">
                {fieldErrors.client_abn}
              </span>
            )}
          </label>
        </div>

        <label className="onboarding-field">
          <span>Which services do you want?</span>
          <div className="onboarding-chips">
            {config.services_available.map((s) => (
              <button
                key={s}
                type="button"
                className={`onboarding-chip${form.services.includes(s) ? " is-on" : ""}`}
                onClick={() => toggleService(s)}
              >
                {SERVICE_LABELS[s] ?? s}
              </button>
            ))}
          </div>
        </label>

        <label className="onboarding-field">
          <span>Phone setup</span>
          <div className="onboarding-chips">
            <button
              type="button"
              className={`onboarding-chip${form.phone_mode === "forward_existing" ? " is-on" : ""}`}
              onClick={() => setForm((p) => ({ ...p, phone_mode: "forward_existing" }))}
            >
              Forward my existing number
            </button>
            <button
              type="button"
              className={`onboarding-chip${form.phone_mode === "new_dedicated" ? " is-on" : ""}`}
              onClick={() => setForm((p) => ({ ...p, phone_mode: "new_dedicated" }))}
            >
              New dedicated number
            </button>
          </div>
        </label>

        <label className="onboarding-field">
          <span>How long should call recordings be kept?</span>
          <div className="onboarding-chips">
            {[30, 90].map((d) => (
              <button
                key={d}
                type="button"
                className={`onboarding-chip${form.retention_days === d ? " is-on" : ""}`}
                onClick={() => setForm((p) => ({ ...p, retention_days: d }))}
              >
                {d} days
              </button>
            ))}
          </div>
          <span className="onboarding-field-help">
            <Icon name="info" /> Recordings and transcripts are deleted automatically after this — there's no
            "keep forever".
          </span>
        </label>

        <label className="onboarding-field">
          <span>What should we store?</span>
          <div className="onboarding-chips">
            <button
              type="button"
              className={`onboarding-chip${form.storage_tier === "everything" ? " is-on" : ""}`}
              onClick={() => setForm((p) => ({ ...p, storage_tier: "everything" }))}
            >
              Everything
            </button>
            <button
              type="button"
              className={`onboarding-chip${form.storage_tier === "everything_except_pii" ? " is-on" : ""}`}
              onClick={() => setForm((p) => ({ ...p, storage_tier: "everything_except_pii" }))}
            >
              Everything except personal details
            </button>
          </div>
        </label>

        <label className="onboarding-field">
          <span>
            Extra email for booking notifications <em>(optional)</em>
          </span>
          <input type="email" value={form.extra_email} onChange={set("extra_email")} maxLength={160} />
        </label>

        <div className="onboarding-consents">
          <label className="onboarding-consent">
            <input
              type="checkbox"
              checked={form.pii_redaction}
              onChange={setCheck("pii_redaction")}
            />
            <span>Redact callers' personal details from stored transcripts where possible.</span>
          </label>
        </div>

        <div className="onboarding-consents onboarding-consents-legal">
          <label className="onboarding-consent">
            <input type="checkbox" checked={form.consent_terms} onChange={setCheck("consent_terms")} required />
            <span>
              I agree to the{" "}
              <a href={config.csa_url} target="_blank" rel="noreferrer">
                Client Services Agreement
              </a>{" "}
              and the{" "}
              <a href={config.schedule_url} target="_blank" rel="noreferrer">
                Privacy &amp; Data Handling Schedule
              </a>
              .
            </span>
          </label>
          <label className="onboarding-consent">
            <input
              type="checkbox"
              checked={form.consent_overseas}
              onChange={setCheck("consent_overseas")}
              required
            />
            <span>
              I acknowledge that voice-AI processing happens partly in the United States, as described in the
              Privacy &amp; Data Handling Schedule.
            </span>
          </label>
          <label className="onboarding-consent">
            <input
              type="checkbox"
              checked={form.consent_disclosure}
              onChange={setCheck("consent_disclosure")}
              required
            />
            <span>
              I understand Bella announces on every call that she's an AI and that the call is recorded — and
              that this can't be switched off.
            </span>
          </label>
        </div>

        {error && (
          <p className="onboarding-error" role="alert">
            {error}
          </p>
        )}
        <div className="onboarding-actions">
          {onBack && (
            <button type="button" className="ghost-button" onClick={onBack} disabled={busy}>
              <Icon name="arrow_back" /> Back
            </button>
          )}
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? "Saving…" : "Agree & continue"} <Icon name="arrow_forward" />
          </button>
        </div>
      </form>
    </div>
  );
}
