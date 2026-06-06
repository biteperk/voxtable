// Sentry instrumentation must initialise before anything else mounts, so it is
// imported first (the module runs Sentry.init as an import side-effect).
import { captureException } from "./sentry";
import React, { Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { AuthProvider, useAuth } from "./auth";
import { signInWithGoogle, signOutUser, uploadMenuFile } from "./firebase";
import { loadPlacesLibrary, isPlacesEnabled, parsePlaceNew } from "./places";
import {
  advanceOnboarding,
  cancelReservation,
  commitMenuDraft,
  completeReservation,
  createBillingCheckoutSession,
  createBillingPortalSession,
  createMenuCategory,
  createMenuItem,
  createReservation,
  createRestaurant,
  deleteMenuCategory,
  deleteMenuItem,
  getAnalytics,
  getAnalyticsDailySeries,
  getBillingInvoices,
  getBillingPaymentMethods,
  getBillingSubscription,
  getCallLog,
  getMenu,
  getMenuIngestion,
  getOnboardingStatus,
  getPhoneSetup,
  getRestaurantProfile,
  listActiveOrders,
  listCallLogs,
  listReservations,
  listTables,
  saveMenuDraft,
  seatReservation,
  startMenuIngestion,
  updateMenuItem,
  updateOrderStatus,
  updateReservationStatus,
  updateRestaurantProfile,
  verifyForwarding
} from "./api";
import { FAQ } from "./data/pricing";
import { track } from "./lib/analytics";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { useDrawer } from "./hooks/useDrawer";
import { useScrolled } from "./hooks/useScrolled";
import { Icon } from "./components/Icon";
import {
  capitalize,
  centsToDollars,
  decorateDailySeries,
  dollarsToCents,
  formatDuration,
  formatInvoiceDate,
  formatRefreshedAgo,
  formatReservationDate,
  formatVoiceTime12h,
  humanizeIntent,
  humanizeOutcome,
  mapCallLogToRow,
  mapReservationToRow,
  parseTranscript
} from "./lib/format";
import { BrandMark } from "./components/brand/BrandMark";
import { CardBrandIcon } from "./components/brand/CardBrandIcon";
import { LandingPage } from "./pages/landing/LandingPage";
import { DashboardShell } from "./pages/dashboard/DashboardShell";
import { LiveFeedOverviewPage } from "./pages/dashboard/LiveFeedOverviewPage";
import { LiveFeedDetailPage } from "./pages/dashboard/LiveFeedDetailPage";
import { BookingLogPage } from "./pages/dashboard/BookingLogPage";
import { restaurantImage } from "./lib/constants";



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

// ===== Onboarding wizard (Phase 1) =====

const ONBOARDING_CUISINES = [
  "Italian", "Chinese", "Japanese", "Thai", "Indian", "Vietnamese", "Greek",
  "Lebanese", "Mexican", "French", "Modern Australian", "Cafe", "Steakhouse",
  "Seafood", "Pizza", "Burgers", "Vegan", "Other"
];
const ONBOARDING_STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"];

function OnboardingShell({ checklist, children, onSignOut, welcome = false, currentKey = null }) {
  const total = checklist?.length ?? 0;
  const currentIndex = checklist ? checklist.findIndex((s) => s.status === "current") : -1;
  const current = currentIndex >= 0 ? checklist[currentIndex] : null;
  const doneCount = checklist ? checklist.filter((s) => s.status === "done").length : 0;
  const allDone = total > 0 && doneCount === total;
  const ONBOARDING_CONTEXT = {
    profile: "Used by Bella on every call — change it anytime",
    menu: "Lets Bella answer “how much is…” questions",
    trial: "Card not charged for 14 days · cancel anytime",
    phone: "Works with Telstra, Optus & Vodafone"
  };
  const contextLine = ONBOARDING_CONTEXT[currentKey] ?? null;
  return (
    <div className={`onboarding-shell${welcome ? " is-welcome" : ""}`}>
      <div className="onboarding-glow onboarding-glow-1" aria-hidden="true" />
      <div className="onboarding-glow onboarding-glow-2" aria-hidden="true" />
      <header className="onboarding-top">
        <div className="onboarding-brand">
          <img src="/brand/mark-light-on-dark.svg" alt="" width="30" height="30" />
          <strong>VocoTable</strong>
        </div>
        <button type="button" className="onboarding-signout" onClick={onSignOut}>
          Sign out
        </button>
      </header>
      <div className="onboarding-body">
        {total > 0 && (
          <div className="onboarding-progress">
            <p className="onboarding-progress-caption" aria-live="polite">
              {current ? (
                <>
                  <span className="step-count">Step {currentIndex + 1} of {total}</span>
                  {" · "}
                  <span className="step-label">{current.label}</span>
                </>
              ) : (
                <span className="step-label">Setup complete</span>
              )}
            </p>
            <div
              className="onboarding-progress-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={doneCount}
              aria-label="Setup progress"
            >
              {checklist.map((s) => (
                <span
                  key={s.key}
                  className={`onboarding-progress-seg is-${s.status}`}
                  aria-label={`${s.label} — ${s.status === "done" ? "completed" : s.status === "current" ? "in progress" : "not started"}`}
                />
              ))}
              {allDone && (
                <span className="onboarding-progress-cap" aria-hidden="true">
                  <Icon name="check" />
                </span>
              )}
            </div>
            {contextLine && (
              <p className="onboarding-progress-context">
                <Icon name="check" />
                {contextLine}
              </p>
            )}
          </div>
        )}
        <main className="onboarding-main" key={current?.key ?? (welcome ? "welcome" : "done")}>
          {children}
        </main>
      </div>
    </div>
  );
}

function CreateRestaurantStep({ onCreated }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createRestaurant({ name: name.trim() });
      await onCreated();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  const shown = name.trim() || "your restaurant";

  return (
    <div className="onboarding-card">
      <img className="onboarding-welcome-mark" src="/brand/mark-light-on-dark.svg" alt="" />
      <h1>Welcome to VocoTable</h1>
      <p className="onboarding-lead">
        Let's set up Bella, your AI phone host. First — what's your restaurant called?
      </p>
      <form onSubmit={submit} className="onboarding-form">
        <label className="onboarding-field">
          <span>Restaurant name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Natalia's Bistro"
            autoFocus
            maxLength={120}
            required
          />
        </label>
        <div className="onboarding-preview" aria-live="polite">
          <span className="onboarding-preview-label">How Bella answers</span>
          <div className={`onboarding-callcard${name.trim() ? " is-live" : ""}`}>
            <span className="onboarding-callcard-status">
              {name.trim() ? "Incoming call" : "Waiting for the name"}
            </span>
            <p className="onboarding-callcard-greeting">
              “Good evening, you've reached <strong>{shown}</strong>. This is Bella — how can I help?”
            </p>
          </div>
        </div>
        {error && <p className="onboarding-error">{error}</p>}
        <button type="submit" className="primary-button" disabled={busy || !name.trim()}>
          {busy ? "Creating…" : "Create & continue"}
          <Icon name="arrow_forward" />
        </button>
      </form>
    </div>
  );
}

function ProfileStep({ onSaved }) {
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const placesReady = isPlacesEnabled();
  const [placesMounted, setPlacesMounted] = useState(false);

  // Google Places address autocomplete (powered by Google) via the new
  // PlaceAutocompleteElement web component — the legacy `Autocomplete`
  // constructor is disabled for Cloud projects created after 2025-03-01.
  // A CALLBACK ref mounts the element into a container the moment it appears,
  // so it survives the interim loading card. On select we fetch the address
  // components and fill the form. Progressive enhancement: if Places is off or
  // the library fails to load, `placesMounted` stays false and the plain manual
  // street-address input is shown instead.
  const placesHostRef = useCallback(
    (host) => {
      if (!host || !placesReady || host.dataset.mounted === "1") return;
      host.dataset.mounted = "1";
      loadPlacesLibrary().then((lib) => {
        if (!lib?.PlaceAutocompleteElement) return;
        const el = new lib.PlaceAutocompleteElement({
          includedRegionCodes: ["au"],
          types: ["address"]
        });
        el.className = "onboarding-places-el";
        host.appendChild(el);
        setPlacesMounted(true);
        el.addEventListener("gmp-select", async ({ placePrediction }) => {
          try {
            const place = placePrediction.toPlace();
            await place.fetchFields({ fields: ["addressComponents", "formattedAddress"] });
            const parsed = parsePlaceNew(place);
            setForm((prev) => ({
              ...prev,
              address: parsed.address || prev.address,
              suburb: parsed.suburb || prev.suburb,
              state: parsed.state || prev.state,
              postcode: parsed.postcode || prev.postcode
            }));
          } catch {
            /* fetchFields failed — leave fields as-is, manual edit still works */
          }
        });
      });
    },
    [placesReady]
  );

  useEffect(() => {
    let cancelled = false;
    getRestaurantProfile()
      .then((r) => {
        if (cancelled) return;
        const p = r?.profile ?? {};
        setForm({
          name: p.name ?? "",
          owner_name: p.owner_name ?? "",
          contact_email: p.contact_email ?? "",
          existing_phone_number: p.existing_phone_number ?? "",
          address: p.address ?? "",
          suburb: p.suburb ?? "",
          state: p.state ?? "",
          postcode: p.postcode ?? "",
          cuisine_type: Array.isArray(p.cuisine_type) ? p.cuisine_type : [],
          timezone: p.timezone ?? "Australia/Sydney"
        });
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  if (!form) {
    return (
      <div className="onboarding-card is-loading">
        <p style={{ color: "var(--on-surface-variant)" }}>{error ? `Couldn't load: ${error}` : "Loading…"}</p>
      </div>
    );
  }

  const set = (field) => (e) => setForm((prev) => ({ ...prev, [field]: e.target.value }));
  const toggleCuisine = (c) =>
    setForm((prev) => ({
      ...prev,
      cuisine_type: prev.cuisine_type.includes(c)
        ? prev.cuisine_type.filter((x) => x !== c)
        : prev.cuisine_type.length < 5
          ? [...prev.cuisine_type, c]
          : prev.cuisine_type
    }));

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    // Send only filled fields (all optional server-side); cuisine only if chosen.
    const payload = {
      name: form.name.trim() || undefined,
      owner_name: form.owner_name.trim() || undefined,
      contact_email: form.contact_email.trim() || undefined,
      existing_phone_number: form.existing_phone_number.trim() || undefined,
      address: form.address.trim() || undefined,
      suburb: form.suburb.trim() || undefined,
      state: form.state || undefined,
      postcode: form.postcode.trim() || undefined,
      cuisine_type: form.cuisine_type.length ? form.cuisine_type : undefined,
      timezone: form.timezone || undefined
    };
    try {
      await updateRestaurantProfile(payload);
      await onSaved();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <div className="onboarding-card">
      <div className="onboarding-bella">
        <span className="onboarding-bella-avatar" aria-hidden="true"><Icon name="headset_mic" /></span>
        <p>Hi, I'm <strong>Bella</strong>. Tell me about your place and I'll use it to greet every caller.</p>
      </div>
      <h1>Tell us about your restaurant</h1>
      <p className="onboarding-lead">This is what Bella uses to answer your calls.</p>
      <form onSubmit={submit} className="onboarding-form">
        <label className="onboarding-field">
          <span>Restaurant name</span>
          <input type="text" value={form.name} onChange={set("name")} maxLength={120} required />
        </label>
        <div className="onboarding-field-row">
          <label className="onboarding-field">
            <span>Your name</span>
            <input type="text" value={form.owner_name} onChange={set("owner_name")} maxLength={120} />
          </label>
          <label className="onboarding-field">
            <span>Contact email</span>
            <input type="email" value={form.contact_email} onChange={set("contact_email")} maxLength={160} />
          </label>
        </div>
        <label className="onboarding-field">
          <span>Your current phone number <em>(the one customers call today)</em></span>
          <input
            type="tel"
            value={form.existing_phone_number}
            onChange={set("existing_phone_number")}
            placeholder="(02) 1234 5678"
            maxLength={32}
          />
          <span className="onboarding-field-help">
            <Icon name="info" /> Later you'll forward this number to Bella — nothing changes for your callers.
          </span>
        </label>
        <label className="onboarding-field">
          <span>Street address</span>
          {/* Google Places element mounts here when enabled. */}
          {placesReady && <div ref={placesHostRef} className="onboarding-places-host" />}
          {/* Fallback / manual input — hidden once the Places element mounts. */}
          <input
            type="text"
            value={form.address}
            onChange={set("address")}
            maxLength={200}
            autoComplete="off"
            style={placesReady && placesMounted ? { display: "none" } : undefined}
          />
          {placesReady && placesMounted && (
            <span className="onboarding-field-help">
              <Icon name="search" /> Pick your address — suburb, state &amp; postcode fill in automatically.
            </span>
          )}
        </label>
        <div className="onboarding-field-row">
          <label className="onboarding-field">
            <span>Suburb</span>
            <input type="text" value={form.suburb} onChange={set("suburb")} maxLength={80} />
          </label>
          <label className="onboarding-field onboarding-field-sm">
            <span>State</span>
            <select value={form.state} onChange={set("state")}>
              <option value="">—</option>
              {ONBOARDING_STATES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <label className="onboarding-field onboarding-field-sm">
            <span>Postcode</span>
            <input
              type="text"
              inputMode="numeric"
              value={form.postcode}
              onChange={(e) => setForm((prev) => ({ ...prev, postcode: e.target.value.replace(/\D/g, "").slice(0, 4) }))}
              maxLength={4}
            />
          </label>
        </div>
        <div className="onboarding-field">
          <span>
            Cuisine <em>(pick up to 5)</em>
            <span className="ob-counter">{form.cuisine_type.length}/5</span>
          </span>
          <div className="onboarding-chips">
            {ONBOARDING_CUISINES.map((c) => (
              <button
                type="button"
                key={c}
                className={`onboarding-chip${form.cuisine_type.includes(c) ? " is-on" : ""}`}
                onClick={() => toggleCuisine(c)}
                aria-pressed={form.cuisine_type.includes(c)}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
        <div className="onboarding-preview" aria-live="polite">
          <span className="onboarding-preview-label">How Bella answers</span>
          <div className={`onboarding-callcard${form.name.trim() ? " is-live" : ""}`}>
            <span className="onboarding-callcard-status">
              {form.name.trim() ? "Incoming call" : "Waiting for details"}
            </span>
            <p className="onboarding-callcard-greeting">
              “Good evening, you've reached <strong>{form.name.trim() || "your restaurant"}</strong>. This is Bella — how can I help?”
            </p>
            {form.cuisine_type.length > 0 && (
              <p className="onboarding-field-help" style={{ marginTop: 8 }}>
                <Icon name="restaurant_menu" /> I'll mention you serve {form.cuisine_type.slice(0, 3).join(", ").toLowerCase()}.
              </p>
            )}
          </div>
        </div>
        {error && <p className="onboarding-error">{error}</p>}
        <button type="submit" className="primary-button" disabled={busy}>
          {busy ? "Saving…" : "Save & continue"}
          <Icon name="arrow_forward" />
        </button>
      </form>
    </div>
  );
}


// Editable review of the OCR'd draft. Owner fixes names/prices and removes
// junk rows before committing. Variants/modifiers (if any) pass through
// untouched and are editable later in the full menu editor.
function MenuDraftReview({ draft, onCommit, onCancel, committing }) {
  const [cats, setCats] = useState(() =>
    (draft.categories ?? []).map((c) => ({
      ...c,
      items: (c.items ?? []).map((it) => ({ ...it }))
    }))
  );

  const setItem = (ci, ii, patch) =>
    setCats((prev) =>
      prev.map((c, i) =>
        i !== ci ? c : { ...c, items: c.items.map((it, j) => (j !== ii ? it : { ...it, ...patch })) }
      )
    );
  const removeItem = (ci, ii) =>
    setCats((prev) => prev.map((c, i) => (i !== ci ? c : { ...c, items: c.items.filter((_, j) => j !== ii) })));
  const setCatName = (ci, name) => setCats((prev) => prev.map((c, i) => (i !== ci ? c : { ...c, name })));

  const itemCount = cats.reduce((n, c) => n + c.items.length, 0);
  const lowConfidence = cats.some((c) => c.items.some((it) => typeof it.confidence === "number" && it.confidence < 0.5));

  return (
    <div className="onboarding-card onboarding-card-wide">
      <h1>Review your menu</h1>
      <p className="onboarding-lead">
        I read {itemCount} item{itemCount === 1 ? "" : "s"} from your menu. Check the names and prices —
        {lowConfidence ? " I've flagged a few I wasn't sure about." : " everything looked clear."}
      </p>
      {lowConfidence && (
        <div className="onboarding-bella">
          <span className="onboarding-bella-avatar" aria-hidden="true"><Icon name="headset_mic" /></span>
          <p>Give the highlighted rows a quick double-check — I wasn't 100% sure on those prices.</p>
        </div>
      )}
      <div className="menu-review">
        {cats.map((c, ci) => (
          <div key={ci} className="menu-review-cat">
            <input
              className="menu-review-catname"
              value={c.name}
              onChange={(e) => setCatName(ci, e.target.value)}
            />
            {c.items.map((it, ii) => {
              const unsure = typeof it.confidence === "number" && it.confidence < 0.5;
              return (
                <div key={ii} className={`menu-review-row${unsure ? " is-unsure" : ""}`}>
                  <input
                    className="menu-review-name"
                    value={it.name}
                    onChange={(e) => setItem(ci, ii, { name: e.target.value })}
                  />
                  <div className="menu-review-price">
                    <span>$</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      defaultValue={centsToDollars(it.price_cents)}
                      onChange={(e) => setItem(ci, ii, { price_cents: dollarsToCents(e.target.value) })}
                    />
                  </div>
                  {unsure && <span className="menu-review-flag" title="Double-check this price">⚠</span>}
                  <button type="button" className="menu-review-del" onClick={() => removeItem(ci, ii)} aria-label="Remove item">
                    <Icon name="close" />
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="onboarding-actions">
        <button type="button" className="ghost-button" onClick={onCancel} disabled={committing}>
          Start over
        </button>
        <button
          type="button"
          className="primary-button"
          onClick={() => onCommit({ categories: cats })}
          disabled={committing || itemCount === 0}
        >
          {committing ? "Saving…" : `Looks good — import ${itemCount} item${itemCount === 1 ? "" : "s"}`}
          <Icon name="arrow_forward" />
        </button>
      </div>
    </div>
  );
}

function MenuStep({ onContinue, navigate }) {
  const { activeRestaurantId } = useAuth();
  // phase: choose | uploading | parsing | review | committing
  const [phase, setPhase] = useState("choose");
  const [jobId, setJobId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [ocrUnavailable, setOcrUnavailable] = useState(false);
  const pollRef = useRef(null);

  useEffect(() => () => clearInterval(pollRef.current), []);

  const pollJob = (id) => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const r = await getMenuIngestion(id);
        if (r.status === "parsed") {
          clearInterval(pollRef.current);
          setDraft(r.draft ?? { categories: [] });
          setPhase("review");
        } else if (r.status === "failed") {
          clearInterval(pollRef.current);
          setError(r.last_error || "We couldn't read that menu. Try a clearer photo, or add items manually.");
          setPhase("choose");
        }
      } catch (e) {
        clearInterval(pollRef.current);
        setError(e.message);
        setPhase("choose");
      }
    }, 2500);
  };

  const handleFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-selecting the same file
    if (!file || !activeRestaurantId) return;
    setError(null);
    setPhase("uploading");
    try {
      const { url, sha256, sourceKind } = await uploadMenuFile(activeRestaurantId, file);
      const job = await startMenuIngestion({ source_url: url, source_kind: sourceKind, sha256 });
      setJobId(job.job_id);
      setPhase("parsing");
      pollJob(job.job_id);
    } catch (e) {
      if (e.code === "MENU_OCR_DISABLED") {
        setOcrUnavailable(true);
        setPhase("choose");
      } else {
        setError(e.message);
        setPhase("choose");
      }
    }
  };

  const handleCommit = async (editedDraft) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setPhase("committing");
    try {
      await saveMenuDraft(jobId, editedDraft);
      await commitMenuDraft(jobId);
      await advanceOnboarding("menu_completed");
      await onContinue();
    } catch (e) {
      setError(e.message);
      setBusy(false);
      setPhase("review");
    }
  };

  const handleManualContinue = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await advanceOnboarding("menu_completed");
      await onContinue();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  if (phase === "review" && draft) {
    return (
      <MenuDraftReview
        draft={draft}
        committing={phase === "committing" || busy}
        onCommit={handleCommit}
        onCancel={() => {
          setDraft(null);
          setJobId(null);
          setPhase("choose");
        }}
      />
    );
  }

  const working = phase === "uploading" || phase === "parsing" || phase === "committing";

  return (
    <div className="onboarding-card">
      <div className="onboarding-bella">
        <span className="onboarding-bella-avatar" aria-hidden="true"><Icon name="headset_mic" /></span>
        <p>Share your menu and I'll learn every dish and price — so I can answer “how much is…” on a call.</p>
      </div>
      <h1>Add your menu</h1>
      <p className="onboarding-lead">
        Snap a photo or upload a PDF and I'll type it up for you — or add items by hand in the editor.
      </p>

      {ocrUnavailable && (
        <p className="onboarding-note">
          <Icon name="info" /> Photo import isn't switched on yet — please add your menu in the editor
          for now.
        </p>
      )}
      {error && <p className="onboarding-error">{error}</p>}

      {working ? (
        <p className="onboarding-note">
          <Icon name="hourglass_top" />{" "}
          {phase === "uploading" ? "Uploading your menu…" : phase === "parsing" ? "Reading your menu… this takes a few seconds." : "Saving…"}
        </p>
      ) : (
        <>
          <label className="onboarding-dropzone">
            <Icon name="photo_camera" />
            <span className="dz-title">Snap or upload your menu</span>
            <span className="dz-sub">JPG, PNG or PDF — Bella reads it for you</span>
            <input
              type="file"
              accept="image/*,application/pdf"
              onChange={handleFile}
              style={{ display: "none" }}
            />
          </label>
          <div className="onboarding-actions" style={{ marginTop: 14 }}>
            <button type="button" className="ghost-button" onClick={() => navigate("/manage-menu")}>
              <Icon name="restaurant_menu" /> Add manually
            </button>
            <button type="button" className="ghost-button" onClick={handleManualContinue} disabled={busy}>
              {busy ? "Checking…" : "I've already added my menu — continue"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function TrialStep({ onRefresh }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [unavailable, setUnavailable] = useState(false);
  const pollsRef = useRef(0);

  // After returning from Stripe Checkout the webhook may lag a few seconds
  // before advancing the status, so poll a bounded number of times.
  useEffect(() => {
    const id = setInterval(() => {
      pollsRef.current += 1;
      if (pollsRef.current > 8) {
        clearInterval(id);
        return;
      }
      onRefresh?.();
    }, 4000);
    return () => clearInterval(id);
  }, [onRefresh]);

  const startTrial = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { url } = await createBillingCheckoutSession();
      if (url) window.location.href = url;
      else setBusy(false);
    } catch (e) {
      if (e.code === "BILLING_NOT_CONFIGURED") setUnavailable(true);
      else setError(e.message);
      setBusy(false);
    }
  };

  return (
    <div className="onboarding-card">
      <div className="onboarding-bella">
        <span className="onboarding-bella-avatar" aria-hidden="true"><Icon name="headset_mic" /></span>
        <p>Try me free for 14 days. I'll start answering your calls now — your card isn't charged until the trial ends.</p>
      </div>
      <h1>Start your free trial</h1>
      <p className="onboarding-lead">
        Try VocoTable free for 14 days. We'll set up your AI phone host now — cancel anytime.
      </p>
      <div className="trial-plan">
        <div>
          <strong>VocoTable Starter</strong>
          <span>Unlimited AI-answered calls, bookings &amp; orders</span>
        </div>
        <div className="trial-price">
          <strong>$80</strong>
          <span>/ month after trial</span>
        </div>
      </div>
      <ul className="trial-reassure">
        <li><Icon name="check" /> 14-day free trial</li>
        <li><Icon name="check" /> Card not charged until the trial ends</li>
        <li><Icon name="check" /> Cancel anytime</li>
      </ul>
      {unavailable && (
        <p className="onboarding-note">
          <Icon name="info" /> Billing isn't switched on yet — your progress is saved and we'll email
          you when you can start your trial.
        </p>
      )}
      {error && <p className="onboarding-error">{error}</p>}
      {!unavailable && (
        <div className="onboarding-actions">
          <button type="button" className="primary-button" onClick={startTrial} disabled={busy}>
            {busy ? "Opening secure checkout…" : "Start 14-day free trial"}
            <Icon name="arrow_forward" />
          </button>
        </div>
      )}
    </div>
  );
}

function PhoneStep({ onRefresh }) {
  const [setup, setSetup] = useState(null);
  const [error, setError] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const pollRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const r = await getPhoneSetup();
      setSetup(r);
      if (r.forwarding_verified) onRefresh?.();
    } catch (e) {
      setError(e.message);
    }
  }, [onRefresh]);

  useEffect(() => {
    load();
    // Poll while the number is being provisioned by an admin.
    pollRef.current = setInterval(load, 6000);
    return () => clearInterval(pollRef.current);
  }, [load]);

  const verify = async () => {
    if (verifying) return;
    setVerifying(true);
    setError(null);
    try {
      const r = await verifyForwarding();
      if (r.verified) onRefresh?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setVerifying(false);
    }
  };

  if (!setup) {
    return (
      <div className="onboarding-card is-loading">
        <p style={{ color: "var(--on-surface-variant)" }}>{error ? `Couldn't load: ${error}` : "Loading…"}</p>
      </div>
    );
  }

  if (!setup.number_ready) {
    return (
      <div className="onboarding-card">
        <Icon name="hourglass_top" className="phone-provisioning-icon" />
        <h1>We're setting up your phone line</h1>
        <p className="onboarding-lead">
          Our team is provisioning your dedicated VocoTable number and configuring Bella with your
          menu. This usually takes a short while — we'll email you the moment it's ready, and this page
          will update automatically.
        </p>
        <p className="onboarding-note">
          <Icon name="info" /> Provisioning in progress…
        </p>
      </div>
    );
  }

  return (
    <div className="onboarding-card">
      <h1>Connect your phone</h1>
      <p className="onboarding-lead">
        Your VocoTable number is ready. Forward your restaurant's calls to it so Bella can answer.
      </p>
      <div className="phone-number-box">
        <span>Your VocoTable number</span>
        <strong>{setup.vocotable_number}</strong>
      </div>
      <ol className="phone-steps">
        <li>
          On the phone that customers call, set up <strong>call forwarding</strong> to{" "}
          <strong>{setup.vocotable_number}</strong>. Most AU carriers use a code from the handset:
          <ul>
            <li>All calls: <code>*21*{setup.vocotable_number}#</code></li>
            <li>When busy / no answer: <code>*61*{setup.vocotable_number}#</code></li>
          </ul>
          (Exact steps vary by carrier — Telstra, Optus and Vodafone all support these GSM codes.)
        </li>
        <li>From a different phone, call your restaurant's normal number to test it.</li>
        <li>Tap verify below — we'll confirm the call reached Bella.</li>
      </ol>
      {error && <p className="onboarding-error">{error}</p>}
      <div className="onboarding-actions">
        <button type="button" className="primary-button" onClick={verify} disabled={verifying}>
          {verifying ? "Checking for your test call…" : "I've forwarded my number — verify"}
          <Icon name="arrow_forward" />
        </button>
      </div>
    </div>
  );
}

function ComingSoonStep({ title, body }) {
  return (
    <div className="onboarding-card">
      <h1>{title}</h1>
      <p className="onboarding-lead">{body}</p>
      <p className="onboarding-note">
        <Icon name="info" /> Your progress is saved — you can pick up here when this step ships.
      </p>
    </div>
  );
}

function OnboardingWizard({ navigate }) {
  const { memberships, refreshMe } = useAuth();
  const [status, setStatus] = useState(null);
  const [checklist, setChecklist] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const hasRestaurant = (memberships?.length ?? 0) > 0;

  const load = useCallback(async () => {
    if (!hasRestaurant) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await getOnboardingStatus();
      setStatus(r.onboarding_status);
      setChecklist(r.checklist);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [hasRestaurant]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSignOut = async () => {
    await signOutUser();
    navigate("/");
  };

  if (loading) {
    return (
      <OnboardingShell onSignOut={handleSignOut}>
        <div className="onboarding-card">
          <p style={{ color: "var(--on-surface-variant)" }}>Loading…</p>
        </div>
      </OnboardingShell>
    );
  }

  if (!hasRestaurant) {
    return (
      <OnboardingShell onSignOut={handleSignOut} welcome>
        <CreateRestaurantStep onCreated={refreshMe} />
      </OnboardingShell>
    );
  }

  if (error) {
    return (
      <OnboardingShell onSignOut={handleSignOut}>
        <div className="onboarding-card">
          <p className="onboarding-error">Couldn't load your setup: {error}</p>
        </div>
      </OnboardingShell>
    );
  }

  const current = checklist?.find((s) => s.status === "current")?.key ?? null;

  let content;
  if (current === "profile") {
    content = <ProfileStep onSaved={load} />;
  } else if (current === "menu") {
    content = <MenuStep onContinue={load} navigate={navigate} />;
  } else if (current === "trial") {
    content = <TrialStep onRefresh={load} />;
  } else if (current === "phone") {
    content = <PhoneStep onRefresh={load} />;
  } else {
    content = (
      <div className="onboarding-card">
        <div className="onboarding-done-check" aria-hidden="true"><Icon name="check" /></div>
        <h1>You're all set</h1>
        <p className="onboarding-lead">Bella is answering your calls now. Watch them land live in your dashboard.</p>
        <div className="onboarding-actions">
          <button type="button" className="primary-button" onClick={() => navigate("/live-feed")}>
            Go to dashboard <Icon name="arrow_forward" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <OnboardingShell checklist={checklist} currentKey={current} onSignOut={handleSignOut}>
      {content}
    </OnboardingShell>
  );
}

function LoginScreen({ navigate }) {
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
          alt="VocoTable"
          className="login-mark"
          width="56"
          height="56"
        />
        <h1 className="login-title">VocoTable</h1>
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


// ----------------------------------------------------------------------------
// Live Tables — GET /api/tables joins today's active reservation per table.
// Status derives from seated_at / completed_at on the joined reservation;
// the partial unique index on reservations (migration 005) is the source of
// truth for "occupies this slot".
// ----------------------------------------------------------------------------

function LiveTablesPage({ navigate }) {
  const [tables, setTables] = useState([]);
  const [refreshedAt, setRefreshedAt] = useState(new Date());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionBusyId, setActionBusyId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listTables();
      const mapped = (data.tables ?? []).map((t) => {
        const hasReservation = Boolean(t.reservation_id);
        const status = !hasReservation
          ? "available"
          : t.reservation_seated_at
            ? "seated"
            : "reserved";
        return {
          id: t.id,
          label: t.label,
          minCapacity: t.min_capacity,
          maxCapacity: t.max_capacity,
          status,
          reservation: hasReservation
            ? {
                id: t.reservation_id,
                startTime: t.reservation_start_time,
                partySize: t.reservation_party_size,
                seatedAt: t.reservation_seated_at,
                guestName: t.customer_name
              }
            : null
        };
      });
      setTables(mapped);
      setRefreshedAt(new Date());
    } catch (err) {
      setError(err.message ?? String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const refresh = () => {
    load();
  };

  const handleSeat = useCallback(
    async (reservationId) => {
      setActionBusyId(reservationId);
      setError(null);
      try {
        await seatReservation(reservationId);
        await load();
      } catch (err) {
        setError(err.message ?? String(err));
      } finally {
        setActionBusyId(null);
      }
    },
    [load]
  );

  const handleComplete = useCallback(
    async (reservationId) => {
      setActionBusyId(reservationId);
      setError(null);
      try {
        await completeReservation(reservationId);
        await load();
      } catch (err) {
        setError(err.message ?? String(err));
      } finally {
        setActionBusyId(null);
      }
    },
    [load]
  );

  const counts = useMemo(() => {
    const total = tables.length;
    const seated = tables.filter((t) => t.status === "seated").length;
    const reserved = tables.filter((t) => t.status === "reserved").length;
    return { total, seated, reserved };
  }, [tables]);

  const todayLabel = new Date().toLocaleDateString("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  });
  const refreshedAgo = formatRefreshedAgo(refreshedAt);

  return (
    <DashboardShell active="Live Tables" navigate={navigate}>
      <header className="operational-header live-tables-header">
        <div>
          <h1>Live Tables</h1>
          <p>Real-time floor and reservation status.</p>
        </div>
        <div className="live-tables-meta">
          <span className="today-pill">
            <Icon name="calendar_today" />
            {todayLabel}
          </span>
          <button className="feed-action-btn" onClick={refresh} aria-label="Refresh">
            <Icon name="refresh" />
            {refreshedAgo}
          </button>
        </div>
      </header>

      <section className="feed-summary-cards">
        <article className="feed-stat-card">
          <div className="feed-stat-top">
            <span className="feed-stat-label">Total Tables</span>
            <Icon name="table_restaurant" className="feed-stat-icon" />
          </div>
          <div className="feed-stat-bottom">
            <span className="feed-stat-value">{counts.total}</span>
            <span className="feed-stat-sub">Active in floor</span>
          </div>
        </article>

        <article className="feed-stat-card">
          <div className="feed-stat-top">
            <span className="feed-stat-label">Occupied</span>
            <i className="kpi-status-dot seated" />
          </div>
          <div className="feed-stat-bottom">
            <span className="feed-stat-value">
              {counts.seated}
              <em className="feed-stat-denominator">/ {counts.total}</em>
            </span>
            <span className="feed-stat-sub">Seated now</span>
          </div>
        </article>

        <article className="feed-stat-card">
          <div className="feed-stat-top">
            <span className="feed-stat-label">Upcoming Today</span>
            <i className="kpi-status-dot reserved" />
          </div>
          <div className="feed-stat-bottom">
            <span className="feed-stat-value">{counts.reserved}</span>
            <span className="feed-stat-sub">Reserved tonight</span>
          </div>
        </article>
      </section>

      <section className="feed-activity-card">
        <div className="feed-activity-header">
          <h2>Tonight's Tables</h2>
        </div>

        <div className="live-tables-list">
          <div className="live-tables-row live-tables-row-head">
            <span>Table</span>
            <span>Capacity</span>
            <span>Status</span>
            <span className="live-tables-action-col">Action</span>
          </div>
          {loading && tables.length === 0 && (
            <div className="live-tables-row"><span>Loading tables…</span></div>
          )}
          {error && (
            <div className="live-tables-row"><span>Failed to load tables: {error}</span></div>
          )}
          {!loading && !error && tables.length === 0 && (
            <div className="live-tables-row"><span>No tables configured.</span></div>
          )}
          {tables.map((t) => (
            <TableRow
              key={t.id ?? t.label}
              table={t}
              onSeat={handleSeat}
              onComplete={handleComplete}
              onOpenDetails={(tbl) => navigate(`/live-tables/${encodeURIComponent(tbl.label)}`)}
              busy={t.reservation && actionBusyId === t.reservation.id}
            />
          ))}
        </div>
      </section>
    </DashboardShell>
  );
}

function TableRow({ table, onSeat, onComplete, onOpenDetails, busy }) {
  const isReserved = table.status === "reserved";
  const isSeated = table.status === "seated";
  const r = table.reservation;
  const timeLabel = r ? formatVoiceTime12h(r.startTime) : "";
  const guest = r?.guestName ?? "Guest";
  const party = r?.partySize ?? "";

  return (
    <div className={`live-tables-row status-${table.status}`}>
      <span className="table-label">{table.label}</span>
      <span className="table-capacity">
        <Icon name="group" />
        {table.minCapacity}-{table.maxCapacity}
      </span>
      <span className="table-status">
        <i className={`status-dot ${table.status}`} />
        {table.status === "available" && "Available"}
        {isReserved && (
          <>
            Reserved {timeLabel} — {guest} ({party}pp)
          </>
        )}
        {isSeated && (
          <>
            Seated — {guest} ({party}pp)
          </>
        )}
      </span>
      <span className="live-tables-action-col">
        {isReserved && (
          <button
            className="row-action primary"
            onClick={() => onSeat?.(r.id)}
            disabled={busy}
          >
            <Icon name="chair_alt" /> {busy ? "Seating…" : "Seat"}
          </button>
        )}
        {isSeated && (
          <button
            className="row-action primary"
            onClick={() => onComplete?.(r.id)}
            disabled={busy}
          >
            <Icon name="check" /> {busy ? "Marking…" : "Mark Done"}
          </button>
        )}
        <button
          type="button"
          className="row-action ghost"
          onClick={() => onOpenDetails?.(table)}
          aria-label={`View details for ${table.label}`}
        >
          <Icon name="receipt_long" />
          View Order
        </button>
      </span>
    </div>
  );
}

const MOCK_TABLE_ORDERS = {
  T1: [
    { name: "Burrata Caprese", notes: "Heirloom tomato, basil oil", qty: 1, price: 22, status: "served" },
    { name: "Aperol Spritz", notes: "Extra orange", qty: 2, price: 16, status: "served" },
    { name: "Tiramisu", notes: "Share plate", qty: 1, price: 14, status: "pending" },
    { name: "Espresso", notes: "Decaf", qty: 1, price: 5, status: "pending" },
  ],
  T2: [
    { name: "Wagyu Burger", notes: "Medium Rare, No Onions", qty: 2, price: 28, status: "fired" },
    { name: "Truffle Fries", notes: "Extra Aioli", qty: 1, price: 14, status: "fired" },
    { name: "Red Wine Glass", notes: "Pinot Noir", qty: 2, price: 16, status: "served" },
  ],
  T3: [
    { name: "Beef Carpaccio", notes: "Capers, parmesan", qty: 1, price: 26, status: "served" },
    { name: "Lamb Ragu Pappardelle", notes: "House-made pasta", qty: 2, price: 32, status: "fired" },
    { name: "Pan-Seared Salmon", notes: "Skin on, lemon butter", qty: 1, price: 38, status: "fired" },
    { name: "Sparkling Water (1L)", notes: null, qty: 1, price: 9, status: "served" },
    { name: "Crème Brûlée", notes: "Vanilla bean", qty: 2, price: 13, status: "pending" },
  ],
  T4: [
    { name: "Bread Basket", notes: "Sourdough + cultured butter", qty: 1, price: 8, status: "served" },
    { name: "Duck Confit", notes: "Cherry jus", qty: 1, price: 42, status: "served" },
    { name: "Glass of Shiraz", notes: "Barossa Valley", qty: 1, price: 15, status: "served" },
    { name: "Affogato", notes: null, qty: 1, price: 12, status: "pending" },
  ],
  T5: [
    { name: "Burrata Caprese", notes: "Heirloom tomato", qty: 2, price: 22, status: "served" },
    { name: "Bistecca alla Fiorentina", notes: "Rare, share for 2", qty: 1, price: 96, status: "fired" },
    { name: "Truffle Risotto", notes: "Black truffle shavings", qty: 2, price: 36, status: "fired" },
    { name: "Bottle of Barolo", notes: "2018 vintage", qty: 1, price: 110, status: "served" },
    { name: "Tiramisu", notes: "Birthday — add candle", qty: 3, price: 14, status: "pending" },
  ],
  T6: [
    { name: "Caesar Salad", notes: "Anchovy on side", qty: 2, price: 18, status: "served" },
    { name: "Wagyu Sirloin", notes: "Medium rare, peppercorn jus", qty: 2, price: 68, status: "fired" },
    { name: "Sparkling Water (1L)", notes: null, qty: 1, price: 9, status: "served" },
    { name: "Crème Brûlée", notes: "Two spoons", qty: 2, price: 13, status: "pending" },
  ],
  T7: [
    { name: "Bread Basket", notes: "Gluten-free option", qty: 2, price: 8, status: "served" },
    { name: "Beef Carpaccio", notes: "Capers, parmesan", qty: 2, price: 26, status: "served" },
    { name: "Pan-Seared Salmon", notes: "One without lemon", qty: 3, price: 38, status: "fired" },
    { name: "Lamb Ragu Pappardelle", notes: "Extra cheese", qty: 2, price: 32, status: "fired" },
    { name: "Bottle of Pinot Grigio", notes: "Well chilled", qty: 2, price: 64, status: "served" },
  ],
};

const MOCK_TABLE_TIMELINE = {
  T1: [
    { time: "12:55 PM", source: "AI VOICE", text: "Bella took booking for lunch at 1:00 PM (2 guests)." },
    { time: "1:04 PM", source: "KITCHEN", text: "Burrata Caprese fired, prep time ~6 min." },
    { time: "1:10 PM", source: "FLOOR", text: "Aperol Spritz delivered to table." },
  ],
  T2: [
    { time: "12:40 PM", source: "KITCHEN", text: "Mains ordered: 2x Wagyu Burger, 1x Truffle Fries. Sent to KDS." },
    { time: "12:34 PM", source: "AI VOICE", text: "Drinks ordered: 2x Red Wine Glass. Processed automatically." },
    { time: "12:30 PM", source: "AI VOICE", text: "Reservation confirmed by AI VOICE for 2 people. Special request: Birthday celebration." },
  ],
  T3: [
    { time: "7:18 PM", source: "AI VOICE", text: "Anniversary booking confirmed for 7:30 PM, party of 4." },
    { time: "7:38 PM", source: "KITCHEN", text: "Carpaccio plated, pappardelle 8 min out." },
  ],
  T4: [
    { time: "1:05 PM", source: "AI VOICE", text: "Solo booking taken, business-lunch tag added." },
    { time: "1:22 PM", source: "FLOOR", text: "Duck Confit delivered." },
  ],
  T5: [
    { time: "6:42 PM", source: "AI VOICE", text: "Birthday party of 6 confirmed for 7:30 PM. Cake to follow." },
    { time: "7:38 PM", source: "KITCHEN", text: "Bistecca on the grill — 12 min." },
    { time: "7:44 PM", source: "FLOOR", text: "Barolo opened and decanting." },
  ],
  T6: [
    { time: "7:10 PM", source: "AI VOICE", text: "Corporate booking confirmed for 7:30 PM, 4 guests." },
    { time: "7:35 PM", source: "KITCHEN", text: "Wagyu Sirloin x2 fired to medium-rare." },
  ],
  T7: [
    { time: "5:30 PM", source: "AI VOICE", text: "Group of 10 confirmed for 8:00 PM pre-theatre." },
    { time: "8:08 PM", source: "KITCHEN", text: "Mains fired in two waves to keep timing." },
    { time: "8:12 PM", source: "FLOOR", text: "Wine service complete — 2 bottles Pinot Grigio poured." },
  ],
};

const ORDER_STATUS_LABEL = {
  served: "Served",
  fired: "In Kitchen",
  pending: "Pending",
};

const TAX_RATE = 0.085;
const SERVICE_RATE = 0.18;

function TableOrderPage({ navigate, tableLabel }) {
  const [table, setTable] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listTables()
      .then((data) => {
        if (cancelled) return;
        const rows = data.tables ?? [];
        const t = rows.find((row) => row.label === tableLabel);
        if (!t) {
          setError(`Table "${tableLabel}" not found.`);
          setTable(null);
        } else {
          const hasReservation = Boolean(t.reservation_id);
          setTable({
            id: t.id,
            label: t.label,
            minCapacity: t.min_capacity,
            maxCapacity: t.max_capacity,
            status: !hasReservation
              ? "available"
              : t.reservation_seated_at
                ? "seated"
                : "reserved",
            reservation: hasReservation
              ? {
                  id: t.reservation_id,
                  startTime: t.reservation_start_time,
                  partySize: t.reservation_party_size,
                  seatedAt: t.reservation_seated_at,
                  guestName: t.customer_name,
                }
              : null,
          });
        }
      })
      .catch((e) => !cancelled && setError(e.message ?? String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [tableLabel]);

  if (loading) {
    return (
      <DashboardShell active="Live Tables" navigate={navigate}>
        <div className="to-page">
          <button
            type="button"
            className="to-back"
            onClick={() => navigate("/live-tables")}
          >
            <Icon name="arrow_back" />
            Back to Floor Plan
          </button>
          <p className="to-loading">Loading table {tableLabel}…</p>
        </div>
      </DashboardShell>
    );
  }

  if (error || !table) {
    return (
      <DashboardShell active="Live Tables" navigate={navigate}>
        <div className="to-page">
          <button
            type="button"
            className="to-back"
            onClick={() => navigate("/live-tables")}
          >
            <Icon name="arrow_back" />
            Back to Floor Plan
          </button>
          <p className="to-error">{error ?? `Table ${tableLabel} not found.`}</p>
        </div>
      </DashboardShell>
    );
  }

  const r = table.reservation;
  const hasReservation = Boolean(r);
  const orders = MOCK_TABLE_ORDERS[table.label] ?? [];
  const timeline = MOCK_TABLE_TIMELINE[table.label] ?? [];

  const subtotal = orders.reduce((acc, it) => acc + it.qty * it.price, 0);
  const tax = subtotal * TAX_RATE;
  const service = subtotal * SERVICE_RATE;
  const total = subtotal + tax + service;

  const seatedAt = r?.seatedAt ? new Date(r.seatedAt) : null;
  const seatedMinutesAgo = seatedAt
    ? Math.max(0, Math.floor((Date.now() - seatedAt.getTime()) / 60000))
    : null;
  const seatedTimeLabel = seatedAt
    ? seatedAt.toLocaleTimeString("en-AU", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      })
    : null;
  const bookedTimeLabel = r?.startTime ? formatVoiceTime12h(r.startTime) : null;

  return (
    <DashboardShell active="Live Tables" navigate={navigate}>
      <div className="to-page">
        <button
          type="button"
          className="to-back"
          onClick={() => navigate("/live-tables")}
        >
          <Icon name="arrow_back" />
          Back to Floor Plan
        </button>

        <header className="to-hero">
          <div className="to-hero-title">
            <h1>Table {table.label}</h1>
            <span className="to-pill to-pill-capacity">
              <Icon name="group" />
              {table.minCapacity}–{table.maxCapacity}
            </span>
            {hasReservation && (
              <span className="to-pill to-pill-ai">
                <Icon name="auto_awesome" />
                AI Booked
              </span>
            )}
          </div>
        </header>

        {(seatedTimeLabel || bookedTimeLabel || hasReservation) && (
          <div className="to-meta-strip">
            {seatedTimeLabel ? (
              <span className="to-meta-chip">
                <Icon name="schedule" />
                {seatedTimeLabel}
                {seatedMinutesAgo != null && (
                  <span className="to-meta-chip-sub">({seatedMinutesAgo} MIN)</span>
                )}
              </span>
            ) : bookedTimeLabel ? (
              <span className="to-meta-chip">
                <Icon name="schedule" />
                {bookedTimeLabel}
              </span>
            ) : null}
            {hasReservation && (
              <span className="to-meta-chip">
                <Icon name="person" />
                {r.guestName ?? "Guest"}
              </span>
            )}
          </div>
        )}

        <div className="to-grid">
          <section className="to-card to-orders-card">
            <header className="to-card-head">
              <h2>
                <Icon name="list_alt" />
                Active Orders
              </h2>
              <span className="to-card-count">
                {orders.length} {orders.length === 1 ? "item" : "items"}
              </span>
            </header>

            {orders.length === 0 ? (
              <div className="to-empty">
                <p>No items ordered yet</p>
                <span>Orders from the POS will appear here in real time.</span>
              </div>
            ) : (
              <table className="to-items-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Status</th>
                    <th className="to-num">Qty</th>
                    <th className="to-num">Price</th>
                    <th className="to-num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((it, idx) => (
                    <tr key={`${it.name}-${idx}`}>
                      <td>
                        <p className="to-item-name">{it.name}</p>
                        {it.notes && <span className="to-item-notes">{it.notes}</span>}
                      </td>
                      <td>
                        <span className={`to-status-chip status-${it.status}`}>
                          {ORDER_STATUS_LABEL[it.status] ?? it.status}
                        </span>
                      </td>
                      <td className="to-num">{it.qty}</td>
                      <td className="to-num">${it.price.toFixed(2)}</td>
                      <td className="to-num to-num-strong">
                        ${(it.qty * it.price).toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <aside className="to-card to-invoice-card">
            <header className="to-card-head">
              <h2>
                <Icon name="receipt" />
                Invoice Summary
              </h2>
            </header>
            <dl className="to-invoice-lines">
              <div>
                <dt>Subtotal</dt>
                <dd>${subtotal.toFixed(2)}</dd>
              </div>
              <div>
                <dt>Tax (8.5%)</dt>
                <dd>${tax.toFixed(2)}</dd>
              </div>
              <div>
                <dt>Service Charge (18%)</dt>
                <dd>${service.toFixed(2)}</dd>
              </div>
            </dl>
            <div className="to-invoice-total">
              <span>Total</span>
              <strong>${total.toFixed(2)}</strong>
            </div>
            <div className="to-invoice-actions">
              <button type="button" className="to-btn to-btn-ghost">
                <Icon name="print" />
                Print Bill
              </button>
            </div>
          </aside>

          <section className="to-card to-timeline-card">
            <header className="to-card-head">
              <h2>
                <Icon name="schedule" />
                Activity Timeline
              </h2>
            </header>
            {timeline.length === 0 ? (
              <div className="to-empty">
                <p>No activity yet</p>
              </div>
            ) : (
              <ul className="to-timeline">
                {timeline.map((evt, idx) => (
                  <li key={idx} className="to-timeline-item">
                    <div className="to-timeline-marker">
                      <Icon
                        name={
                          evt.source === "KITCHEN"
                            ? "soup_kitchen"
                            : evt.source === "AI VOICE"
                              ? "auto_awesome"
                              : "person"
                        }
                      />
                    </div>
                    <div className="to-timeline-body">
                      <div className="to-timeline-head">
                        <span className="to-timeline-time">{evt.time}</span>
                        <span className="to-timeline-source">{evt.source}</span>
                      </div>
                      <p>{evt.text}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </DashboardShell>
  );
}


function ManageMenuPage({ navigate, path }) {
  const [menu, setMenu] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState("all");
  const [addingCategory, setAddingCategory] = useState(false);
  const [deletingCategory, setDeletingCategory] = useState(null);
  const [deletingItem, setDeletingItem] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const data = await getMenu();
      setMenu(data);
      setError(null);
    } catch (e) {
      setError(e.message ?? "Failed to load menu");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (selectedCategoryId === "all") return;
    if (!menu?.categories?.length) return;
    const stillExists = menu.categories.some((c) => c.id === selectedCategoryId);
    if (!stillExists) setSelectedCategoryId("all");
  }, [menu, selectedCategoryId]);

  const handleToggleAvailability = async (item) => {
    setBusy(true);
    try {
      await updateMenuItem(item.id, { is_available: !item.is_available });
      await refresh();
    } catch (e) {
      setError(e.message ?? "Update failed");
    } finally {
      setBusy(false);
    }
  };

  const confirmDeleteItem = async (item) => {
    setBusy(true);
    try {
      await deleteMenuItem(item.id);
      await refresh();
      return true;
    } catch (e) {
      throw e;
    } finally {
      setBusy(false);
    }
  };

  const visibleCategories = menu?.categories
    ? selectedCategoryId === "all"
      ? menu.categories
      : menu.categories.filter((c) => c.id === selectedCategoryId)
    : [];
  const totalItems = menu?.categories?.reduce((sum, c) => sum + c.items.length, 0) ?? 0;
  const presetCategoryForNew = selectedCategoryId === "all" ? null : selectedCategoryId;

  return (
    <DashboardShell active="Manage Menu" navigate={navigate} path={path}>
      <header className="operational-header">
        <div>
          <h1>Manage Menu</h1>
          <p>Add, edit, and toggle availability. Changes are live to the kitchen instantly.</p>
        </div>
        <div className="menu-page-actions">
          <button type="button" className="kitchen-btn ghost" onClick={() => setAddingCategory(true)} disabled={busy}>
            <Icon name="add" />
            Category
          </button>
          <button
            type="button"
            className="kitchen-btn primary"
            onClick={() => setEditing({ mode: "create", categoryId: presetCategoryForNew })}
            disabled={busy || !menu?.categories?.length}
          >
            <Icon name="restaurant_menu" />
            New menu item
          </button>
        </div>
      </header>

      {error ? <div className="menu-error">{error}</div> : null}

      {!menu ? (
        <div className="menu-empty">Loading…</div>
      ) : menu.categories.length === 0 ? (
        <div className="menu-empty">
          <Icon name="restaurant_menu" />
          <p>No categories yet.</p>
          <button type="button" className="kitchen-btn primary" onClick={() => setAddingCategory(true)} disabled={busy}>
            <Icon name="add" />
            Add your first category
          </button>
        </div>
      ) : (
        <section className="menu-layout">
          <aside className="menu-sidebar">
            <div className="menu-sidebar-head">
              <span>Categories</span>
              <strong>{menu.categories.length}</strong>
            </div>
            <nav className="menu-sidebar-list">
              <button
                type="button"
                className={`menu-sidebar-item${selectedCategoryId === "all" ? " is-active" : ""}`}
                onClick={() => setSelectedCategoryId("all")}
              >
                <span className="menu-sidebar-name">All categories</span>
                <span className="menu-sidebar-count">{totalItems}</span>
              </button>
              {menu.categories.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  className={`menu-sidebar-item${category.id === selectedCategoryId ? " is-active" : ""}`}
                  onClick={() => setSelectedCategoryId(category.id)}
                >
                  <span className="menu-sidebar-name">{category.name}</span>
                  <span className="menu-sidebar-count">{category.items.length}</span>
                </button>
              ))}
            </nav>
            <footer className="menu-sidebar-foot">
              <span>Total items</span>
              <strong>{totalItems}</strong>
            </footer>
          </aside>

          <article className="menu-detail">
            {visibleCategories.length === 0 ? null : (
              <>
                {selectedCategoryId !== "all" && visibleCategories[0] ? (
                  <header className="menu-detail-head">
                    <div>
                      <h2>{visibleCategories[0].name}</h2>
                      <span>
                        {visibleCategories[0].items.length} item{visibleCategories[0].items.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <div className="menu-detail-head-actions">
                      <button
                        type="button"
                        className="kitchen-btn primary"
                        onClick={() => setEditing({ mode: "create", categoryId: visibleCategories[0].id })}
                        disabled={busy}
                      >
                        <Icon name="add" />
                        New item
                      </button>
                      <button
                        type="button"
                        className="kitchen-btn danger"
                        onClick={() => setDeletingCategory(visibleCategories[0])}
                        disabled={busy}
                        title="Delete category"
                        aria-label="Delete category"
                      >
                        <Icon name="delete" />
                      </button>
                    </div>
                  </header>
                ) : null}
                <div className="menu-categories-stack">
                  {visibleCategories.map((category) => (
                    <section key={category.id} className="menu-category-block">
                      {selectedCategoryId === "all" ? (
                        <header className="menu-category-block-head">
                          <h3>{category.name}</h3>
                          <span>
                            {category.items.length} item{category.items.length === 1 ? "" : "s"}
                          </span>
                        </header>
                      ) : null}
                      {category.items.length === 0 ? (
                        <div className="menu-empty inline">
                          <p>No items in this category yet.</p>
                        </div>
                      ) : (
                        <div className="menu-items-grid">
                          {category.items.map((item) => (
                            <article
                              key={item.id}
                              className={`menu-item-card${item.is_available ? "" : " unavailable"}`}
                            >
                              <header className="menu-item-head">
                                <div className="menu-item-title">
                                  <strong>{item.name}</strong>
                                  <span className={`menu-item-status${item.is_available ? "" : " out"}`}>
                                    <i />
                                    {item.is_available ? "Available" : "Sold out"}
                                  </span>
                                </div>
                                <div className="menu-item-price">${(item.base_price_cents / 100).toFixed(2)}</div>
                              </header>
                              {item.description ? (
                                <p className="menu-item-desc">{item.description}</p>
                              ) : null}
                              {item.variants.length > 0 ? (
                                <div className="menu-item-variants">
                                  {item.variants.map((v) => (
                                    <span key={v.id} className="menu-item-variant">
                                      {v.name} {v.price_delta_cents >= 0 ? "+" : ""}
                                      ${(v.price_delta_cents / 100).toFixed(2)}
                                    </span>
                                  ))}
                                </div>
                              ) : null}
                              {item.modifier_groups.length > 0 ? (
                                <div className="menu-item-modifiers">
                                  {item.modifier_groups.map((g) => (
                                    <div key={g.group_name} className="menu-item-modifier-group">
                                      <strong>{g.group_name}</strong>
                                      <span>
                                        ({g.group_min_select}–{g.group_max_select}):{" "}
                                        {g.options.map((o) => o.name).join(", ")}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              ) : null}
                              <footer className="menu-item-actions">
                                <button
                                  type="button"
                                  className={`kitchen-btn ghost${item.is_available ? "" : " warn"}`}
                                  onClick={() => handleToggleAvailability(item)}
                                  disabled={busy}
                                >
                                  <Icon name={item.is_available ? "remove_shopping_cart" : "check_circle"} />
                                  {item.is_available ? "Sell out" : "Restore"}
                                </button>
                                <button
                                  type="button"
                                  className="kitchen-btn ghost"
                                  onClick={() => setEditing({ mode: "edit", item, categoryId: category.id })}
                                  disabled={busy}
                                >
                                  <Icon name="edit" />
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  className="kitchen-btn danger"
                                  onClick={() => setDeletingItem(item)}
                                  disabled={busy}
                                  title="Delete"
                                >
                                  <Icon name="delete" />
                                </button>
                              </footer>
                            </article>
                          ))}
                        </div>
                      )}
                    </section>
                  ))}
                </div>
              </>
            )}
          </article>
        </section>
      )}

      {editing ? (
        <MenuItemModal
          mode={editing.mode}
          item={editing.item}
          presetCategoryId={editing.categoryId}
          categories={menu?.categories ?? []}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      ) : null}

      {addingCategory ? (
        <CategoryModal
          onClose={() => setAddingCategory(false)}
          onSaved={async () => {
            setAddingCategory(false);
            await refresh();
          }}
        />
      ) : null}

      {deletingCategory ? (
        <DeleteCategoryModal
          category={deletingCategory}
          onClose={() => setDeletingCategory(null)}
          onDeleted={async () => {
            setDeletingCategory(null);
            setSelectedCategoryId("all");
            await refresh();
          }}
        />
      ) : null}

      {deletingItem ? (
        <DeleteItemModal
          item={deletingItem}
          onClose={() => setDeletingItem(null)}
          onDelete={async () => {
            await confirmDeleteItem(deletingItem);
            setDeletingItem(null);
          }}
        />
      ) : null}
    </DashboardShell>
  );
}

function MenuItemModal({ mode, item, presetCategoryId, categories, onClose, onSaved }) {
  const [name, setName] = useState(item?.name ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [priceDollars, setPriceDollars] = useState(((item?.base_price_cents ?? 0) / 100).toFixed(2));
  const [categoryId, setCategoryId] = useState(item?.category_id ?? presetCategoryId ?? categories[0]?.id ?? "");
  const [variants, setVariants] = useState(item?.variants?.map((v) => ({
    name: v.name,
    delta: (v.price_delta_cents / 100).toFixed(2)
  })) ?? []);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const addVariant = () => setVariants((vs) => [...vs, { name: "", delta: "0.00" }]);
  const removeVariant = (idx) => setVariants((vs) => vs.filter((_, i) => i !== idx));

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const toCents = (raw) => {
        const n = parseFloat(raw ?? "0");
        return Number.isFinite(n) ? Math.round(n * 100) : 0;
      };
      const payload = {
        category_id: categoryId,
        name: name.trim(),
        description: description.trim() || null,
        base_price_cents: toCents(priceDollars),
        variants: variants
          .filter((v) => v.name.trim())
          .map((v, idx) => ({
            name: v.name.trim(),
            price_delta_cents: toCents(v.delta),
            display_order: idx
          }))
      };
      if (mode === "create") {
        await createMenuItem(payload);
      } else {
        await updateMenuItem(item.id, payload);
      }
      onSaved();
    } catch (e) {
      setError(e.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="menu-modal-backdrop" onClick={onClose}>
      <form className="menu-modal" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
        <header className="menu-modal-head">
          <h2>
            <Icon name={mode === "create" ? "restaurant_menu" : "edit"} />
            {mode === "create" ? "New menu item" : `Edit ${item?.name}`}
          </h2>
          <button type="button" className="menu-modal-close" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="menu-modal-body">
          {error ? <div className="menu-error">{error}</div> : null}
          <label className="menu-field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} placeholder="e.g. Spaghetti Carbonara" />
          </label>
          <label className="menu-field">
            <span>Category</span>
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <label className="menu-field">
            <span>Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="Optional — guests see this on QR menus"
            />
          </label>
          <label className="menu-field">
            <span>Base price ($)</span>
            <input
              type="number"
              step="0.01"
              min="0"
              lang="en-US"
              inputMode="decimal"
              value={priceDollars}
              onChange={(e) => setPriceDollars(e.target.value)}
              required
            />
          </label>
          <div className="menu-variants-edit">
            <div className="menu-variants-head">
              <span>Variants (size tiers)</span>
              <button type="button" className="kitchen-btn ghost" onClick={addVariant}>
                <Icon name="add" />
                Variant
              </button>
            </div>
            {variants.length === 0 ? (
              <p className="menu-variants-hint">No variants yet — base price applies.</p>
            ) : (
              variants.map((v, idx) => (
                <div key={idx} className="menu-variant-row">
                  <input
                    placeholder="Name (e.g. Large)"
                    value={v.name}
                    onChange={(e) => setVariants((vs) => vs.map((x, i) => i === idx ? { ...x, name: e.target.value } : x))}
                  />
                  <input
                    type="number"
                    step="0.01"
                    lang="en-US"
                    inputMode="decimal"
                    placeholder="Δ$"
                    value={v.delta}
                    onChange={(e) => setVariants((vs) => vs.map((x, i) => i === idx ? { ...x, delta: e.target.value } : x))}
                  />
                  <button type="button" className="kitchen-btn danger" onClick={() => removeVariant(idx)} title="Remove variant">
                    <Icon name="close" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
        <footer className="menu-modal-actions">
          <button type="button" className="kitchen-btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="kitchen-btn primary" disabled={saving}>
            <Icon name="check" />
            {saving ? "Saving…" : "Save"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function DeleteItemModal({ item, onClose, onDelete }) {
  const [error, setError] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const handleConfirm = async (event) => {
    event.preventDefault();
    setDeleting(true);
    setError(null);
    try {
      await onDelete();
    } catch (e) {
      setError(e.message ?? "Delete failed");
      setDeleting(false);
    }
  };

  return (
    <div className="menu-modal-backdrop" onClick={onClose}>
      <form
        className="menu-modal menu-modal-sm"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleConfirm}
      >
        <header className="menu-modal-head">
          <h2>
            <Icon name="delete" />
            Delete menu item
          </h2>
          <button type="button" className="menu-modal-close" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="menu-modal-body">
          {error ? <div className="menu-error">{error}</div> : null}
          <div className="delete-item-preview">
            <div className="delete-item-preview-head">
              <strong>{item.name}</strong>
              <span>${(item.base_price_cents / 100).toFixed(2)}</span>
            </div>
            {item.description ? (
              <p className="delete-item-preview-desc">{item.description}</p>
            ) : null}
            {item.variants?.length > 0 ? (
              <div className="delete-item-preview-meta">
                <Icon name="tune" />
                {item.variants.length} variant{item.variants.length === 1 ? "" : "s"}
              </div>
            ) : null}
          </div>
          <p className="menu-modal-hint">
            Permanently delete this item from the menu. Past order history
            keeps a snapshot, so old receipts and analytics stay correct.
          </p>
        </div>
        <footer className="menu-modal-actions">
          <button type="button" className="kitchen-btn ghost" onClick={onClose} disabled={deleting}>
            Cancel
          </button>
          <button type="submit" className="kitchen-btn danger" disabled={deleting}>
            <Icon name="delete" />
            {deleting ? "Deleting…" : "Delete item"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function DeleteCategoryModal({ category, onClose, onDeleted }) {
  const [error, setError] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const hasItems = (category?.items?.length ?? 0) > 0;

  const handleDelete = async () => {
    if (hasItems) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteMenuCategory(category.id);
      onDeleted();
    } catch (e) {
      setError(e.message ?? "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="menu-modal-backdrop" onClick={onClose}>
      <form
        className="menu-modal menu-modal-sm"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); handleDelete(); }}
      >
        <header className="menu-modal-head">
          <h2>
            <Icon name="delete" />
            Delete category
          </h2>
          <button type="button" className="menu-modal-close" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="menu-modal-body">
          {error ? <div className="menu-error">{error}</div> : null}
          {hasItems ? (
            <p className="menu-modal-hint menu-modal-warn">
              <strong>“{category.name}” has {category.items.length} item{category.items.length === 1 ? "" : "s"}.</strong>
              <br />
              Categories with items can't be deleted. Move or delete the items first, then come back.
            </p>
          ) : (
            <p className="menu-modal-hint">
              Permanently delete <strong>“{category.name}”</strong>? This can't be undone.
            </p>
          )}
        </div>
        <footer className="menu-modal-actions">
          <button type="button" className="kitchen-btn ghost" onClick={onClose}>
            {hasItems ? "Close" : "Cancel"}
          </button>
          {!hasItems ? (
            <button type="submit" className="kitchen-btn danger" disabled={deleting}>
              <Icon name="delete" />
              {deleting ? "Deleting…" : "Delete category"}
            </button>
          ) : null}
        </footer>
      </form>
    </div>
  );
}

function CategoryModal({ onClose, onSaved }) {
  const [name, setName] = useState("");
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await createMenuCategory({ name: name.trim() });
      onSaved();
    } catch (e) {
      setError(e.message ?? "Create failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="menu-modal-backdrop" onClick={onClose}>
      <form className="menu-modal menu-modal-sm" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
        <header className="menu-modal-head">
          <h2>
            <Icon name="add" />
            New category
          </h2>
          <button type="button" className="menu-modal-close" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="menu-modal-body">
          {error ? <div className="menu-error">{error}</div> : null}
          <label className="menu-field">
            <span>Category name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={120}
              autoFocus
              placeholder="e.g. Mains, Drinks, Specials"
            />
          </label>
          <p className="menu-modal-hint">
            Categories group items on the kitchen display and guest menus. You can add items right after.
          </p>
        </div>
        <footer className="menu-modal-actions">
          <button type="button" className="kitchen-btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="kitchen-btn primary" disabled={saving || !name.trim()}>
            <Icon name="check" />
            {saving ? "Creating…" : "Create category"}
          </button>
        </footer>
      </form>
    </div>
  );
}

const KITCHEN_COLUMNS = [
  { status: "pending",   title: "Pending",   icon: "schedule",       advance: "preparing", advanceLabel: "Start" },
  { status: "preparing", title: "Preparing", icon: "soup_kitchen",   advance: "ready",     advanceLabel: "Mark ready" },
  { status: "ready",     title: "Ready",     icon: "room_service",   advance: "served",    advanceLabel: "Mark served" },
];

function KitchenOverviewPage({ navigate, path }) {
  const [orders, setOrders] = useState([]);
  const [serverNow, setServerNow] = useState(new Date().toISOString());
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const data = await listActiveOrders();
      setOrders(data.orders ?? []);
      setServerNow(data.server_now ?? new Date().toISOString());
      setError(null);
    } catch (e) {
      setError(e.message ?? "Failed to load orders");
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(() => {
      if (!document.hidden) refresh();
    }, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  const handleAdvance = async (order, nextStatus) => {
    setBusyId(order.id);
    try {
      await updateOrderStatus(order.id, nextStatus, order.version);
      await refresh();
    } catch (e) {
      setError(e.message ?? "Status update failed");
    } finally {
      setBusyId(null);
    }
  };

  const handleCancel = async (order) => {
    const reason = window.prompt(`Cancel order #${order.order_number}? (Optional reason)`);
    if (reason === null) return;
    setBusyId(order.id);
    try {
      await updateOrderStatus(order.id, "cancelled", order.version, reason || undefined);
      await refresh();
    } catch (e) {
      setError(e.message ?? "Cancel failed");
    } finally {
      setBusyId(null);
    }
  };

  const grouped = KITCHEN_COLUMNS.reduce((acc, col) => {
    acc[col.status] = orders.filter((o) => o.status === col.status);
    return acc;
  }, {});

  return (
    <DashboardShell active="Kitchen" navigate={navigate} path={path}>
      <header className="operational-header">
        <div>
          <h1>Kitchen overview</h1>
          <p>All active orders, grouped by stage. Advance each ticket with its action button.</p>
        </div>
        <div className="active-call-pill">
          <Icon name="receipt_long" />
          <span>{orders.length} active</span>
        </div>
      </header>

      {error ? <div className="menu-error">{error}</div> : null}

      <section className="kitchen-board">
        {KITCHEN_COLUMNS.map((col) => (
          <KitchenColumn
            key={col.status}
            column={col}
            orders={grouped[col.status]}
            serverNow={serverNow}
            busyId={busyId}
            onAdvance={handleAdvance}
            onCancel={handleCancel}
          />
        ))}
      </section>
    </DashboardShell>
  );
}

function KitchenColumn({ column, orders, serverNow, busyId, onAdvance, onCancel }) {
  return (
    <article className={`kitchen-column kitchen-column-${column.status}`}>
      <header className="kitchen-column-head">
        <span className="kitchen-column-title">
          <Icon name={column.icon} />
          {column.title}
        </span>
        <span className="kitchen-column-count">{orders.length}</span>
      </header>
      <div className="kitchen-column-body">
        {orders.length === 0 ? (
          <div className="kitchen-column-empty">No tickets</div>
        ) : (
          orders.map((order) => (
            <KitchenOrderCard
              key={order.id}
              order={order}
              serverNow={serverNow}
              busy={busyId === order.id}
              advanceLabel={column.advanceLabel}
              onAdvance={() => onAdvance(order, column.advance)}
              onCancel={() => onCancel(order)}
            />
          ))
        )}
      </div>
    </article>
  );
}

function KitchenOrderCard({ order, serverNow, busy, advanceLabel, onAdvance, onCancel }) {
  const orderedAt = new Date(order.ordered_at).getTime();
  const nowMs = new Date(serverNow).getTime();
  const ageS = Math.max(0, Math.round((nowMs - orderedAt) / 1000));
  const mins = Math.floor(ageS / 60);
  const ageLabel = mins < 1 ? `${ageS}s` : `${mins}m`;
  const ageStale = mins >= 10;

  return (
    <article className={`kitchen-card${ageStale ? " is-stale" : ""}`}>
      <header className="kitchen-card-head">
        <span className="kitchen-card-number">#{order.order_number ?? "?"}</span>
        <span className={`kitchen-card-age${ageStale ? " stale" : ""}`}>
          <Icon name="schedule" />
          {ageLabel}
        </span>
      </header>
      <div className="kitchen-card-meta">
        <span className={`kitchen-pill ${order.payment_status === "paid" ? "paid" : "unpaid"}`}>
          {order.payment_status === "paid" ? "PAID" : "UNPAID"}
        </span>
        <span className="kitchen-pill source">{order.source}</span>
        <span className="kitchen-card-total">${(order.total_cents / 100).toFixed(2)}</span>
      </div>
      <ul className="kitchen-card-items">
        {order.items.map((item) => (
          <li key={item.id}>
            <strong>{item.quantity}×</strong> {item.name_snapshot}
            {item.variant_name_snapshot ? <em> — {item.variant_name_snapshot}</em> : null}
            {item.modifiers.length ? (
              <span className="kitchen-card-mods">
                ({item.modifiers.map((m) => m.name_snapshot).join(", ")})
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="kitchen-card-actions">
        <button type="button" className="kitchen-btn primary" onClick={onAdvance} disabled={busy}>
          <Icon name="arrow_forward" />
          {advanceLabel}
        </button>
        <button type="button" className="kitchen-btn danger" onClick={onCancel} disabled={busy} title="Cancel order">
          <Icon name="close" />
        </button>
      </div>
    </article>
  );
}

const ANALYTICS_PERIODS = [
  { days: 7,  label: "Last 7 days" },
  { days: 15, label: "Last 15 days" },
  { days: 30, label: "Last 30 days" },
  { days: 60, label: "Last 60 days" },
  { days: 90, label: "Last 90 days" },
];

function AnalyticsPage({ navigate }) {
  const [days, setDays] = useState(7);
  const [analytics, setAnalytics] = useState(null);
  const [dailySeries, setDailySeries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [periodOpen, setPeriodOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const periodRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([getAnalytics({ days }), getAnalyticsDailySeries({ days })])
      .then(([statsRes, seriesRes]) => {
        if (cancelled) return;
        setAnalytics(statsRes.analytics);
        setDailySeries(decorateDailySeries(seriesRes.series ?? []));
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [days]);

  useEffect(() => {
    if (!periodOpen) return;
    const onClick = (event) => {
      if (periodRef.current && !periodRef.current.contains(event.target)) {
        setPeriodOpen(false);
      }
    };
    const onKey = (event) => {
      if (event.key === "Escape") setPeriodOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [periodOpen]);

  const totalCalls = analytics?.total_calls ?? 0;
  // Prefer the new analyzer-driven `bookings_confirmed`; fall back to the
  // legacy `bookings_created` count of call_logs linked to a reservation.
  const bookingsCount = analytics?.bookings_confirmed ?? analytics?.bookings_created ?? 0;
  const bookingRate =
    totalCalls > 0 ? `${Math.round((bookingsCount / totalCalls) * 100)}%` : "—";
  const dailyRevenue = `$${((bookingsCount * 80) / days).toFixed(0)}`;
  const avgLatency = analytics?.avg_latency_ms
    ? `${(analytics.avg_latency_ms / 1000).toFixed(1)}s`
    : "—";
  const avgDuration =
    analytics?.avg_duration_seconds != null
      ? formatDuration(analytics.avg_duration_seconds)
      : "—";

  const periodLabel = ANALYTICS_PERIODS.find((p) => p.days === days)?.label ?? `Last ${days} days`;

  const handleExport = async () => {
    if (exporting || loading) return;
    setExporting(true);
    try {
      const { exportAnalyticsPdf } = await import("./pdfExport.js");
      exportAnalyticsPdf({
        days,
        periodLabel,
        metrics: {
          totalCalls,
          bookingsCount,
          bookingRate,
          dailyRevenue,
          avgLatency,
          avgDuration,
        },
        dailySeries,
        analytics,
      });
    } catch (e) {
      setError(`Export failed: ${e.message ?? e}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <DashboardShell active="Analytics" navigate={navigate}>
      <header className="analytics-header">
        <div>
          <h1>Performance Analytics</h1>
          <p>{error ? `Error: ${error}` : `${periodLabel} of VocoTable AI activity.`}</p>
        </div>
        <div className="analytics-actions">
          <div className="period-dropdown" ref={periodRef}>
            <button
              type="button"
              className="period-trigger"
              onClick={() => setPeriodOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={periodOpen}
            >
              {periodLabel}
              <Icon name={periodOpen ? "expand_less" : "expand_more"} />
            </button>
            {periodOpen ? (
              <div className="period-menu" role="menu">
                {ANALYTICS_PERIODS.map((p) => (
                  <button
                    key={p.days}
                    type="button"
                    role="menuitemradio"
                    aria-checked={days === p.days}
                    className={`period-menu-item${days === p.days ? " is-active" : ""}`}
                    onClick={() => {
                      setDays(p.days);
                      setPeriodOpen(false);
                    }}
                  >
                    {p.label}
                    {days === p.days ? <Icon name="check" /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <button type="button" onClick={handleExport} disabled={exporting || loading}>
            <Icon name={exporting ? "hourglass_top" : "download"} />
            {exporting ? "Generating…" : "Export"}
          </button>
        </div>
      </header>

      <section className="metric-grid">
        <Metric icon="call" label="Total Calls" value={loading ? "…" : String(totalCalls)} change={`last ${days}d`} />
        <Metric icon="event_available" label="Booking Conversion" value={loading ? "…" : bookingRate} change={`${bookingsCount} bookings`} tone="secondary" />
        <Metric icon="payments" label="Daily Avg Revenue" value={loading ? "…" : dailyRevenue} change="$80 / booking" tone="tertiary" />
        <Metric icon="timer" label="Avg Call Duration" value={loading ? "…" : avgDuration} change={analytics?.avg_latency_ms ? `${avgLatency} latency` : ""} />
      </section>

      <section className="analytics-lower-grid">
        <CallVolumeChart series={dailySeries} loading={loading} days={days} />
        <OutcomeBreakdown analytics={analytics} />
      </section>
    </DashboardShell>
  );
}

function Metric({ icon, label, value, change, tone = "primary", down = false }) {
  return (
    <article className={`metric-card ${tone}`}>
      <div className="metric-top">
        <div className="metric-icon">
          <Icon name={icon} fill />
        </div>
        <span className={down ? "metric-change down" : "metric-change"}>
          <Icon name={down ? "trending_down" : "trending_up"} />
          {change}
        </span>
      </div>
      <p>{label}</p>
      <strong>{value}</strong>
    </article>
  );
}


function CallVolumeChart({ series, loading, days = 7 }) {
  const maxTotal = Math.max(1, ...series.map((d) => d.total));
  const niceMax = Math.max(4, Math.ceil(maxTotal / 4) * 4);
  const ticks = [niceMax, Math.round(niceMax * 0.75), Math.round(niceMax * 0.5), Math.round(niceMax * 0.25), 0];

  // For wide ranges (>14 days) sample x-axis labels so they don't overlap, and
  // use a short date instead of weekday since weekdays repeat.
  const useShortDate = series.length > 7;
  const labelStride = series.length <= 14 ? 1 : Math.ceil(series.length / 10);

  const gridCols = `repeat(${Math.max(series.length, 1)}, minmax(0, 1fr))`;
  const gap = series.length > 14 ? 4 : 18;

  return (
    <article className="chart-card">
      <div className="chart-head">
        <h2>Call Volume & Outcomes</h2>
        <div className="legend">
          <span>
            <i className="legend-primary" />
            Total Calls
          </span>
          <span>
            <i className="legend-secondary" />
            Confirmed Bookings
          </span>
        </div>
      </div>
      <div className="chart-area">
        <div className="y-axis">
          {ticks.map((t, i) => (
            <span key={i}>{t}</span>
          ))}
        </div>
        <div className="bars" style={{ gridTemplateColumns: gridCols, gap: `${gap}px` }}>
          {series.map((d) => {
            const totalPct = niceMax > 0 ? (d.total / niceMax) * 100 : 0;
            const confirmedPct = d.total > 0 ? (d.confirmed / d.total) * 100 : 0;
            return (
              <div
                className="bar-column"
                key={d.key}
                title={`${useShortDate ? d.shortDate : d.label}: ${d.total} calls, ${d.confirmed} confirmed`}
              >
                <div className="bar total" style={{ height: `${totalPct}%` }}>
                  <div className="confirmed" style={{ height: `${confirmedPct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="x-axis" style={{ gridTemplateColumns: gridCols, gap: `${gap}px` }}>
        {series.map((d, i) => (
          <span key={d.key}>{i % labelStride === 0 ? (useShortDate ? d.shortDate : d.label) : ""}</span>
        ))}
      </div>
      {!loading && series.every((d) => d.total === 0) && (
        <p style={{ color: "var(--outline)", fontSize: 12, marginTop: 8, textAlign: "center" }}>
          No calls in the last {days} days.
        </p>
      )}
    </article>
  );
}

function OutcomeBreakdown({ analytics }) {
  const total = analytics?.total_calls ?? 0;
  const bookings = analytics?.bookings_created ?? 0;
  const transferred = analytics?.transferred ?? 0;
  const other = Math.max(0, total - bookings - transferred);
  const pct = (n) => (total ? `${Math.round((n / total) * 100)}%` : "—");

  return (
    <article className="outcome-card">
      <h2>Outcome Breakdown</h2>
      <div className="outcome-art">
        <div className="diamond diamond-primary" />
        <div className="diamond diamond-secondary" />
        <div className="diamond diamond-tertiary" />
        <div className="outcome-center">
          <strong>{total}</strong>
          <span>Total</span>
        </div>
      </div>
      <div className="outcome-list">
        <OutcomeItem color="primary" label="Confirmed Bookings" value={pct(bookings)} />
        <OutcomeItem color="secondary" label="FAQ / Other" value={pct(other)} />
        <OutcomeItem color="tertiary" label="Transferred to Staff" value={pct(transferred)} />
      </div>
    </article>
  );
}

function OutcomeItem({ color, label, value }) {
  return (
    <div className="outcome-item">
      <span>
        <i className={color} />
        {label}
      </span>
      <strong>{value}</strong>
    </div>
  );
}

function ProfilePage({ navigate }) {
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

const INVOICE_STATUSES = [
  { key: "paid",     label: "Paid",     color: "primary" },
  { key: "refunded", label: "Refunded", color: "warn" },
  { key: "failed",   label: "Failed",   color: "danger" },
];


function BillingPage({ navigate }) {
  const { user } = useAuth();

  const [invoices, setInvoices] = useState([]);
  const [subscription, setSubscription] = useState(null);
  const [defaultCard, setDefaultCard] = useState(null);
  const [enabled, setEnabled] = useState(true);
  const [mode, setMode] = useState("live");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [statusFilter, setStatusFilter] = useState(() => new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  const [downloadingId, setDownloadingId] = useState(null);
  const filterRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([getBillingInvoices(), getBillingSubscription(), getBillingPaymentMethods()])
      .then(([inv, sub, pm]) => {
        if (cancelled) return;
        setEnabled(Boolean(inv?.enabled));
        setMode(inv?.mode ?? "live");
        setInvoices(Array.isArray(inv?.invoices) ? inv.invoices : []);
        setSubscription(sub?.subscription ?? null);
        const cards = Array.isArray(pm?.payment_methods) ? pm.payment_methods : [];
        setDefaultCard(cards.find((c) => c.is_default) ?? cards[0] ?? null);
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!filterOpen) return;
    const onClick = (event) => {
      if (filterRef.current && !filterRef.current.contains(event.target)) {
        setFilterOpen(false);
      }
    };
    const onKey = (event) => {
      if (event.key === "Escape") setFilterOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [filterOpen]);

  const toggleStatus = (key) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const clearFilters = () => setStatusFilter(new Set());

  const filtered = statusFilter.size === 0
    ? invoices
    : invoices.filter((inv) => statusFilter.has(inv.status));
  const isFiltered = statusFilter.size > 0;

  const handleDownloadReceipt = async (invoice) => {
    if (downloadingId) return;
    setDownloadingId(invoice.id);
    try {
      const { exportReceiptPdf } = await import("./pdfExport.js");
      exportReceiptPdf({
        invoice,
        customer: {
          name: user?.displayName ?? user?.email ?? "Customer",
          email: user?.email ?? "—",
        },
        plan: {
          name: subscription?.plan_name ?? "VocoTable Core Plan",
          description: "Monthly subscription — unlimited AI agent bookings",
        },
      });
    } catch (e) {
      // Surface to console; the row stays interactive so the user can retry.
      console.error("[billing] receipt export failed:", e);
    } finally {
      setDownloadingId(null);
    }
  };

  if (loading) {
    return (
      <DashboardShell active="Billing" navigate={navigate}>
        <header className="billing-header">
          <h1>Billing &amp; Subscription</h1>
          <p>Manage your payment methods and view past invoices.</p>
        </header>
        <p style={{ color: "var(--on-surface-variant)" }}>Loading billing…</p>
      </DashboardShell>
    );
  }

  if (error) {
    return (
      <DashboardShell active="Billing" navigate={navigate}>
        <header className="billing-header">
          <h1>Billing &amp; Subscription</h1>
          <p>Manage your payment methods and view past invoices.</p>
        </header>
        <p style={{ color: "var(--danger, #c00)" }}>
          Couldn’t load billing: {error}
        </p>
      </DashboardShell>
    );
  }

  const planName = subscription?.plan_name ?? "VocoTable Core Plan";
  const planAmount = subscription?.amount_display ?? "$80.00";
  const planInterval = subscription?.interval ?? "month";
  const nextBilling = subscription?.current_period_end
    ? formatInvoiceDate(subscription.current_period_end)
    : "—";

  return (
    <DashboardShell active="Billing" navigate={navigate}>
      <header className="billing-header">
        <h1>Billing & Subscription</h1>
        <p>Manage your payment methods and view past invoices.</p>
      </header>

      {enabled && mode === "test" && (
        <div className="billing-banner billing-banner-test" role="status">
          <Icon name="science" />
          <span>
            <strong>TEST MODE</strong> — these are Stripe test invoices, not real charges.
          </span>
        </div>
      )}
      {!enabled && (
        <div className="billing-banner billing-banner-info" role="status">
          <Icon name="info" />
          <span>
            Billing isn’t connected yet. Showing placeholder details until Stripe is enabled.
          </span>
        </div>
      )}

      <section className="billing-grid">
        <article className="plan-card">
          <div className="plan-glow" />
          <div className="plan-head">
            <div>
              <h2>
                {planName} <span>{subscription?.status ? capitalize(subscription.status) : "Active"}</span>
              </h2>
              <p>Flat rate monthly subscription for unlimited AI agent bookings.</p>
            </div>
            <Icon name="verified" fill className="verified-icon" />
          </div>
          <div className="plan-bottom">
            <div>
              <strong>
                {planAmount} <span>/ {planInterval}</span>
              </strong>
              <p>
                <Icon name="calendar_month" />
                Next billing date: {nextBilling}
              </p>
            </div>
            <button onClick={() => navigate("/manage-plan")}>Manage Plan</button>
          </div>
        </article>

        <article className="payment-card">
          <h2>Payment Method</h2>
          {defaultCard ? (
            <div className="card-line">
              <CardBrandIcon brand={defaultCard.brand} />
              <div className="card-line-meta">
                <p>
                  {defaultCard.brand} •••• {defaultCard.last4}
                </p>
                {defaultCard.expiry && <span>Expires {defaultCard.expiry}</span>}
              </div>
              <Icon name="check_circle" className="check-circle" />
            </div>
          ) : (
            <div className="card-line payment-card-empty">
              <div className="card-icon">
                <Icon name="credit_card_off" />
              </div>
              <div className="card-line-meta">
                <p>No card on file</p>
                <span>Add a card to keep your subscription active</span>
              </div>
            </div>
          )}
          <button onClick={() => navigate("/update-payment-details")}>
            {defaultCard ? "Manage Payment Methods" : "Add a card"}
            <Icon name="arrow_forward" />
          </button>
        </article>

        <article className="billing-history">
          <div className="billing-history-head">
            <h2>Billing History</h2>
            <div className="billing-filter-wrap" ref={filterRef}>
              <button
                type="button"
                className={filterOpen ? "is-open" : ""}
                onClick={() => setFilterOpen((v) => !v)}
                aria-expanded={filterOpen}
                aria-haspopup="menu"
              >
                <Icon name="filter_list" />
                Filter
                {statusFilter.size > 0 && (
                  <span className="filter-badge">{statusFilter.size}</span>
                )}
              </button>
              {filterOpen && (
                <div className="booking-filter-popover" role="menu">
                  <div className="booking-filter-head">
                    <span>Filter by status</span>
                    {statusFilter.size > 0 && (
                      <button type="button" onClick={clearFilters}>Clear</button>
                    )}
                  </div>
                  {INVOICE_STATUSES.map((opt) => {
                    const checked = statusFilter.has(opt.key);
                    return (
                      <label key={opt.key} className="booking-filter-option">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleStatus(opt.key)}
                        />
                        <span className={`invoice-status-dot ${opt.color}`} />
                        {opt.label}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          <div className="billing-history-body">
            <table>
              <thead>
                <tr>
                  <th>Invoice Date</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Receipt</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={4} style={{ textAlign: "center", color: "var(--on-surface-variant)" }}>
                      {isFiltered ? "No invoices match your filters." : "No invoices yet."}
                    </td>
                  </tr>
                ) : (
                  filtered.map((inv) => {
                    const status = INVOICE_STATUSES.find((s) => s.key === inv.status) ?? INVOICE_STATUSES[0];
                    return (
                      <tr key={inv.id}>
                        <td>{formatInvoiceDate(inv.issued_at)}</td>
                        <td>{inv.total_display ?? "—"}</td>
                        <td>
                          <span className={`invoice-status-dot ${status.color}`} />
                          {status.label}
                        </td>
                        <td>
                          <button
                            type="button"
                            aria-label={`Download ${inv.id} receipt`}
                            onClick={() => handleDownloadReceipt(inv)}
                            disabled={downloadingId === inv.id}
                            title="Download receipt PDF"
                          >
                            <Icon name={downloadingId === inv.id ? "hourglass_top" : "download"} />
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </article>
      </section>
    </DashboardShell>
  );
}

const PLAN_TIERS = [
  {
    id: "starter",
    name: "Starter",
    blurb: "Everything an independent restaurant needs to never miss a booking.",
    price: 80,
    period: "month",
    cta: "Switch to Starter",
    features: [
      "Bella answers every call, 24/7",
      "Books, modifies, cancels in your dashboard",
      "Up to 1,500 calls / month",
      "Standard call analytics",
      "Email support",
      "1 venue"
    ]
  },
  {
    id: "pro",
    name: "Pro",
    blurb: "For growing venues that want deeper insights and multi-site coverage.",
    price: 149,
    period: "month",
    featured: true,
    cta: "Upgrade to Pro",
    features: [
      "Everything in Starter",
      "Unlimited calls",
      "Up to 5 venues on one dashboard",
      "Advanced analytics & cohort retention",
      "Outbound confirmation calls (SMS)",
      "Priority support (1 business-day)"
    ]
  },
  {
    id: "enterprise",
    name: "Enterprise",
    blurb: "For hospitality groups with multiple venues and bespoke needs.",
    price: 349,
    period: "month",
    cta: "Contact sales",
    features: [
      "Everything in Pro",
      "Up to 50 venues",
      "99.9% uptime SLA",
      "White-label voice agents",
      "POS API access",
      "Dedicated success manager"
    ]
  }
];

function ManagePlanPage({ navigate }) {
  const [currentPlanId, setCurrentPlanId] = useState("starter");
  const [pendingTier, setPendingTier] = useState(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelStage, setCancelStage] = useState("confirming");

  const handleSelect = (tier) => {
    if (tier.id === currentPlanId) return;
    setPendingTier(tier);
  };

  const closePending = () => setPendingTier(null);

  const confirmPending = () => {
    if (!pendingTier) return;
    // Stripe wire-up lands when billing integration ships. For now optimistic
    // local-state move so QA can verify the UI path end-to-end.
    setCurrentPlanId(pendingTier.id);
    setPendingTier(null);
  };

  const openCancel = () => {
    setCancelStage("confirming");
    setCancelOpen(true);
  };

  const dismissCancel = () => {
    setCancelOpen(false);
    setCancelStage("confirming");
  };

  const confirmCancel = () => {
    setCancelStage("done");
  };

  return (
    <DashboardShell active="Billing" navigate={navigate}>
      <header className="billing-header manage-plan-header">
        <button
          type="button"
          className="back-button"
          onClick={() => navigate("/settings")}
          aria-label="Back to billing"
        >
          <Icon name="arrow_back" />
        </button>
        <div>
          <h1>Manage your plan</h1>
          <p>Change tier, pause or cancel your VocoTable subscription.</p>
        </div>
      </header>

      <section className="billing-grid">
        {PLAN_TIERS.map((tier) => {
          const isCurrent = tier.id === currentPlanId;
          const classes = [
            "plan-tier-card",
            tier.featured && !isCurrent ? "featured" : ""
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <article key={tier.id} className={classes}>
              <div className="plan-glow" />
              <div className="plan-tier-head">
                <h2>
                  {tier.name}
                  {isCurrent && <span className="plan-tier-pill">Current</span>}
                  {tier.featured && !isCurrent && (
                    <span className="plan-tier-pill">Recommended</span>
                  )}
                </h2>
                <p className="plan-tier-blurb">{tier.blurb}</p>
              </div>
              <div className="plan-tier-price">
                <strong>
                  ${tier.price} <span>/ {tier.period}</span>
                </strong>
              </div>
              <ul className="plan-tier-features">
                {tier.features.map((f) => (
                  <li key={f}>
                    <Icon name="check_circle" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="plan-tier-cta"
                disabled={isCurrent}
                onClick={() => handleSelect(tier)}
              >
                {isCurrent ? "Current plan" : tier.cta}
              </button>
            </article>
          );
        })}

        <article className="plan-faq-card">
          <h2>Common questions</h2>
          <details>
            <summary>How does billing work when I change plans?</summary>
            <p>
              We pro-rate the difference. If you upgrade mid-cycle, you&apos;re charged the prorated
              amount for the rest of the month. If you downgrade, the new lower rate kicks in on
              your next billing date.
            </p>
          </details>
          <details>
            <summary>What happens to my bookings if I cancel?</summary>
            <p>
              Every booking ever taken by Bella stays in your account permanently. You can export
              them as CSV any time. Cancelling stops new calls being answered — existing data is
              never deleted unless you explicitly request it.
            </p>
          </details>
          <details>
            <summary>Can I pause instead of cancelling?</summary>
            <p>
              Yes. Pause halts billing and disconnects Bella from your line, but keeps your
              account, FAQs, and historic data intact so you can resume instantly. Email us to
              pause; in the next release this becomes a one-click action.
            </p>
          </details>
        </article>

        <article className="plan-danger-card">
          <div>
            <h3>Cancel subscription</h3>
            <p>
              You&apos;ll keep access until the end of your current billing period. We&apos;ll send a
              confirmation email.
            </p>
          </div>
          <button type="button" onClick={openCancel}>
            Cancel subscription
          </button>
        </article>
      </section>

      {pendingTier && (
        <div
          className="plan-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="plan-change-title"
          onClick={closePending}
        >
          <div className="plan-modal" onClick={(e) => e.stopPropagation()}>
            <h2 id="plan-change-title">Switch to {pendingTier.name}?</h2>
            <p>
              You&apos;ll be moved to the {pendingTier.name} plan at{" "}
              <strong>
                ${pendingTier.price}/{pendingTier.period}
              </strong>
              .
              {pendingTier.id === "enterprise"
                ? " Our team will reach out to set up your contract."
                : " The change applies at your next billing date — no interruption to Bella."}
            </p>
            <div className="plan-modal-actions">
              <button type="button" onClick={closePending} className="ghost-button">
                Keep current plan
              </button>
              <button type="button" onClick={confirmPending} className="primary-button">
                {pendingTier.id === "enterprise"
                  ? "Request contact"
                  : `Confirm ${pendingTier.name}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {cancelOpen && (
        <div
          className="plan-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cancel-title"
          onClick={dismissCancel}
        >
          <div className="plan-modal" onClick={(e) => e.stopPropagation()}>
            {cancelStage === "confirming" ? (
              <>
                <h2 id="cancel-title">Cancel your subscription?</h2>
                <p>
                  Bella will keep answering until the end of your current billing period. After
                  that, calls fall back to your phone provider&apos;s voicemail.
                </p>
                <p>
                  Your historic call data and bookings stay accessible from this dashboard.
                </p>
                <div className="plan-modal-actions">
                  <button type="button" onClick={dismissCancel} className="ghost-button">
                    Keep my subscription
                  </button>
                  <button type="button" onClick={confirmCancel} className="danger-button">
                    Cancel subscription
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 id="cancel-title">
                  <Icon name="check_circle" /> Cancellation requested
                </h2>
                <p>
                  We&apos;ve received your cancellation request. You&apos;ll get a confirmation email
                  and Bella will keep working until your next billing date.
                </p>
                <div className="plan-modal-actions">
                  <button
                    type="button"
                    onClick={() => {
                      dismissCancel();
                      navigate("/settings");
                    }}
                    className="primary-button"
                  >
                    Back to Billing
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </DashboardShell>
  );
}

function UpdatePaymentDetailsPage({ navigate }) {
  const [cards, setCards] = useState([]);
  const [defaultId, setDefaultId] = useState(null);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [portalLoading, setPortalLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getBillingPaymentMethods()
      .then((pm) => {
        if (cancelled) return;
        setEnabled(Boolean(pm?.enabled));
        setCards(Array.isArray(pm?.payment_methods) ? pm.payment_methods : []);
        setDefaultId(pm?.default_payment_method_id ?? null);
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // Add / remove / set-default is delegated entirely to Stripe's hosted Customer
  // Portal — no raw card data ever touches our backend (PCI SAQ-A). This page is
  // a read-only mirror of the cards on file plus a redirect into the portal.
  const handleManagePayment = async () => {
    if (portalLoading) return;
    setPortalLoading(true);
    try {
      const { url } = await createBillingPortalSession();
      if (url) window.location.href = url;
      else setPortalLoading(false);
    } catch (e) {
      console.error("[billing] portal session failed:", e);
      setError(e.message);
      setPortalLoading(false);
    }
  };

  return (
    <DashboardShell active="Billing" navigate={navigate}>
      <header className="billing-header manage-plan-header">
        <button
          type="button"
          className="back-button"
          onClick={() => navigate("/settings")}
          aria-label="Back to billing"
        >
          <Icon name="arrow_back" />
        </button>
        <div>
          <h1>Payment methods</h1>
          <p>Cards on file are managed securely through Stripe.</p>
        </div>
      </header>

      <section className="payment-update-grid">
        <article className="payment-current-card">
          <div className="payment-current-head">
            <span className="payment-current-label">
              Saved cards <span className="payment-count">({cards.length})</span>
            </span>
          </div>

          {loading ? (
            <p style={{ color: "var(--on-surface-variant)" }}>Loading cards…</p>
          ) : error ? (
            <p style={{ color: "var(--danger, #c00)" }}>Couldn’t load cards: {error}</p>
          ) : !enabled ? (
            <div className="payment-empty">
              <Icon name="info" />
              <p>Billing isn’t connected yet.</p>
            </div>
          ) : cards.length === 0 ? (
            <div className="payment-empty">
              <Icon name="credit_card_off" />
              <p>No cards on file yet. Add one in the Stripe portal.</p>
            </div>
          ) : (
            <ul className="payment-card-list">
              {cards.map((card) => {
                const isDefault = card.is_default || card.id === defaultId;
                return (
                  <li key={card.id} className={`card-line${isDefault ? " is-default" : ""}`}>
                    <CardBrandIcon brand={card.brand} />
                    <div className="card-line-meta">
                      <p>
                        {card.brand} •••• {card.last4}
                      </p>
                      {card.expiry && <span>Expires {card.expiry}</span>}
                    </div>
                    {isDefault && <span className="payment-current-pill">Default</span>}
                  </li>
                );
              })}
            </ul>
          )}

          <p className="payment-current-hint">
            Add, remove, or change your default card in Stripe&apos;s secure portal. We never
            store full card numbers — payments are handled by our PCI-compliant processor.
          </p>

          <div className="payment-form-actions">
            <button
              type="button"
              className="ghost-button"
              onClick={() => navigate("/settings")}
            >
              Back to Billing
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={handleManagePayment}
              disabled={!enabled || portalLoading}
            >
              {portalLoading ? "Opening Stripe…" : "Manage payment methods"}
              <Icon name="open_in_new" />
            </button>
          </div>
        </article>
      </section>
    </DashboardShell>
  );
}

createRoot(document.getElementById("root")).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
