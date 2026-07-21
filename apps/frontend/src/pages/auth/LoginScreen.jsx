import { useState } from "react";
import { signInWithGoogle } from "../../firebase";
import { Icon } from "../../components/Icon";
import { BrandMark } from "../../components/brand/BrandMark";

export function LoginScreen({ navigate }) {
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const handleSignIn = async () => {
    setBusy(true);
    setError(null);
    try {
      await signInWithGoogle();
      // If we fall through to redirect, the page is navigating away — leave
      // the button disabled until then.
    } catch (e) {
      const code = e && e.code;
      let msg = e.message ?? String(e);
      if (code === "auth/network-request-failed") {
        msg =
          "Couldn't reach Google sign-in. This is usually an ad blocker or " +
          "privacy extension blocking identitytoolkit.googleapis.com. Try " +
          "disabling extensions for this site, or use an incognito window.";
      }
      setError(msg);
      setBusy(false);
    }
  };

  return (
    <div className="login-shell">
      <div className="login-bg-glow login-bg-glow-1" aria-hidden="true" />
      <div className="login-bg-glow login-bg-glow-2" aria-hidden="true" />

      <div className="login-card">
        <img
          src="/brand/mark-light-on-dark.svg"
          alt="PerkTable"
          className="login-mark"
          width="56"
          height="56"
        />
        <h1 className="login-title">PerkTable</h1>
        <p className="login-tagline">Voice AI booking for restaurants</p>

        <div className="login-divider" aria-hidden="true" />

        <h2 className="login-heading">Sign in to your dashboard</h2>
        <p className="login-sub">Manage live tables, calls, and bookings — all in one place.</p>

        <button onClick={handleSignIn} disabled={busy} className="login-google" type="button">
          {busy ? (
            <>
              <span className="login-spinner" aria-hidden="true" />
              <span>Signing you in…</span>
            </>
          ) : (
            <>
              <BrandMark brand="google" />
              <span>Continue with Google</span>
            </>
          )}
        </button>

        {error && (
          <div className="login-error" role="alert">
            <Icon name="error" />
            <span>{error}</span>
          </div>
        )}

        <p className="login-coming-soon">
          More sign-in methods coming soon — Apple, email & password.
        </p>

        <div className="login-footer">
          <button onClick={() => navigate("/")} className="login-back" type="button">
            <Icon name="arrow_back" />
            Back to home
          </button>
          <p className="login-legal">
            By continuing, you agree to our Terms & Privacy Policy.
          </p>
        </div>
      </div>
    </div>
  );
}



