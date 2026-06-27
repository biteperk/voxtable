import { useEffect, useState } from "react";
import { useAuth } from "../../auth";
import { getInviteInfo, acceptStaffInvite } from "../../api";
import { signInWithGoogle } from "../../firebase";
import { Icon } from "../../components/Icon";

const ROLE_LABELS = {
  owner: "Owner",
  manager: "Manager",
  server: "Server",
  kitchen: "Kitchen",
  staff: "Staff"
};

export function AcceptInvitePage({ navigate }) {
  const { user, loading: authLoading, refreshMe } = useAuth();
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [accepting, setAccepting] = useState(false);
  const [accepted, setAccepted] = useState(false);

  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");

  useEffect(() => {
    if (!token) {
      setError("No invite token provided.");
      setLoading(false);
      return;
    }
    getInviteInfo(token)
      .then(setInfo)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [token]);

  const handleAccept = async () => {
    if (!token) return;
    setAccepting(true);
    setError(null);
    try {
      await acceptStaffInvite(token);
      setAccepted(true);
      await refreshMe();
    } catch (e) {
      setError(e.message);
    } finally {
      setAccepting(false);
    }
  };

  const handleSignIn = async () => {
    try {
      await signInWithGoogle();
    } catch (e) {
      setError(e.message);
    }
  };

  // Auto-accept after sign-in if we have the token and info
  useEffect(() => {
    if (user && info && token && !accepted && !accepting) {
      handleAccept();
    }
  }, [user, info, token]);

  if (loading || authLoading) {
    return (
      <div className="accept-invite-shell">
        <div className="accept-invite-card">
          <p style={{ color: "var(--on-surface-variant)" }}>Loading invite…</p>
        </div>
      </div>
    );
  }

  if (!token || error) {
    return (
      <div className="accept-invite-shell">
        <div className="accept-invite-card">
          <Icon name="error" style={{ fontSize: "2.5rem", color: "#ef4444" }} />
          <h2>Invalid Invite</h2>
          <p>{error || "This invite link is invalid or has expired."}</p>
          <button type="button" onClick={() => navigate("/")}>
            Go to home
          </button>
        </div>
      </div>
    );
  }

  if (accepted) {
    return (
      <div className="accept-invite-shell">
        <div className="accept-invite-card">
          <Icon name="check_circle" style={{ fontSize: "2.5rem", color: "var(--primary, #6ee7b7)" }} />
          <h2>You're in!</h2>
          <p>
            You've joined <strong>{info?.restaurant_name}</strong> as a{" "}
            <strong>{ROLE_LABELS[info?.role] || info?.role}</strong>.
          </p>
          <button type="button" onClick={() => navigate("/live-feed")}>
            Go to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="accept-invite-shell">
      <div className="accept-invite-card">
        <img
          src="/brand/mark-light-on-dark.svg"
          alt=""
          width="48"
          height="48"
          style={{ marginBottom: "0.5rem" }}
        />
        <h2>You're invited!</h2>
        <p>
          <strong>{info?.inviter_name || info?.inviter_email}</strong> invited you to join
        </p>
        <div className="accept-invite-restaurant">
          <strong>{info?.restaurant_name}</strong>
          <span className="accept-invite-role">
            as {ROLE_LABELS[info?.role] || info?.role}
          </span>
        </div>

        {!user ? (
          <>
            <p style={{ fontSize: "0.8125rem", color: "var(--on-surface-variant)" }}>
              Sign in with Google to accept this invite.
            </p>
            <button type="button" className="accept-invite-google" onClick={handleSignIn}>
              <svg width="18" height="18" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              Sign in with Google
            </button>
          </>
        ) : (
          <>
            {accepting ? (
              <p style={{ color: "var(--on-surface-variant)" }}>Joining…</p>
            ) : (
              <button type="button" onClick={handleAccept}>
                <Icon name="check" /> Accept Invite
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
