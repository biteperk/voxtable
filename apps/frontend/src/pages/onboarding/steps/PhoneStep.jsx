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
    // Poll while the number is being provisioned by an admin. Provisioning is
    // a manual ops step that can take a while, so back off after the first
    // minute rather than hammering the API every 6s indefinitely.
    let attempts = 0;
    let cancelled = false;
    const tick = async () => {
      attempts += 1;
      await load();
      if (cancelled) return;
      pollRef.current = setTimeout(tick, attempts < 10 ? 6000 : 30000);
    };
    load();
    pollRef.current = setTimeout(tick, 6000);
    return () => {
      cancelled = true;
      clearTimeout(pollRef.current);
    };
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
          Our team is provisioning your dedicated VoxTable number and configuring Bella with your
          menu. This usually takes a short while — we'll email you the moment it's ready, and this page
          will update automatically.
        </p>
        <p className="onboarding-note">
          <Icon name="info" /> {setup.dev_can_skip_phone_setup ? "Local setup can be finished without provisioning." : "Provisioning in progress…"}
        </p>
        {error && <p className="onboarding-error">{error}</p>}
        {setup.dev_can_skip_phone_setup && (
          <div className="onboarding-actions">
            <button type="button" className="primary-button" onClick={verify} disabled={verifying}>
              {verifying ? "Finishing setup…" : "Finish setup locally"}
              <Icon name="arrow_forward" />
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="onboarding-card">
      <h1>Connect your phone</h1>
      <p className="onboarding-lead">
        Your VoxTable number is ready. Forward your restaurant's calls to it so Bella can answer.
      </p>
      <div className="phone-number-box">
        <span>Your VoxTable number</span>
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
