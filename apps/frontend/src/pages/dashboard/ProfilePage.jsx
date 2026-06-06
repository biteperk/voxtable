import { useAuth } from "../../auth";
import { signOutUser } from "../../firebase";
import { Icon } from "../../components/Icon";
import { BrandMark } from "../../components/brand/BrandMark";
import { DashboardShell } from "./DashboardShell";
import { restaurantImage } from "../../lib/constants";

export function ProfilePage({ navigate }) {
  const { user } = useAuth();

  const handleSignOut = async () => {
    await signOutUser();
    navigate("/");
  };

  const signInMethods = [
    {
      id: "google",
      label: "Google",
      description: user?.email ?? "Connected via Google",
      brand: "google",
      connected: true,
      primary: true
    },
    {
      id: "apple",
      label: "Apple",
      description: "Sign in with your Apple ID",
      brand: "apple",
      connected: false,
      comingSoon: true
    },
    {
      id: "email",
      label: "Email & password",
      description: "Use a dedicated email and password",
      brand: "email",
      connected: false,
      comingSoon: true
    }
  ];

  return (
    <DashboardShell active="Profile" navigate={navigate}>
      <header className="operational-header">
        <div>
          <h1>My Profile</h1>
          <p>Manage your account and how you sign in to VocoTable.</p>
        </div>
      </header>

      <section className="profile-grid">
        <article className="profile-identity-card">
          <img
            className="profile-avatar"
            src={user?.photoURL ?? restaurantImage}
            alt=""
          />
          <div className="profile-identity-text">
            <strong>{user?.displayName ?? "User"}</strong>
            <span>{user?.email ?? ""}</span>
            <span className="profile-session-pill">
              <i className="profile-session-dot" />
              Active session — signed in with Google
            </span>
          </div>
        </article>

        <article className="profile-card">
          <header>
            <h2>Sign-in methods</h2>
            <p>Choose how you want to access VocoTable. You can connect multiple providers.</p>
          </header>
          <ul className="signin-method-list">
            {signInMethods.map((m) => (
              <li key={m.id} className={`signin-method-row ${m.comingSoon ? "disabled" : ""}`}>
                <div className={`signin-method-icon brand-${m.brand}`}>
                  {m.brand === "email" ? <Icon name="mail" /> : <BrandMark brand={m.brand} />}
                </div>
                <div className="signin-method-text">
                  <strong>{m.label}</strong>
                  <span>{m.description}</span>
                </div>
                <div className="signin-method-action">
                  {m.connected && <span className="signin-pill active">Connected · Active</span>}
                  {m.comingSoon && <span className="signin-pill muted">Coming soon</span>}
                </div>
              </li>
            ))}
          </ul>
        </article>

        <article className="profile-card">
          <header>
            <h2>Account</h2>
            <p>Manage profile photo, name, and password through your Google account.</p>
          </header>
          <a
            className="profile-action-row"
            href="https://myaccount.google.com"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon name="open_in_new" />
            <div>
              <strong>Manage Google Account</strong>
              <span>Update photo, name, password, and 2-factor settings</span>
            </div>
            <Icon name="chevron_right" className="profile-action-chevron" />
          </a>
          <button className="profile-action-row danger" type="button" onClick={handleSignOut}>
            <Icon name="logout" />
            <div>
              <strong>Sign out</strong>
              <span>End your session on this device</span>
            </div>
            <Icon name="chevron_right" className="profile-action-chevron" />
          </button>
        </article>
      </section>
    </DashboardShell>
  );
}
