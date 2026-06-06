import { useCallback, useEffect, useRef, useState } from "react";
import { getPhoneSetup, verifyForwarding } from "../../../api";
import { Icon } from "../../../components/Icon";

export function PhoneStep({ onRefresh }) {
  const [setup, setSetup] = useState(null);
  const [error, setError] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const pollRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const r = await getPhoneSetup();
      setSetup(r);
      if (r.forwarding_verified) onRefresh?.();
    } catch (e) {
      setError(e.message);
    }
  }, [onRefresh]);

  useEffect(() => {
    load();
    // Poll while the number is being provisioned by an admin.
    pollRef.current = setInterval(load, 6000);
    return () => clearInterval(pollRef.current);
  }, [load]);

  const verify = async () => {
    if (verifying) return;
    setVerifying(true);
    setError(null);
    try {
      const r = await verifyForwarding();
      if (r.verified) onRefresh?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setVerifying(false);
    }
  };

  if (!setup) {
    return (
      <div className="onboarding-card is-loading">
        <p style={{ color: "var(--on-surface-variant)" }}>{error ? `Couldn't load: ${error}` : "Loading…"}</p>
      </div>
    );
  }

  if (!setup.number_ready) {
    return (
      <div className="onboarding-card">
        <Icon name="hourglass_top" className="phone-provisioning-icon" />
        <h1>We're setting up your phone line</h1>
        <p className="onboarding-lead">
          Our team is provisioning your dedicated VocoTable number and configuring Bella with your
          menu. This usually takes a short while — we'll email you the moment it's ready, and this page
          will update automatically.
        </p>
        <p className="onboarding-note">
          <Icon name="info" /> Provisioning in progress…
        </p>
      </div>
    );
  }

  return (
    <div className="onboarding-card">
      <h1>Connect your phone</h1>
      <p className="onboarding-lead">
        Your VocoTable number is ready. Forward your restaurant's calls to it so Bella can answer.
      </p>
      <div className="phone-number-box">
        <span>Your VocoTable number</span>
        <strong>{setup.vocotable_number}</strong>
      </div>
      <ol className="phone-steps">
        <li>
          On the phone that customers call, set up <strong>call forwarding</strong> to{" "}
          <strong>{setup.vocotable_number}</strong>. Most AU carriers use a code from the handset:
          <ul>
            <li>All calls: <code>*21*{setup.vocotable_number}#</code></li>
            <li>When busy / no answer: <code>*61*{setup.vocotable_number}#</code></li>
          </ul>
          (Exact steps vary by carrier — Telstra, Optus and Vodafone all support these GSM codes.)
        </li>
        <li>From a different phone, call your restaurant's normal number to test it.</li>
        <li>Tap verify below — we'll confirm the call reached Bella.</li>
      </ol>
      {error && <p className="onboarding-error">{error}</p>}
      <div className="onboarding-actions">
        <button type="button" className="primary-button" onClick={verify} disabled={verifying}>
          {verifying ? "Checking for your test call…" : "I've forwarded my number — verify"}
          <Icon name="arrow_forward" />
        </button>
      </div>
    </div>
  );
}

