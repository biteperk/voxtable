import { useCallback, useEffect, useRef, useState } from "react";
import { readStorageKey, writeStorageKey } from "../../lib/storageKeys";
import { auth, resendVerification, signOutUser } from "../../firebase";
import { authErrorMessage } from "../../lib/authErrors";
import { useAuth } from "../../auth";
import { Icon } from "../../components/Icon";

const POLL_MS = 5000;
const MAX_POLLS = 60; // ~5 minutes, then the manual button remains available
const RESEND_COOLDOWN_S = 30;
const SENT_AT_KEY = "verify-email-sent-at";

function readStoredCooldown() {
  try {
    const raw = readStorageKey(SENT_AT_KEY, ":");
    if (!raw) return 0;
    const elapsed = Math.floor((Date.now() - Number(raw)) / 1000);
    return Math.max(0, RESEND_COOLDOWN_S - elapsed);
  } catch {
    return 0;
  }
}

function markSent() {
  try {
    writeStorageKey(SENT_AT_KEY, String(Date.now()), ":");
  } catch {
    // Storage may be unavailable in private mode. Firebase still rate-limits
    // repeated sends server-side.
  }
}

/**
 * Native Firebase email verification for email/password accounts.
 *
 * Firebase hosts and applies the action code. This screen sends/resends the
 * verification email, polls the current Firebase user, refreshes the cached ID
 * token's email_verified claim, and only then enters onboarding.
 */
export function VerifyEmailScreen({ navigate }) {
  const { refreshMe } = useAuth();
  const initialCooldown = readStoredCooldown();
  const [error, setError] = useState(null);
  const [sentAt, setSentAt] = useState(() => (initialCooldown > 0 ? Date.now() : null));
  const [cooldown, setCooldown] = useState(initialCooldown);
  const [checking, setChecking] = useState(false);
  const advancing = useRef(false);
  const autoSent = useRef(false);
  const email = auth.currentUser?.email ?? "your email";

  const advanceIfVerified = useCallback(async () => {
    const user = auth.currentUser;
    if (!user || advancing.current) return false;

    await user.reload();
    if (!user.emailVerified) return false;

    advancing.current = true;
    try {
      await user.getIdToken(true);
      await refreshMe();
      navigate("/onboarding", { replace: true });
      return true;
    } catch (err) {
      advancing.current = false;
      throw err;
    }
  }, [navigate, refreshMe]);

  const handleSend = useCallback(async () => {
    if (cooldown > 0) return;
    setError(null);
    try {
      await resendVerification();
    } catch (err) {
      // A verification message is normally already waiting when Firebase
      // rate-limits a resend. Keep the calm sent state for that case.
      if (!(err && err.code === "auth/too-many-requests")) {
        setError(authErrorMessage(err));
        return;
      }
    }

    markSent();
    setSentAt(Date.now());
    setCooldown(RESEND_COOLDOWN_S);
  }, [cooldown]);

  // Account creation intentionally routes here before sending. This keeps one
  // owner for delivery and avoids duplicate Firebase verification messages.
  useEffect(() => {
    if (autoSent.current) return;
    autoSent.current = true;
    if (readStoredCooldown() === 0) void handleSend();
  }, [handleSend]);

  // The action link may be opened in another tab or on another device. Polling
  // the signed-in tab lets onboarding continue without a manual refresh.
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
        // A transient reload/token error is retried on the next poll.
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [advanceIfVerified]);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const handleCheck = async () => {
    if (checking) return;
    setChecking(true);
    setError(null);
    try {
      const verified = await advanceIfVerified();
      if (!verified) {
        setError("Not verified yet — open the link in the Firebase email, then try again.");
      }
    } catch (err) {
      setError(
        err && err.code === "auth/too-many-requests"
          ? "Still confirming — give it a few seconds, then try again."
          : authErrorMessage(err)
      );
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
            ? " A verification link is on its way. Open it and this page will continue automatically."
            : " We're sending you a verification link now."}
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

        <p className="verify-hint">Not seeing it? Check your spam folder.</p>

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
