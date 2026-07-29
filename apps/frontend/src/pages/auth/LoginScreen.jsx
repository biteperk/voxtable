import { useState } from "react";
import {
  createAccount,
  sendPasswordReset,
  signInWithEmail,
  signInWithGoogle
} from "../../firebase";
import { authErrorMessage } from "../../lib/authErrors";
import { Icon } from "../../components/Icon";
import { BrandMark } from "../../components/brand/BrandMark";

// Representative details captured at signup, persisted server-side only after
// email verification (the backend refuses unverified accounts). AuthProvider
// flushes this stash to POST /api/me/contact on the first verified session.
// Never contains the password.
export const PENDING_SIGNUP_KEY = "vocotable.pendingSignup";

export function LoginScreen({ navigate, notice = null }) {
  const [mode, setMode] = useState("signin"); // "signin" | "create"
  const [form, setForm] = useState({ name: "", phone: "", email: "", password: "" });
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null); // e.g. "reset link sent"
  const [busy, setBusy] = useState(false);

  const set = (field) => (e) => setForm((prev) => ({ ...prev, [field]: e.target.value }));

  const switchMode = (next) => {
    setMode(next);
    setError(null);
    setInfo(null);
  };

  const handleEmailSubmit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (mode === "create") {
        const name = form.name.trim();
        const phone = form.phone.trim();
        const email = form.email.trim();
        // Stash the representative details for the post-verification flush.
        try {
          localStorage.setItem(PENDING_SIGNUP_KEY, JSON.stringify({ name, phone, email }));
        } catch {
          // Storage unavailable (private mode) — the wizard captures contact
          // details later; never block signup on this.
        }
        await createAccount({ name, email, password: form.password });
        navigate("/verify-email", { replace: true });
      } else {
        const user = await signInWithEmail(form.email.trim(), form.password);
        navigate(user.emailVerified ? "/live-feed" : "/verify-email", { replace: true });
      }
    } catch (e) {
      if (e && e.code === "auth/email-already-in-use") {
        setMode("signin");
      }
      setError(authErrorMessage(e));
      setBusy(false);
    }
  };

  const handleForgotPassword = async () => {
    if (busy) return;
    const email = form.email.trim();
    if (!email) {
      setError("Enter your email above first, then tap “Forgot password?”.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await sendPasswordReset(email);
      setInfo(`Password reset link sent to ${email} — check your inbox.`);
    } catch (e) {
      setError(authErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const handleGoogle = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const result = await signInWithGoogle();
      if (result) {
        navigate("/live-feed", { replace: true });
      }
      // If we fall through to redirect, the page is navigating away — leave
      // the button disabled until then.
    } catch (e) {
      setError(authErrorMessage(e));
      setBusy(false);
    }
  };

  const isCreate = mode === "create";

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

        {notice && (
          <p className="login-notice">
            <Icon name="check_circle" />
            {notice}
          </p>
        )}

        <div className="login-tabs" role="tablist" aria-label="Sign in or create account">
          <button
            type="button"
            role="tab"
            aria-selected={!isCreate}
            className={`login-tab${!isCreate ? " is-active" : ""}`}
            onClick={() => switchMode("signin")}
          >
            Sign in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={isCreate}
            className={`login-tab${isCreate ? " is-active" : ""}`}
            onClick={() => switchMode("create")}
          >
            Create account
          </button>
        </div>

        <p className="login-sub">
          {isCreate
            ? "Tell us who you are — then verify your email and set up your restaurant."
            : "Manage live tables, calls, and bookings — all in one place."}
        </p>

        <form onSubmit={handleEmailSubmit} className="login-form">
          {isCreate && (
            <>
              <label className="login-field">
                <span>Full name</span>
                <input
                  type="text"
                  className="login-input"
                  value={form.name}
                  onChange={set("name")}
                  autoComplete="name"
                  maxLength={120}
                  required
                />
              </label>
              <label className="login-field">
                <span>Mobile number</span>
                <input
                  type="tel"
                  className="login-input"
                  value={form.phone}
                  onChange={set("phone")}
                  autoComplete="tel"
                  placeholder="04xx xxx xxx"
                  maxLength={32}
                  required
                />
              </label>
            </>
          )}
          <label className="login-field">
            <span>{isCreate ? "Work email" : "Email"}</span>
            <input
              type="email"
              className="login-input"
              value={form.email}
              onChange={set("email")}
              autoComplete="email"
              maxLength={160}
              required
            />
          </label>
          <label className="login-field">
            <span>Password</span>
            <input
              type="password"
              className="login-input"
              value={form.password}
              onChange={set("password")}
              autoComplete={isCreate ? "new-password" : "current-password"}
              minLength={8}
              maxLength={128}
              required
            />
            {isCreate && <span className="login-field-hint">8+ characters</span>}
          </label>

          {!isCreate && (
            <button
              type="button"
              className="login-forgot"
              onClick={handleForgotPassword}
              disabled={busy}
            >
              Forgot password?
            </button>
          )}

          {error && (
            <div className="login-error" role="alert">
              <Icon name="error" />
              <span>{error}</span>
            </div>
          )}
          {info && (
            <p className="login-notice" role="status">
              <Icon name="check_circle" />
              {info}
            </p>
          )}

          <button type="submit" className="login-submit" disabled={busy}>
            {busy ? (
              <>
                <span className="login-spinner" aria-hidden="true" />
                <span>{isCreate ? "Creating your account…" : "Signing you in…"}</span>
              </>
            ) : (
              <span>{isCreate ? "Create account" : "Sign in"}</span>
            )}
          </button>
        </form>

        <div className="login-alt-divider" aria-hidden="true">
          <span>or</span>
        </div>

        <button onClick={handleGoogle} disabled={busy} className="login-google" type="button">
          <BrandMark brand="google" />
          <span>Continue with Google</span>
        </button>

        <div className="login-footer">
          <button onClick={() => navigate("/")} className="login-back" type="button">
            <Icon name="arrow_back" />
            Back to home
          </button>
          <p className="login-legal">
            By continuing, you agree to our{" "}
            <a href="https://biteperk.com.au/legal/terms/" target="_blank" rel="noreferrer">
              Terms
            </a>{" "}
            &amp;{" "}
            <a href="https://biteperk.com.au/legal/privacy/" target="_blank" rel="noreferrer">
              Privacy Policy
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  );
}
