import { useEffect, useState } from "react";

import { getAdminFlags } from "../../api";
import { useAuth } from "../../auth";
import { ToastProvider } from "../../components/admin/Toast";
import { BiteperkMark } from "../../components/brand/BiteperkMark";
import { Icon } from "../../components/Icon";
import { signOutUser } from "../../firebase";
import { AdminJobs } from "./AdminJobs";
import { AdminOps } from "./AdminOps";
import { AdminOverview } from "./AdminOverview";
import { AdminSupport } from "./AdminSupport";
import { AdminVenues } from "./AdminVenues";

// Platform-admin console (BitePerk staff). Deliberately NOT DashboardShell:
// the sidebar there is membership-role-gated and renders empty for a staff
// account with no restaurant membership. This shell is standalone and
// cross-tenant. The page's code ships in the public bundle — every ounce of
// authority lives in the /api/admin responses, not here.
const SECTIONS = [
  ["Overview", "monitoring", "/admin"],
  ["Venues", "storefront", "/admin/venues"],
  ["Provisioning", "phone_forwarded", "/admin/jobs"],
  ["Ops", "activity_zone", "/admin/ops"],
  ["Support", "contact_support", "/admin/support"]
];

export function AdminPage({ navigate, path }) {
  const { user, memberships } = useAuth();
  // The gate probe: flags is the cheapest admin endpoint (no DB). 403/503
  // become the friendly full-page states; success proves admin access and
  // gives the environment badge in one call.
  const [gate, setGate] = useState({ loading: true, error: null, flags: null });

  useEffect(() => {
    let cancelled = false;
    getAdminFlags()
      .then((flags) => {
        if (!cancelled) setGate({ loading: false, error: null, flags });
      })
      .catch((e) => {
        if (!cancelled) setGate({ loading: false, error: e, flags: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSignOut = async () => {
    await signOutUser();
    navigate("/");
  };

  if (gate.loading) {
    return (
      <div className="admin-shell">
        <AdminHeader user={user} memberships={memberships} navigate={navigate} onSignOut={handleSignOut} />
        <main className="admin-main">
          <p className="admin-muted">Loading…</p>
        </main>
      </div>
    );
  }

  if (gate.error) {
    const code = gate.error.code;
    return (
      <div className="admin-shell">
        <AdminHeader user={user} memberships={memberships} navigate={navigate} onSignOut={handleSignOut} />
        <main className="admin-main">
          <div className="onboarding-card admin-gate-card">
            {code === "ADMIN_ROLE_REQUIRED" ? (
              <>
                <h2>This page is for BitePerk staff</h2>
                <p className="admin-muted">
                  Your account isn't on the platform-admin list. If you should be, ask for your
                  email to be added to the admin allowlist.
                </p>
              </>
            ) : code === "ADMIN_ROLE_NOT_CONFIGURED" ? (
              <>
                <h2>Admin access isn't configured here</h2>
                <p className="admin-muted">
                  This environment has no admin allowlist set, so the admin console can't answer.
                </p>
              </>
            ) : (
              <>
                <h2>Couldn't load the admin console</h2>
                <p className="admin-muted">{gate.error.message ?? "Something went wrong."}</p>
              </>
            )}
            {memberships.length > 0 ? (
              <button className="primary-button" onClick={() => navigate("/live-tables")}>
                Back to the dashboard
              </button>
            ) : null}
          </div>
        </main>
      </div>
    );
  }

  const active =
    SECTIONS.find(([, , route]) => route !== "/admin" && path.startsWith(route))?.[0] ?? "Overview";
  const flags = gate.flags;

  return (
    <ToastProvider>
    <div className="admin-shell">
      <AdminHeader
        user={user}
        memberships={memberships}
        navigate={navigate}
        onSignOut={handleSignOut}
        appEnv={flags?.app_env}
        appVersion={flags?.app_version}
      />
      <nav className="admin-nav" aria-label="Admin sections">
        {SECTIONS.map(([label, icon, route]) => (
          <button
            key={label}
            type="button"
            className={active === label ? "active" : ""}
            aria-current={active === label ? "page" : undefined}
            onClick={() => navigate(route)}
          >
            <Icon name={icon} fill={active === label} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <main className="admin-main">
        {active === "Overview" ? <AdminOverview flags={flags} /> : null}
        {active === "Venues" ? <AdminVenues /> : null}
        {active === "Provisioning" ? <AdminJobs /> : null}
        {active === "Ops" ? <AdminOps /> : null}
        {active === "Support" ? <AdminSupport /> : null}
      </main>
    </div>
    </ToastProvider>
  );
}

function AdminHeader({ user, memberships, navigate, onSignOut, appEnv, appVersion }) {
  return (
    <header className="admin-header">
      <div className="admin-header-brand">
        <BiteperkMark size={34} />
        <span className="admin-wordmark">
          {/* The company wordmark is two parts by brand rule: bite + gold italic perk. */}
          bite<span className="admin-wordmark-perk">perk</span>
        </span>
        <span className="admin-eyebrow">Vox platform admin</span>
        {appEnv ? (
          <span className={`admin-env-badge ${appEnv === "production" ? "is-production" : ""}`}>
            {appEnv}
            {appVersion ? ` · v${appVersion}` : ""}
          </span>
        ) : null}
      </div>
      <div className="admin-header-actions">
        <span className="admin-muted">{user?.email ?? ""}</span>
        {memberships.length > 0 ? (
          <button className="ghost-button" type="button" onClick={() => navigate("/live-tables")}>
            Back to dashboard
          </button>
        ) : null}
        <button className="ghost-button" type="button" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </header>
  );
}
