import { useEffect, useRef, useState } from "react";
import { auth, resendVerification, signOutUser } from "../../firebase";
import { authErrorMessage } from "../../lib/authErrors";
import { useAuth } from "../../auth";
import { Icon } from "../../components/Icon";

// The funnel's "Verify Email" node. Shown to any signed-in-but-unverified
// account (email/password signups, and the rare unverified-Google case — so
// the copy never assumes an email is already in the inbox).
//
// Stale-token trap: the cached ID token carries email_verified for up to 1h
// and api.js only force-refreshes on 401, not 403. After verification we MUST
// user.reload() then getIdToken(true) before touching the API, or every call
// keeps 403ing.

const POLL_MS = 5000;
const MAX_POLLS = 60; // ~5 minutes, then the manual button takes over
const RESEND_COOLDOWN_S = 30;
const SENT_AT_KEY = "vocotable:verify-email-sent-at";

// Resend cooldown that survives a page reload — so a client who refreshes and
// clicks again sees the countdown, not a fresh-looking button that trips
// Firebase's server-side rate limit.
function readStoredCooldown() {
  try {
    const raw = window.localStorage.getItem(SENT_AT_KEY);
    if (!raw) return 0;
    const elapsed = Math.floor((Date.now() - Number(raw)) / 1000);
    return Math.max(0, RESEND_COOLDOWN_S - elapsed);
  } catch {
    return 0;
  }
}

function markSent() {
  try {
    window.localStorage.setItem(SENT_AT_KEY, String(Date.now()));
  } catch {
    // Storage disabled (e.g. private mode) — the cooldown just won't persist.
  }
}

export function VerifyEmailScreen({ navigate }) {
  const { refreshMe } = useAuth();
  const [error, setError] = useState(null);
  const [sentAt, setSentAt] = useState(() => (readStoredCooldown() > 0 ? Date.now() : null));
  const [cooldown, setCooldown] = useState(readStoredCooldown);
  const [checking, setChecking] = useState(false);
  const advancing = useRef(false);
  const email = auth.currentUser?.email ?? "your email";

  const advanceIfVerified = async () => {
    const user = auth.currentUser;
    if (!user || advancing.current) return false;
    await user.reload();
    if (!user.emailVerified) return false;
    advancing.current = true;
    await user.getIdToken(true); // refresh the cached token's email_verified claim
    await refreshMe();
    navigate("/onboarding", { replace: true });
    return true;
  };

  // Auto-poll: the user clicks the emailed link (possibly in another tab or on
  // their phone); this tab notices and moves on by itself.
  useEffect(() => {
    let polls = 0;
    let cancelled = false;
    const timer = setInterval(async () => {
      polls += 1;
      if (polls > MAX_POLLS) {
        clearInterval(timer);
        return;
      }
      try {
        if (!cancelled) await advanceIfVerified();
      } catch {
        // Transient — the next tick retries.
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resend cooldown ticker.
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const handleSend = async () => {
    if (cooldown > 0) return;
    setError(null);
    try {
      await resendVerification();
    } catch (e) {
      // Firebase rate-limits repeated sends. For a client that only means a
      // link is already sitting in their inbox — not worth a red alert. Any
      // other failure still surfaces normally.
      if (!(e && e.code === "auth/too-many-requests")) {
        setError(authErrorMessage(e));
        return;
      }
    }
    // Freshly sent, or already sent moments ago — both land in the same calm
    // "it's on its way" state, with a resend countdown that survives reloads.
    markSent();
    setSentAt(Date.now());
    setCooldown(RESEND_COOLDOWN_S);
  };

  const handleCheck = async () => {
    if (checking) return;
    setChecking(true);
    setError(null);
    try {
      const done = await advanceIfVerified();
      if (!done) {
        setError("Not verified yet — tap the link in the email we sent, then try again.");
      }
    } catch (e) {
      if (e && e.code === "auth/too-many-requests") {
        setError("Still confirming — give it a few seconds, then tap again.");
      } else {
        setError(authErrorMessage(e));
      }
    } finally {
      setChecking(false);
    }
  };

  const handleSignOut = async () => {
    await signOutUser();
    navigate("/", { replace: true });
  };

  return (
    <div className="login-shell">
      <div className="login-bg-glow login-bg-glow-1" aria-hidden="true" />
      <div className="login-bg-glow login-bg-glow-2" aria-hidden="true" />

      <div className="login-card">
        <img
          src="/brand/mark-light-on-dark.svg"
          alt="VoxTable"
          className="login-mark"
          width="56"
          height="56"
        />
        <h1 className="login-title">VoxTable</h1>
        <p className="login-tagline">Voice AI booking for restaurants</p>

        <div className="login-divider" aria-hidden="true" />

        <h2 className="login-heading">Verify your email</h2>
        <p className="login-sub">
          We need to confirm <strong>{email}</strong> is yours.
          {sentAt
            ? " A verification link is on its way — tap it, and this page moves on by itself. Not seeing it? Check your spam folder."
            : " Tap the link in the email we sent when you created your account — or send a fresh one below."}
        </p>

        <button
          type="button"
          className="login-submit"
          onClick={handleSend}
          disabled={cooldown > 0}
        >
          {cooldown > 0 ? `Link sent — resend in ${cooldown}s` : "Send verification link"}
        </button>

        <button type="button" className="login-check" onClick={handleCheck} disabled={checking}>
          {checking ? "Checking…" : "I've verified — continue"}
        </button>

        {error && (
          <div className="login-error" role="alert">
            <Icon name="error" />
            <span>{error}</span>
          </div>
        )}

        <div className="login-footer">
          <button onClick={handleSignOut} className="login-back" type="button">
            <Icon name="arrow_back" />
            Use a different account
          </button>
        </div>
      </div>
    </div>
  );
}
