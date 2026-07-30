import { useCallback, useEffect, useRef, useState } from "react";
import { auth, resendVerification, signOutUser } from "../../firebase";
import { sendVerificationCode, confirmVerificationCode } from "../../api";
import { authErrorMessage } from "../../lib/authErrors";
import { useAuth } from "../../auth";
import { Icon } from "../../components/Icon";
import { OtpInput } from "../../components/OtpInput";

// The funnel's "Verify Email" node, shown to any signed-in-but-unverified
// account. Two modes:
//
//  "code"   — the premium path: the backend emails a branded 6-digit code
//             (via the notifications outbox) and the user types it here.
//  "legacy" — the original Firebase-link flow, kept verbatim as the fallback
//             when the backend has the code feature off (404 FEATURE_DISABLED)
//             or predates it.
//
// Stale-token trap (both modes): the cached ID token carries email_verified
// for up to 1h and api.js only force-refreshes on 401, not 403. After
// verification we MUST user.reload() then getIdToken(true) before touching
// the API, or every call keeps 403ing.

export function VerifyEmailScreen({ navigate }) {
  const [mode, setMode] = useState("code");
  if (mode === "legacy") {
    return <LegacyVerifyEmail navigate={navigate} />;
  }
  return <CodeVerifyEmail navigate={navigate} onFallback={() => setMode("legacy")} />;
}

// ===== Code mode =====

function CodeVerifyEmail({ navigate, onFallback }) {
  const { refreshMe } = useAuth();
  const [code, setCode] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [phase, setPhase] = useState("sending"); // sending | ready | confirming | success
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const sentOnce = useRef(false);
  const advancing = useRef(false);
  const email = auth.currentUser?.email ?? "your email";

  const requestCode = useCallback(
    async ({ silent = false } = {}) => {
      setError(null);
      try {
        const res = await sendVerificationCode();
        if (res?.already_verified) {
          await advanceVerified();
          return;
        }
        setCooldown(res?.cooldown_seconds ?? 60);
        setPhase("ready");
        if (!silent) setNotice("A fresh code is on its way.");
      } catch (e) {
        // Feature off or older backend → the legacy Firebase-link flow.
        if (e?.status === 404 || /^404\b/.test(e?.message ?? "")) {
          onFallback();
          return;
        }
        // Cooldown/cap: a code is already in the inbox — calm state, not an error.
        if (e?.status === 429) {
          setCooldown(e?.details?.retry_after_seconds ?? 60);
          setPhase("ready");
          return;
        }
        setPhase("ready");
        setError(e?.message ?? String(e));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onFallback]
  );

  // The mandatory post-verification token refresh, then into onboarding. Only
  // navigate on success — navigating with a stale (unverified) user object
  // makes the router re-render this screen on /onboarding with the success
  // card stuck forever. On failure the code IS already confirmed, so offer a
  // retry of just the handoff.
  const advanceVerified = async () => {
    if (advancing.current) return;
    advancing.current = true;
    setPhase("success");
    try {
      const user = auth.currentUser;
      if (user) {
        await user.reload();
        await user.getIdToken(true);
      }
      await refreshMe();
      navigate("/onboarding", { replace: true });
    } catch {
      advancing.current = false;
      setPhase("verified-retry");
    }
  };

  // Auto-send on arrival. (Signup no longer fires Firebase's email, so this is
  // the moment the first code goes out.)
  useEffect(() => {
    if (sentOnce.current) return;
    sentOnce.current = true;
    requestCode({ silent: true });
  }, [requestCode]);

  // Resend cooldown ticker.
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const handleComplete = async (fullCode) => {
    if (phase === "confirming" || phase === "success") return;
    setPhase("confirming");
    setError(null);
    setNotice(null);
    try {
      await confirmVerificationCode(fullCode);
      await advanceVerified();
    } catch (e) {
      setPhase("ready");
      setCode("");
      if (e?.code === "INVALID_CODE") {
        const left = e?.details?.attempts_remaining;
        setError(
          left > 0
            ? `That code isn't right — ${left} ${left === 1 ? "try" : "tries"} left.`
            : "That code isn't right."
        );
      } else if (e?.code === "CODE_EXPIRED") {
        setError("That code has expired — tap “Send a new code”.");
      } else if (e?.code === "TOO_MANY_ATTEMPTS") {
        setError("Too many wrong guesses — tap “Send a new code”.");
      } else if (e?.code === "NO_ACTIVE_CODE") {
        setError("That code is no longer active — tap “Send a new code”.");
      } else {
        setError(e?.message ?? String(e));
      }
    }
  };

  const handleSignOut = async () => {
    await signOutUser();
    navigate("/", { replace: true });
  };

  const confirming = phase === "confirming";
  const success = phase === "success";

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

        {success || phase === "verified-retry" ? (
          <div className="verify-success" role="status">
            <span className="verify-success-ring">
              <Icon name="check" />
            </span>
            <h2 className="login-heading">Email verified</h2>
            {phase === "verified-retry" ? (
              <>
                <p className="login-sub">
                  We couldn't load your account just now — check your connection and try again.
                </p>
                <button type="button" className="login-check" onClick={advanceVerified}>
                  Continue to setup
                </button>
              </>
            ) : (
              <p className="login-sub">Taking you to your setup…</p>
            )}
          </div>
        ) : (
          <>
            <h2 className="login-heading">Check your email</h2>
            <p className="login-sub">
              We{phase === "sending" ? "'re sending" : " sent"} a 6-digit code to{" "}
              <strong>{email}</strong>. Enter it below — this page moves on by itself.
            </p>

            <OtpInput
              value={code}
              onChange={(next) => {
                setCode(next);
                if (error) setError(null);
              }}
              onComplete={handleComplete}
              disabled={confirming || phase === "sending"}
              error={Boolean(error)}
            />

            {confirming && (
              <p className="verify-status" role="status">
                <span className="login-spinner verify-spinner" aria-hidden="true" />
                Checking your code…
              </p>
            )}

            {error && (
              <div className="login-error" role="alert">
                <Icon name="error" />
                <span>{error}</span>
              </div>
            )}
            {notice && !error && (
              <p className="login-notice" role="status">
                <Icon name="check_circle" />
                {notice}
              </p>
            )}

            <button
              type="button"
              className="login-check"
              onClick={() => requestCode()}
              disabled={cooldown > 0 || confirming || phase === "sending"}
            >
              {cooldown > 0 ? `Send a new code in ${cooldown}s` : "Send a new code"}
            </button>

            <p className="verify-hint">Not seeing it? Check your spam folder.</p>
          </>
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

// ===== Legacy mode (Firebase link flow) =====
// Kept verbatim as the fallback for a backend without the code feature.

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

function LegacyVerifyEmail({ navigate }) {
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

  // Signup no longer fires Firebase's email (the code flow owns sending), so
  // in this fallback the first link goes out on arrival — unless one was sent
  // moments ago (cooldown survived a reload).
  const autoSent = useRef(false);
  useEffect(() => {
    if (autoSent.current) return;
    autoSent.current = true;
    if (readStoredCooldown() === 0) {
      handleSend();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
            : " We're sending you a verification link — tap it, and this page moves on by itself."}
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
