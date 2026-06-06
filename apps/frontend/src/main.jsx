// Sentry instrumentation must initialise before anything else mounts, so it is
// imported first (the module runs Sentry.init as an import side-effect).
import { captureException } from "./sentry";
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { AuthProvider, useAuth } from "./auth";
import { getOnboardingStatus } from "./api";
import { LandingPage } from "./pages/landing/LandingPage";
import { LiveFeedOverviewPage } from "./pages/dashboard/LiveFeedOverviewPage";
import { LiveFeedDetailPage } from "./pages/dashboard/LiveFeedDetailPage";
import { BookingLogPage } from "./pages/dashboard/BookingLogPage";
import { LiveTablesPage } from "./pages/dashboard/LiveTablesPage";
import { TableOrderPage } from "./pages/dashboard/TableOrderPage";
import { ManageMenuPage } from "./pages/dashboard/ManageMenuPage";
import { KitchenOverviewPage } from "./pages/dashboard/KitchenOverviewPage";
import { AnalyticsPage } from "./pages/dashboard/AnalyticsPage";
import { ProfilePage } from "./pages/dashboard/ProfilePage";
import { BillingPage } from "./pages/billing/BillingPage";
import { ManagePlanPage } from "./pages/billing/ManagePlanPage";
import { UpdatePaymentDetailsPage } from "./pages/billing/UpdatePaymentDetailsPage";
import { OnboardingWizard } from "./pages/onboarding/OnboardingWizard";
import { LoginScreen } from "./pages/auth/LoginScreen";



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
    // eslint-disable-next-line no-console
    console.error("[vocotable] uncaught render error:", {
      message: error?.message,
      stack: error?.stack?.split("\n").slice(0, 6).join("\n"),
      componentStack: info?.componentStack?.split("\n").slice(0, 6).join("\n")
    });
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
              please call us on <a href="tel:+61275011140">+61 2 7501 1140</a>.
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
      "/": "VocoTable",
      "/live-feed": "Live Feed · VocoTable",
      "/booking-log": "Booking Log · VocoTable",
      "/manage-menu": "Manage Menu · VocoTable",
      "/kitchen-overview": "Kitchen Overview · VocoTable",
      "/analytics": "Analytics · VocoTable",
      "/settings": "Settings · VocoTable",
    };
    if (/^\/live-feed\/[^/]+$/.test(path)) {
      document.title = "Call detail · VocoTable";
    } else {
      document.title = titles[path] || "VocoTable";
    }
  }, [path]);

  const navigate = (nextPath) => {
    window.history.pushState({}, "", nextPath);
    setPath(nextPath);
  };

  const isDashboard =
    path === "/live-feed" ||
    path.startsWith("/live-feed/") ||
    path === "/live-tables" ||
    path.startsWith("/live-tables/") ||
    path === "/booking-log" ||
    path === "/manage-menu" ||
    path === "/kitchen-overview" ||
    path === "/analytics" ||
    path === "/settings" ||
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
    getOnboardingStatus()
      .then((r) => {
        if (!cancelled) setStatus(r?.onboarding_status ?? null);
      })
      .catch(() => {
        // 403 NO_RESTAURANT_MEMBERSHIP (no restaurant yet) or transient → null.
        if (!cancelled) setStatus(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user, meLoading, memberships]);

  return { loading, status };
}

function AppRouter({ path, navigate, isDashboard }) {
  const { user, loading } = useAuth();
  const isOnboarding = path === "/onboarding" || path.startsWith("/onboarding/");
  const gate = useOnboardingGate();

  // Gate redirects — only after auth + gate are resolved, and only ever toward
  // the correct surface (no flicker, no loop): an incomplete tenant on a
  // dashboard route goes to /onboarding; a live tenant sitting on /onboarding
  // goes to the dashboard.
  // The menu editor is reachable during onboarding so the owner can build their
  // menu (the "Add your menu" step links here), then return to the wizard.
  const allowDuringOnboarding = path === "/manage-menu";

  useEffect(() => {
    if (!user || loading || !isDashboard || gate.loading) return;
    const complete = gate.status === "live";
    if (isOnboarding && complete) {
      navigate("/live-feed");
    } else if (!isOnboarding && !complete && !allowDuringOnboarding) {
      navigate("/onboarding");
    }
  }, [user, loading, isDashboard, isOnboarding, gate.loading, gate.status, allowDuringOnboarding, navigate]);

  if (isDashboard && loading) {
    return <FullPageMessage title="Loading..." />;
  }

  if (isDashboard && !user) {
    return <LoginScreen navigate={navigate} />;
  }

  // Hold dashboard surfaces until the gate resolves so an incomplete tenant
  // never flashes the dashboard (and vice-versa).
  if (isDashboard && gate.loading) {
    return <FullPageMessage title="Loading..." />;
  }

  if (isOnboarding) {
    return <OnboardingWizard navigate={navigate} path={path} />;
  }

  // Incomplete onboarding on a dashboard route: the effect above is redirecting
  // to /onboarding — render a neutral loader rather than the locked dashboard.
  if (isDashboard && gate.status !== "live") {
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
  if (path === "/kitchen-overview") return <KitchenOverviewPage navigate={navigate} path={path} />;
  if (path === "/analytics") return <AnalyticsPage navigate={navigate} path={path} />;
  if (path === "/settings")
    return <BillingPage navigate={navigate} path={path} />;
  if (path === "/manage-plan") return <ManagePlanPage navigate={navigate} path={path} />;
  if (path === "/update-payment-details")
    return <UpdatePaymentDetailsPage navigate={navigate} path={path} />;
  if (path === "/profile") return <ProfilePage navigate={navigate} path={path} />;
  return <LandingPage navigate={navigate} />;
}

function FullPageMessage({ title }) {
  return (
    <div style={{ display: "grid", placeItems: "center", minHeight: "100vh", color: "#cbd5e1" }}>
      <p style={{ fontSize: 20 }}>{title}</p>
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
