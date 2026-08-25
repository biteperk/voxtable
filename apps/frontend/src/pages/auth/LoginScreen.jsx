import { useState } from "react";
import {
  createAccount,
  sendPasswordReset,
  signInWithEmail,
  signInWithGoogle
} from "../../firebase";
import { authErrorMessage } from "../../lib/authErrors";
import { PRIVACY_URL, TERMS_URL } from "../../lib/brand";
import { Icon } from "../../components/Icon";
import { BrandMark } from "../../components/brand/BrandMark";

// Representative details captured at signup, persisted server-side only after
// email verification (the backend refuses unverified accounts). AuthProvider
// flushes this stash to POST /api/me/contact on the first verified session.
// Never contains the password.
export const PENDING_SIGNUP_KEY = "vocotable.pendingSignup";

// Progressive "04xx xxx xxx" formatting while typing. Only formats numbers
// that look like local AU mobiles — anything else (e.g. +61…) passes through
// untouched so we never fight the user's own format.
function formatAuMobile(raw) {
  const digits = raw.replace(/\D/g, "");
  if (!raw.startsWith("0") || !digits.startsWith("04") || digits.length > 10) {
    return raw;
  }
  const parts = [digits.slice(0, 4), digits.slice(4, 7), digits.slice(7, 10)].filter(Boolean);
  return parts.join(" ");
}

// Pure heuristic, no deps: 0–4. Length is the dominant factor (NIST-style),
// variety nudges the score up.
function passwordStrength(password) {
  if (!password) return 0;
  let score = 0;
  if (password.length >= 8) score += 1;
  if (password.length >= 12) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (/\d/.test(password) || /[^a-zA-Z0-9]/.test(password)) score += 1;
  return score;
}

const STRENGTH_LABELS = ["", "Weak", "Fair", "Good", "Strong"];

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LoginScreen({ navigate, notice = null }) {
  const [mode, setMode] = useState("signin"); // "signin" | "create"
  const [form, setForm] = useState({ name: "", phone: "", email: "", password: "" });
  const [touched, setTouched] = useState({});
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null); // e.g. "reset link sent"
  const [busy, setBusy] = useState(false);

  const set = (field, transform) => (e) => {
    const value = transform ? transform(e.target.value) : e.target.value;
    setForm((prev) => ({ ...prev, [field]: value }));
  };
  const touch = (field) => () => setTouched((prev) => ({ ...prev, [field]: true }));

  const isCreate = mode === "create";

  // Inline, per-field validation — shown only after the field is touched, so
  // nobody gets yelled at mid-keystroke.
  const fieldErrors = {
    email:
      touched.email && form.email.trim() && !EMAIL_SHAPE.test(form.email.trim())
        ? "That email doesn't look right."
        : null,
    password:
      isCreate && touched.password && form.password && form.password.length < 8
        ? "At least 8 characters."
        : null,
    phone:
      isCreate && touched.phone && form.phone.trim() && form.phone.replace(/\D/g, "").length < 9
        ? "Enter an Australian mobile like 04xx xxx xxx."
        : null
  };

  const strength = passwordStrength(form.password);

  const switchMode = (next) => {
    setMode(next);
    setError(null);
    setInfo(null);
    setTouched({});
    setShowPassword(false);
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

  return (
    <div className="login-shell">
      <div className="login-bg-glow login-bg-glow-1" aria-hidden="true" />
      <div className="login-bg-glow login-bg-glow-2" aria-hidden="true" />

      <div className="login-card login-card-enter">
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
            ? "Set up your account — verify your email, then build your restaurant in minutes."
            : "Manage live tables, calls, and bookings — all in one place."}
        </p>

        <form onSubmit={handleEmailSubmit} className="login-form" key={mode}>
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
                  className={`login-input${fieldErrors.phone ? " is-invalid" : ""}`}
                  value={form.phone}
                  onChange={set("phone", formatAuMobile)}
                  onBlur={touch("phone")}
                  autoComplete="tel"
                  placeholder="04xx xxx xxx"
                  maxLength={32}
                  required
                />
                {fieldErrors.phone && (
                  <span className="login-field-error" role="alert">
                    {fieldErrors.phone}
                  </span>
                )}
              </label>
            </>
          )}
          <label className="login-field">
            <span>{isCreate ? "Work email" : "Email"}</span>
            <input
              type="email"
              className={`login-input${fieldErrors.email ? " is-invalid" : ""}`}
              value={form.email}
              onChange={set("email")}
              onBlur={touch("email")}
              autoComplete="email"
              maxLength={160}
              required
            />
            {fieldErrors.email && (
              <span className="login-field-error" role="alert">
                {fieldErrors.email}
              </span>
            )}
          </label>
          <label className="login-field">
            <span>Password</span>
            <div className="login-input-affix">
              <input
                type={showPassword ? "text" : "password"}
                className={`login-input${fieldErrors.password ? " is-invalid" : ""}`}
                value={form.password}
                onChange={set("password")}
                onBlur={touch("password")}
                autoComplete={isCreate ? "new-password" : "current-password"}
                minLength={8}
                maxLength={128}
                required
              />
              <button
                type="button"
                className="login-eye"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                tabIndex={-1}
              >
                <Icon name={showPassword ? "visibility_off" : "visibility"} />
              </button>
            </div>
            {fieldErrors.password && (
              <span className="login-field-error" role="alert">
                {fieldErrors.password}
              </span>
            )}
            {isCreate && form.password && (
              <div className="login-strength" aria-live="polite">
                <div className="login-strength-bars" aria-hidden="true">
                  {[1, 2, 3, 4].map((seg) => (
                    <span
                      key={seg}
                      className={`login-strength-seg${strength >= seg ? ` is-on lv-${strength}` : ""}`}
                    />
                  ))}
                </div>
                <span className={`login-strength-label lv-${strength}`}>
                  {STRENGTH_LABELS[strength]}
                </span>
              </div>
            )}
            {isCreate && !form.password && <span className="login-field-hint">8+ characters</span>}
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
              <span>{isCreate ? "Create your account" : "Sign in"}</span>
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
          {/* Deliberately a plain pointer, not an agreement claim: nothing on
              this screen records consent — the venue-side agreement_acceptances
              ledger is the legal instrument. */}
          <p className="login-legal">
            Read our{" "}
            <a href={TERMS_URL} target="_blank" rel="noreferrer">
              Terms
            </a>{" "}
            &amp;{" "}
            <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
              Privacy Policy
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  );
}
