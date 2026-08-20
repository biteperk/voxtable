// Sentry instrumentation must initialise before anything else mounts, so it is
// imported first (the module runs Sentry.init as an import side-effect).
import { captureException } from "./sentry";
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { AuthProvider, useAuth } from "./auth";
import { PHONE_DISPLAY, PHONE_HREF } from "./lib/brand";
import { getOnboardingStatus } from "./api";
import { LandingPage } from "./pages/landing/LandingPage";
import { LiveFeedOverviewPage } from "./pages/dashboard/LiveFeedOverviewPage";
import { LiveFeedDetailPage } from "./pages/dashboard/LiveFeedDetailPage";
import { BookingLogPage } from "./pages/dashboard/BookingLogPage";
import { LiveTablesPage } from "./pages/dashboard/LiveTablesPage";
import { TableOrderPage } from "./pages/dashboard/TableOrderPage";
import { ManageMenuPage } from "./pages/dashboard/ManageMenuPage";
import { ManageTablesPage } from "./pages/dashboard/ManageTablesPage";
import { KitchenOverviewPage } from "./pages/dashboard/KitchenOverviewPage";
import { AnalyticsPage } from "./pages/dashboard/AnalyticsPage";
import { ProfilePage } from "./pages/dashboard/ProfilePage";
import { BillingPage } from "./pages/billing/BillingPage";
import { ManagePlanPage } from "./pages/billing/ManagePlanPage";
import { UpdatePaymentDetailsPage } from "./pages/billing/UpdatePaymentDetailsPage";
import { OnboardingWizard } from "./pages/onboarding/OnboardingWizard";
import { LoginScreen } from "./pages/auth/LoginScreen";
import { VerifyEmailScreen } from "./pages/auth/VerifyEmailScreen";
import { AcceptInvitePage } from "./pages/auth/AcceptInvitePage";
import { OrderReturnPage } from "./pages/public/OrderReturnPage";
import { AdminPage } from "./pages/admin/AdminPage";



/**
 * Top-level error boundary. Audit Sweep E — without this, a single render
 * error in ANY page component (LiveFeedOverview, BookingLog, Analytics, etc.)
 * crashes the whole SPA to a white screen. The dashboard renders arbitrary
 * DB data (customer names, notes); one row with an unexpected null on a
 * non-coalesced field would take down the staff's only tool during dinner
 * service. This is the floor.
 *
 * On error: log structured to console (Sweep D logger upgrade is backend-only
 * for now; frontend still uses console), show a friendly recovery card with
 * the restaurant phone number, and offer a "reload" action.
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Dev-only console logging — raw error text can carry PII, so keep it out of
    // production consoles. Sentry (below) is the production capture path.
    if (import.meta.env.DEV) {
      console.error("[vocotable] uncaught render error:", {
        message: error?.message,
        stack: error?.stack?.split("\n").slice(0, 6).join("\n"),
        componentStack: info?.componentStack?.split("\n").slice(0, 6).join("\n")
      });
    }
    // Forward to Sentry. No-op when VITE_SENTRY_DSN is unset.
    captureException(error, { componentStack: info?.componentStack });
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary-shell" role="alert" aria-live="assertive">
          <div className="error-boundary-card">
            <h1>Something went wrong</h1>
            <p>
              The page hit an unexpected error. Try reloading — if it keeps happening,
              please call us on <a href={PHONE_HREF}>{PHONE_DISPLAY}</a>.
            </p>
            <p className="error-boundary-detail">
              {this.state.error?.message?.slice(0, 200) || "Unknown error"}
            </p>
            <div className="error-boundary-actions">
              <button type="button" onClick={() => window.location.reload()}>
                Reload page
              </button>
              <button type="button" className="ghost" onClick={this.reset}>
                Try to continue
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const titles = {
      "/": "VoxTable",
      "/live-feed": "Live Feed · VoxTable",
      "/booking-log": "Booking Log · VoxTable",
      "/manage-menu": "Manage Menu · VoxTable",
      "/manage-tables": "Manage Tables · VoxTable",
      "/kitchen-overview": "Kitchen Overview · VoxTable",
      "/live-tables": "Live Tables · VoxTable",
      "/analytics": "Analytics · VoxTable",
      "/billing": "Billing · VoxTable",
      "/manage-plan": "Manage Plan · VoxTable",
      "/update-payment-details": "Payment Methods · VoxTable",
      "/profile": "Profile · VoxTable",
      "/onboarding": "Get started · VoxTable",
      "/verify-email": "Verify your email · VoxTable",
      "/admin": "Admin · VoxTable",
      "/admin/venues": "Admin · VoxTable",
      "/admin/jobs": "Admin · VoxTable",
      "/admin/ops": "Admin · VoxTable",
      "/admin/support": "Admin · VoxTable",
      "/order/paid": "Payment received",
      "/order/cancelled": "Payment not completed",
    };
    if (/^\/live-feed\/[^/]+$/.test(path)) {
      document.title = "Call detail · VoxTable";
    } else {
      document.title = titles[path] || "VoxTable";
    }
  }, [path]);

  // `replace` swaps the current history entry instead of pushing a new one. Use
  // it for *automatic* redirects (onboarding gate, role guard) so they never
  // leave a phantom entry that the browser Back button lands on and that then
  // immediately re-redirects — the classic "Back doesn't go where I expect"
  // bug. User-initiated navigation keeps pushing so Back walks the real trail.
  const navigate = (nextPath, { replace = false } = {}) => {
    if (replace) {
      window.history.replaceState({}, "", nextPath);
    } else {
      window.history.pushState({}, "", nextPath);
    }
    setPath(nextPath);
  };

  const isDashboard =
    path === "/live-feed" ||
    path.startsWith("/live-feed/") ||
    path === "/live-tables" ||
    path.startsWith("/live-tables/") ||
    path === "/booking-log" ||
    path === "/manage-menu" ||
    path === "/manage-tables" ||
    path === "/kitchen-overview" ||
    path === "/analytics" ||
    path === "/billing" ||
    path === "/manage-plan" ||
    path === "/update-payment-details" ||
    path === "/profile" ||
    path === "/onboarding" ||
    path.startsWith("/onboarding/");

  return (
    <AuthProvider>
      <AppRouter
        path={path}
        navigate={navigate}
        isDashboard={isDashboard}
      />
    </AuthProvider>
  );
}

// Fetches the active restaurant's onboarding status so the router can gate the
// dashboard. Returns { loading, status }. status is null when the user has no
// restaurant yet (→ they need to start onboarding). Re-fetches when the user's
// memberships change (e.g. just after creating their restaurant).
function useOnboardingGate() {
  const { user, meLoading, memberships } = useAuth();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setStatus(null);
      setLoading(false);
      return;
    }
    if (meLoading) {
      setLoading(true);
      return;
    }
    setLoading(true);

    // On a hard refresh the first status fetch can lose a race with Firebase
    // token propagation and reject. For a user who HAS a restaurant that is a
    // transient failure, not "needs onboarding" — so retry a few times with a
    // short backoff before giving up, rather than resolving to null (which used
    // to bounce a real member to /onboarding → /live-feed off the page they
    // were actually on, e.g. a hard refresh of /profile).
    let attempt = 0;
    const run = () => {
      getOnboardingStatus()
        .then((r) => {
          if (cancelled) return;
          setStatus(r?.onboarding_status ?? null);
          setLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          if (memberships.length > 0 && attempt < 3) {
            attempt += 1;
            setTimeout(run, 400 * attempt);
            return;
          }
          // Legit 403 NO_RESTAURANT_MEMBERSHIP (no restaurant yet) or exhausted
          // retries → status unknown/none.
          setStatus(null);
          setLoading(false);
        });
    };
    run();

    return () => {
      cancelled = true;
    };
  }, [user, meLoading, memberships]);

  useEffect(() => {
    const onChanged = (event) => {
      const nextStatus = event.detail?.status;
      if (typeof nextStatus === "string") {
        setStatus(nextStatus);
        setLoading(false);
      }
    };
    window.addEventListener("vocotable:onboarding-status-changed", onChanged);
    return () => window.removeEventListener("vocotable:onboarding-status-changed", onChanged);
  }, []);

  return { loading, status };
}

// Role-based route visibility. Kitchen and server are orthogonal (not a single
// rank ladder): kitchen sees only the kitchen surface, server sees front-of-
// house, manager+ sees everything. Returns the path to redirect to, or null if
// the current path is allowed for the role. Pure — the caller navigates from an
// effect, never during render.
const KITCHEN_ROUTES = ["/kitchen-overview", "/profile"];
const SERVER_ROUTES = ["/live-feed", "/booking-log", "/live-tables", "/profile"];

function roleRouteRedirect(path, role) {
  const allowed = role === "server" ? SERVER_ROUTES : KITCHEN_ROUTES;
  const isAllowed = allowed.some((r) => path === r || path.startsWith(r + "/"));
  if (isAllowed) return null;
  return role === "kitchen" ? "/kitchen-overview" : "/live-feed";
}

function AppRouter({ path, navigate, isDashboard }) {
  const { user, loading, hasMinRole, memberships, meLoading } = useAuth();
  const isOnboarding = path === "/onboarding" || path.startsWith("/onboarding/");
  const isInvite = path === "/invite";
  const isVerifyEmail = path === "/verify-email";
  // Platform-admin console. Deliberately OUTSIDE isDashboard: the tenant and
  // onboarding gates below would redirect a membership-less staff account to
  // /onboarding and hold the page on an infinite loader. Auth is still
  // enforced (and the backend re-checks the admin allowlist on every call).
  const isAdminPath = path === "/admin" || path.startsWith("/admin/");
  // Stripe Checkout return pages for guest order payments. Fully public (the
  // guest has no account) — must render before any auth/onboarding gate.
  const isOrderReturn = path === "/order/paid" || path === "/order/cancelled";
  const gate = useOnboardingGate();

  // Gate redirects — only after auth + gate are resolved, and only ever toward
  // the correct surface (no flicker, no loop): an incomplete tenant on a
  // dashboard route goes to /onboarding; a live tenant sitting on /onboarding
  // goes to the dashboard.
  // The menu editor is reachable during onboarding so the owner can build their
  // menu (the "Add your menu" step links here), then return to the wizard.
  const allowDuringOnboarding = path === "/manage-menu";

  // A tenant whose payment lapsed ("suspended") has ALREADY finished the wizard
  // — their only problem is their card. Sending them to /onboarding drops them
  // into the first-run wizard, where every step they submit is rejected: a hard
  // lockout for a customer who wants to pay us. Send them to billing instead.
  const isSuspended = gate.status === "suspended";
  const isBillingRoute =
    path === "/manage-plan" || path === "/update-payment-details" || path === "/billing";

  useEffect(() => {
    if (!user || loading || meLoading || !isDashboard || gate.loading) return;
    const isLive = gate.status === "live";
    if (isSuspended) {
      if (!isBillingRoute) navigate("/manage-plan", { replace: true });
      return;
    }
    if (isOnboarding) {
      // Leave the wizard only once we KNOW the tenant is live AND the user
      // actually belongs to a restaurant. A member-less account stays on the
      // wizard no matter what the status endpoint claims — otherwise an
      // inconsistent backend state (e.g. the legacy-fallback leak) ping-pongs
      // this redirect against the !hasRestaurant one below, forever.
      if (isLive && memberships.length > 0) navigate("/live-feed", { replace: true });
      return;
    }
    // On a dashboard route, only send the user to onboarding when we're
    // CONFIDENT they still need it: no restaurant at all, or a definitively
    // non-live status. A null status (a failed/racey status fetch on a hard
    // refresh) is "unknown" — it must NOT bounce a real member off their page.
    const hasRestaurant = memberships.length > 0;
    const knownIncomplete = gate.status !== null && !isLive;
    if ((!hasRestaurant || knownIncomplete) && !allowDuringOnboarding) {
      navigate("/onboarding", { replace: true });
    }
  }, [user, loading, meLoading, isDashboard, isOnboarding, gate.loading, gate.status, memberships, allowDuringOnboarding, isSuspended, isBillingRoute, navigate]);

  // Role-based route guard. Compute the redirect target purely; the effect below
  // does the navigation (never navigate during render). Only meaningful once
  // auth + the onboarding gate have resolved, so the role is known and stable.
  const roleRedirect =
    isDashboard &&
    !isOnboarding &&
    !isInvite &&
    user &&
    !loading &&
    !gate.loading &&
    gate.status === "live" &&
    !hasMinRole("manager")
      ? roleRouteRedirect(path, hasMinRole("server") ? "server" : "kitchen")
      : null;

  useEffect(() => {
    if (roleRedirect) navigate(roleRedirect, { replace: true });
  }, [roleRedirect, navigate]);

  if (isOrderReturn) {
    return <OrderReturnPage outcome={path === "/order/paid" ? "paid" : "cancelled"} />;
  }

  // /invite?token=xxx is outside dashboard/onboarding gates so new staff can join first.
  if (isInvite) {
    return <AcceptInvitePage navigate={navigate} />;
  }

  // Platform-admin console (BitePerk staff). Auth-gated here, admin-gated by
  // the backend on every call — a non-admin sees the page's friendly 403 state.
  if (isAdminPath) {
    if (loading) return <FullPageMessage title="Loading..." />;
    if (!user) return <LoginScreen navigate={navigate} />;
    if (!user.emailVerified) return <VerifyEmailScreen navigate={navigate} />;
    return <AdminPage navigate={navigate} path={path} />;
  }

  // /verify-email is the continue-URL Firebase's action handler bounces back
  // to after the user clicks the emailed link. Outside the dashboard gates:
  // the link may be opened on a device with no session (phone), in which case
  // the user just signs in and the verified account sails through.
  if (isVerifyEmail) {
    if (loading) return <FullPageMessage title="Loading..." />;
    if (!user) {
      return <LoginScreen navigate={navigate} notice="Email verified — sign in to continue." />;
    }
    if (user.emailVerified) {
      // Already verified (e.g. revisit) — nothing to do here.
      navigate("/onboarding", { replace: true });
      return <FullPageMessage title="Loading..." />;
    }
    return <VerifyEmailScreen navigate={navigate} />;
  }

  if (isDashboard && loading) {
    return <FullPageMessage title="Loading..." />;
  }

  if (isDashboard && !user) {
    return <LoginScreen navigate={navigate} />;
  }

  // A signed-in but unverified account (email/password signup mid-funnel, or
  // the rare unverified-Google case) must verify before anything else — the
  // backend 403s every call anyway; without this gate the wizard renders
  // broken and silent.
  if (isDashboard && user && !user.emailVerified) {
    return <VerifyEmailScreen navigate={navigate} />;
  }

  // Hold dashboard surfaces until we can route confidently, so an incomplete
  // tenant never flashes the dashboard (and vice-versa). A signed-in member
  // with a restaurant renders even when the onboarding-status fetch is still
  // pending OR failed (unknown) — they're entitled to the page; only a member-
  // less account or a *known* incomplete tenant is held here (then redirected
  // by the effect above).
  if (isDashboard && gate.loading) {
    return <FullPageMessage title="Loading..." />;
  }

  if (isOnboarding) {
    return <OnboardingWizard navigate={navigate} path={path} />;
  }

  // Incomplete onboarding on a dashboard route: the effect above is redirecting
  // to /onboarding — render a neutral loader rather than the locked dashboard.
  // Routes flagged allowDuringOnboarding (the menu editor) must still render,
  // otherwise MenuStep's "Add manually" link lands on an infinite loader.
  // Billing routes must render for a suspended tenant — that's where the effect
  // above just sent them, and it's the one place they can fix their card.
  const tenantKnownIncomplete =
    gate.status !== null && gate.status !== "live" && !(isSuspended && isBillingRoute);
  if (isDashboard && (memberships.length === 0 || (tenantKnownIncomplete && !allowDuringOnboarding))) {
    return <FullPageMessage title="Loading..." />;
  }

  // A non-manager on a surface their role can't see is being redirected by the
  // effect above — show a neutral loader meanwhile so the disallowed page never
  // flashes (and never fires its data fetch).
  if (roleRedirect) {
    return <FullPageMessage title="Loading..." />;
  }

  // /live-feed/<id> — detail page for a single call (id is uuid)
  const detailMatch = path.match(/^\/live-feed\/([^/]+)$/);
  if (detailMatch && detailMatch[1] !== "detail") {
    return <LiveFeedDetailPage navigate={navigate} callId={detailMatch[1]} path={path} />;
  }
  // legacy mock route — keep for backward compatibility, navigates back to list
  if (path === "/live-feed/detail") return <LiveFeedOverviewPage navigate={navigate} path={path} />;

  if (path === "/live-feed") return <LiveFeedOverviewPage navigate={navigate} path={path} />;
  const tableDetailMatch = path.match(/^\/live-tables\/([^/]+)$/);
  if (tableDetailMatch) {
    return (
      <TableOrderPage
        navigate={navigate}
        path={path}
        tableLabel={decodeURIComponent(tableDetailMatch[1])}
      />
    );
  }
  if (path === "/live-tables") return <LiveTablesPage navigate={navigate} path={path} />;
  if (path === "/booking-log") return <BookingLogPage navigate={navigate} path={path} />;
  if (path === "/manage-menu") return <ManageMenuPage navigate={navigate} path={path} />;
  if (path === "/manage-tables") return <ManageTablesPage navigate={navigate} path={path} />;
  if (path === "/kitchen-overview") return <KitchenOverviewPage navigate={navigate} path={path} />;
  if (path === "/analytics") return <AnalyticsPage navigate={navigate} path={path} />;
  if (path === "/billing")
    return <BillingPage navigate={navigate} path={path} />;
  if (path === "/manage-plan")
    return <ManagePlanPage navigate={navigate} path={path} subscriptionLapsed={isSuspended} />;
  if (path === "/update-payment-details")
    return <UpdatePaymentDetailsPage navigate={navigate} path={path} />;
  if (path === "/profile") return <ProfilePage navigate={navigate} path={path} />;

  // Public marketing home.
  if (path === "/") return <LandingPage navigate={navigate} />;

  // Unrecognised path. For a *signed-in* user this almost always means a stale or
  // mistyped in-app link (e.g. a dead "/settings" route) — and silently rendering
  // the public LandingPage here is exactly what made those feel like "the Back
  // button threw me to the homepage". Show a recoverable in-app 404 instead, and
  // only let genuinely-public (logged-out) visitors fall through to the landing.
  if (user) return <NotFoundPage navigate={navigate} />;
  return <LandingPage navigate={navigate} />;
}

function FullPageMessage({ title }) {
  return (
    <div style={{ display: "grid", placeItems: "center", minHeight: "100vh", color: "#cbd5e1" }}>
      <p style={{ fontSize: 20 }}>{title}</p>
    </div>
  );
}

// Shown when a signed-in user lands on an unknown route. Recoverable by design:
// a clear path back into the dashboard (the role guard will steer kitchen/server
// users to their own home) instead of the dead-end of the public landing page.
function NotFoundPage({ navigate }) {
  return (
    <div
      style={{ display: "grid", placeItems: "center", minHeight: "100vh", color: "#cbd5e1", padding: 24 }}
      role="alert"
    >
      <div style={{ textAlign: "center", maxWidth: 420 }}>
        <p style={{ fontSize: 48, margin: 0, lineHeight: 1 }}>404</p>
        <h1 style={{ fontSize: 22, margin: "12px 0 8px" }}>Page not found</h1>
        <p style={{ color: "#94a3b8", margin: "0 0 20px" }}>
          That page doesn’t exist. The link may be out of date.
        </p>
        <button
          type="button"
          onClick={() => navigate("/live-feed")}
          style={{
            padding: "10px 18px",
            borderRadius: 10,
            border: "none",
            background: "#6366f1",
            color: "#fff",
            fontSize: 15,
            cursor: "pointer"
          }}
        >
          Back to dashboard
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
