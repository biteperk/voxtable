import React, { Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { AuthProvider, useAuth } from "./auth";
import { signInWithGoogle, signOutUser } from "./firebase";
import {
  cancelReservation,
  getAnalytics,
  getAnalyticsDailySeries,
  getCallLog,
  listCallLogs,
  listReservations,
  updateReservationStatus
} from "./api";

const restaurantImage =
  "https://lh3.googleusercontent.com/aida-public/AB6AXuAgvs7qA0qHOd2Nob8Vl9D-gIFHp0BmQY1DOKvAMXDTT6bBAyL8U1lrq-MJV9hWv6MzfT7aNcQk6xL_pujBCXaCuo4ExjvEYGkRayK6-gLpd0Y8DC1Ob8QfyIyg9MMSyRAklEVHlsUdVxYc92Bl2bdKwZNbozxITISxFGSTMm1GFjFgG4jhDIby6jRZKnR_RslKyO96YbopcDOm2xoUgLx4eSTSXZli5KtJYcV_HcCcUo9FGjv2Bxy7pOCxyMYwTdf_kEv41JzNcmE";

// SSR-safe media query hook. Returns false on first render to avoid hydration
// mismatch (no SSR today, but future-proof) and syncs in an effect.
function useMediaQuery(query) {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const mql = window.matchMedia(query);
    const onChange = (event) => setMatches(event.matches);
    setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

const isBrowser = typeof window !== "undefined";

// Body scroll lock that survives iOS Safari rubber-banding. Records current
// scroll, pins body via position:fixed, restores on release.
function lockBodyScroll() {
  if (!isBrowser) return;
  const body = document.body;
  if (body.dataset.scrollLocked === "1") return;
  const scrollY = window.scrollY;
  body.style.position = "fixed";
  body.style.top = `-${scrollY}px`;
  body.style.left = "0";
  body.style.right = "0";
  body.style.width = "100%";
  body.dataset.scrollLocked = "1";
  body.dataset.scrollY = String(scrollY);
}
function unlockBodyScroll() {
  if (!isBrowser) return;
  const body = document.body;
  if (body.dataset.scrollLocked !== "1") return;
  const y = Number(body.dataset.scrollY || "0");
  body.style.position = "";
  body.style.top = "";
  body.style.left = "";
  body.style.right = "";
  body.style.width = "";
  delete body.dataset.scrollLocked;
  delete body.dataset.scrollY;
  window.scrollTo(0, y);
}

// Drawer state with browser history integration (Android back closes drawer),
// Esc-to-close, scroll lock, and focus return.
function useDrawer({ pathname, triggerRef } = {}) {
  const [isOpen, setIsOpen] = useState(false);
  const wasOpenRef = useRef(false);

  // Esc to close
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // popstate (system back) closes if our history entry is gone
  useEffect(() => {
    const onPop = () => {
      const state = window.history.state;
      if (!state || state.drawer !== "open") {
        if (wasOpenRef.current) {
          setIsOpen(false);
          wasOpenRef.current = false;
          unlockBodyScroll();
        }
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Lock scroll while open, restore focus on close
  useEffect(() => {
    if (isOpen) {
      lockBodyScroll();
      wasOpenRef.current = true;
    } else {
      unlockBodyScroll();
      if (wasOpenRef.current && triggerRef && triggerRef.current) {
        triggerRef.current.focus();
      }
      wasOpenRef.current = false;
    }
    return () => {
      // unmount safety
      if (isOpen) unlockBodyScroll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Auto-close on route change without polluting history
  useEffect(() => {
    if (isOpen) {
      setIsOpen(false);
      if (window.history.state && window.history.state.drawer === "open") {
        // remove our drawer history entry quietly
        window.history.back();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  function open() {
    if (isOpen) return;
    try {
      window.history.pushState({ drawer: "open" }, "");
    } catch {
      // history API can throw in odd embeddings; non-fatal
    }
    setIsOpen(true);
  }
  function close() {
    if (!isOpen) return;
    if (window.history.state && window.history.state.drawer === "open") {
      window.history.back();
    } else {
      setIsOpen(false);
    }
  }
  function toggle() {
    isOpen ? close() : open();
  }

  return { isOpen, open, close, toggle };
}

// Toggle .is-scrolled on a sentinel intersection so the top bar can show a
// hairline + slight blur lift only when content is underneath.
function useScrolled() {
  const [scrolled, setScrolled] = useState(false);
  const sentinelRef = useRef(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return undefined;
    const io = new IntersectionObserver(
      ([entry]) => setScrolled(!entry.isIntersecting),
      { threshold: 0 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return { scrolled, sentinelRef };
}

function Icon({ name, fill = false, className = "" }) {
  return (
    <span
      className={`material-symbols-outlined ${className}`}
      style={{
        fontFamily: '"Material Symbols Outlined"',
        fontFeatureSettings: '"liga"',
        fontVariationSettings: `'FILL' ${fill ? 1 : 0}, 'wght' 400`
      }}
    >
      {name}
    </span>
  );
}

// --- Cal.com booking modal (lazy-loaded) ------------------------------------
// The Cal.com embed package is ~120 KB gzipped — too much to ship eagerly on
// the marketing landing page. React.lazy with dynamic import means the
// browser only fetches it the first time a visitor clicks "Book online".
// Loading state below covers the few hundred ms.

const CalcomEmbed = React.lazy(() => import("@calcom/embed-react"));

const CALCOM_CAL_LINK = import.meta.env.VITE_CALCOM_CAL_LINK || "";
const CALCOM_NAMESPACE = import.meta.env.VITE_CALCOM_NAMESPACE || "vocotable-bookings";

export function isCalcomConfigured() {
  return Boolean(CALCOM_CAL_LINK);
}

/**
 * Reusable "embed failed — call us instead" card. Same content for both
 * timeout and error fallbacks; placed inline (not a portal) so it sits
 * inside the same modal body slot as the embed would have.
 */
function EmbedFailedFallback({ reason }) {
  return (
    <div className="book-modal-fallback" role="alert" aria-live="assertive">
      <Icon name="error_outline" />
      <h2>Booking widget unavailable</h2>
      <p>
        {reason ||
          "Our online booking didn't load. This can happen if an ad-blocker or your network is filtering Cal.com."}
      </p>
      <a href="tel:+61275011140" className="book-modal-fallback-cta">
        <Icon name="phone_in_talk" />
        Call us on +61 2 7501 1140
      </a>
      <p className="book-modal-fallback-hint">
        Or try reloading. Bella's available 24/7 by phone.
      </p>
    </div>
  );
}

/**
 * Error boundary specifically for the Cal.com embed. Catches both
 * React.lazy chunk-load failures (`ChunkLoadError` thrown during the
 * dynamic import) and runtime errors inside the embed iframe wrapper.
 * Silently logs to console and falls back to the call-us card so the
 * user always has a recovery path.
 */
class EmbedErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error("[vocotable] BookOnline embed error:", {
      name: error?.name,
      message: error?.message?.slice(0, 200),
      componentStack: info?.componentStack?.split("\n").slice(0, 4).join("\n")
    });
  }

  render() {
    if (this.state.error) {
      const isChunk =
        this.state.error?.name === "ChunkLoadError" ||
        /Loading chunk|Failed to fetch dynamically imported module/i.test(
          String(this.state.error?.message ?? "")
        );
      return (
        <EmbedFailedFallback
          reason={
            isChunk
              ? "We couldn't download the booking widget. Your network might be filtering Cal.com."
              : undefined
          }
        />
      );
    }
    return this.props.children;
  }
}

/**
 * Time-bounds the Suspense fallback. If the embed hasn't rendered (i.e.
 * we're still inside the Suspense spinner) after `timeoutMs`, replace the
 * children entirely with the call-us card. Covers the case where the
 * lazy chunk loads fine but Cal.com itself never paints (CSP, outage,
 * blocked iframe).
 */
function EmbedTimeoutFallback({ timeoutMs, children }) {
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setTimedOut(true), timeoutMs);
    return () => clearTimeout(t);
  }, [timeoutMs]);

  if (timedOut) {
    return <EmbedFailedFallback />;
  }
  return children;
}

/**
 * Full-screen modal hosting the Cal.com embed. Reuses the same a11y +
 * scroll-lock pattern as the dashboard drawer (`useDrawer` hook):
 *   - body scroll lock survives iOS rubber-banding
 *   - Esc closes
 *   - backdrop click closes
 *   - browser back closes (we pushState on open)
 *   - focus returns to the trigger on close
 *   - outside content gets `inert` so screen readers / tab stops can't escape
 */
function BookOnlineModal({ open, onClose, triggerRef }) {
  const titleId = useId();

  // Esc key
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // History-back closes (Android system back, browser back)
  useEffect(() => {
    if (!open) return undefined;
    try {
      window.history.pushState({ bookModal: "open" }, "");
    } catch {
      /* harmless in non-browser contexts */
    }
    const onPop = () => onClose();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [open, onClose]);

  // Body scroll lock — same iOS-Safari-safe pattern as the dashboard drawer.
  useEffect(() => {
    if (!open) return undefined;
    const body = document.body;
    const scrollY = window.scrollY;
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.left = "0";
    body.style.right = "0";
    body.style.width = "100%";
    return () => {
      body.style.position = "";
      body.style.top = "";
      body.style.left = "";
      body.style.right = "";
      body.style.width = "";
      window.scrollTo(0, scrollY);
    };
  }, [open]);

  // Return focus to the trigger when the modal closes.
  useEffect(() => {
    if (open) return undefined;
    return () => {
      if (triggerRef && triggerRef.current) {
        triggerRef.current.focus();
      }
    };
  }, [open, triggerRef]);

  // When the modal isn't open we render NOTHING — no DOM, no listeners, no
  // Cal.com script in the bundle. The lazy chunk only fetches when `open`
  // flips true the first time.
  if (!open) return null;

  return (
    <div
      className="book-modal-root"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div className="book-modal-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="book-modal-card">
        <header className="book-modal-head">
          <h2 id={titleId}>Book a table</h2>
          <button
            type="button"
            className="book-modal-close"
            onClick={onClose}
            aria-label="Close booking dialog"
          >
            <Icon name="close" />
          </button>
        </header>
        <div className="book-modal-body">
          {/* Audit Sweep E: wrap embed in EmbedErrorBoundary (catches chunk
              load failures + Cal.com render errors) + EmbedTimeout (shows
              fallback if the embed doesn't paint within 10s — covers ad
              blockers, CSP misconfig, Cal.com outage). Tel-link gives the
              caller an immediate recovery path. */}
          <EmbedErrorBoundary>
            <EmbedTimeoutFallback timeoutMs={10000}>
              <Suspense
                fallback={
                  <div className="book-modal-loading" role="status" aria-live="polite">
                    <span className="book-modal-spinner" aria-hidden="true" />
                    <span>Loading booking…</span>
                  </div>
                }
              >
                <CalcomEmbed
                  namespace={CALCOM_NAMESPACE}
                  calLink={CALCOM_CAL_LINK}
                  style={{ width: "100%", height: "100%", overflow: "auto" }}
                  config={{
                    layout: "month_view",
                    theme: "dark"
                  }}
                />
              </Suspense>
            </EmbedTimeoutFallback>
          </EmbedErrorBoundary>
        </div>
      </div>
    </div>
  );
}

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
    path === "/booking-log" ||
    path === "/analytics" ||
    path === "/settings" ||
    path === "/profile";

  return (
    <AuthProvider>
      <AppRouter path={path} navigate={navigate} isDashboard={isDashboard} />
    </AuthProvider>
  );
}

function AppRouter({ path, navigate, isDashboard }) {
  const { user, loading } = useAuth();

  if (isDashboard && loading) {
    return <FullPageMessage title="Loading..." />;
  }

  if (isDashboard && !user) {
    return <LoginScreen navigate={navigate} />;
  }

  // /live-feed/<id> — detail page for a single call (id is uuid)
  const detailMatch = path.match(/^\/live-feed\/([^/]+)$/);
  if (detailMatch && detailMatch[1] !== "detail") {
    return <LiveFeedDetailPage navigate={navigate} callId={detailMatch[1]} path={path} />;
  }
  // legacy mock route — keep for backward compatibility, navigates back to list
  if (path === "/live-feed/detail") return <LiveFeedOverviewPage navigate={navigate} path={path} />;

  if (path === "/live-feed") return <LiveFeedOverviewPage navigate={navigate} path={path} />;
  if (path === "/live-tables") return <LiveTablesPage navigate={navigate} path={path} />;
  if (path === "/booking-log") return <BookingLogPage navigate={navigate} path={path} />;
  if (path === "/analytics") return <AnalyticsPage navigate={navigate} path={path} />;
  if (path === "/settings") return <BillingPage navigate={navigate} path={path} />;
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

function LandingPage({ navigate }) {
  const { user } = useAuth();
  // Account icon goes to the dashboard. If you're not signed in the dashboard
  // route bounces you to the LoginScreen automatically (AppRouter gate).
  const goToDashboard = () => navigate("/live-feed");

  // Book-online modal state. The trigger ref is so focus returns to the
  // button on close — same pattern as the dashboard drawer's hamburger.
  // `isCalcomConfigured()` checks the build-time VITE_CALCOM_CAL_LINK env var
  // so the button is HIDDEN on builds that haven't configured Cal.com yet
  // (no broken CTA shipping to prod ahead of the canary).
  const [bookOpen, setBookOpen] = useState(false);
  const bookTriggerRef = useRef(null);
  const showBookButton = isCalcomConfigured();
  const openBookModal = () => setBookOpen(true);
  const closeBookModal = useCallback(() => setBookOpen(false), []);

  return (
    <div className="landing-shell">
      <nav className="top-nav">
        <button
          className="brand-button"
          onClick={() => navigate("/")}
          aria-label="VocoTable home"
        >
          <img
            src="/brand/mark-light-on-dark.svg"
            alt=""
            className="brand-mark"
            width="32"
            height="32"
          />
          <span>VocoTable</span>
        </button>
        <div className="top-icons">
          {user ? (
            <button
              type="button"
              className="nav-cta"
              onClick={goToDashboard}
              aria-label="Go to dashboard"
            >
              <Icon name="dashboard" />
              <span>Dashboard</span>
            </button>
          ) : (
            <button
              type="button"
              className="nav-cta nav-cta-ghost"
              onClick={goToDashboard}
              aria-label="Sign in"
            >
              <Icon name="login" />
              <span>Sign in</span>
            </button>
          )}
          <button
            className="icon-button account-icon"
            aria-label={user ? `Signed in as ${user.email}` : "Sign in"}
            onClick={goToDashboard}
            title={user ? `Signed in as ${user.email} — go to dashboard` : "Sign in"}
          >
            {user?.photoURL ? (
              <img src={user.photoURL} alt="" />
            ) : (
              <Icon name="account_circle" />
            )}
          </button>
        </div>
      </nav>

      <main>
        <section className="hero-section">
          <div className="hero-glow" />
          <div className="hero-content">
            <h1>Your AI Front of House</h1>
            <p>
              Never miss a booking. Our natural-sounding Australian AI handles calls 24/7. All
              for a flat rate of $80/month. No cover fees. No sick leave.
            </p>
            <div className="hero-actions">
              <button
                type="button"
                className="primary-action"
                onClick={() => window.open("tel:+61275011140")}
              >
                <Icon name="phone_in_talk" />
                Call the AI
              </button>
              {showBookButton && (
                <button
                  ref={bookTriggerRef}
                  type="button"
                  className="secondary-action book-online-cta"
                  onClick={openBookModal}
                  aria-haspopup="dialog"
                  aria-expanded={bookOpen}
                >
                  <Icon name="event_available" />
                  Book online
                </button>
              )}
              <button
                type="button"
                className="secondary-action"
                onClick={goToDashboard}
              >
                {user ? "Open dashboard" : "Get started"}
              </button>
            </div>
            <VoiceDemo />
          </div>
        </section>

        <section className="features-section">
          <h2>Precision Engineered for Hospitality</h2>
          <div className="feature-grid">
            <FeatureCard
              icon="support_agent"
              title="24/7 Answering"
              text="Capture every booking, even during the busiest dinner rush or after hours. VocoTable never sleeps."
              tone="primary"
            />
            <FeatureCard
              icon="record_voice_over"
              title="Local Accent"
              text="A natural, conversational Australian voice model that understands local nuances and hospitality terms."
              tone="secondary"
            />
            <FeatureCard
              icon="money_off"
              title="Zero Cover Fees"
              text="Stop paying per-seat booking fees. We charge a flat monthly rate, regardless of volume."
              tone="tertiary"
            />
          </div>
        </section>

        <section className="pricing-section">
          <div className="pricing-heading">
            <h2>Transparent, Predictable Pricing</h2>
            <p>No complex tiers. No hidden per-cover costs.</p>
          </div>
          <div className="pricing-grid">
            <div className="old-way-card">
              <h3>The Old Way</h3>
              <div className="old-price">
                $100+<span>/mo</span>
              </div>
              <ul>
                <li>
                  <Icon name="close" /> Per-cover booking fees
                </li>
                <li>
                  <Icon name="close" /> Missed calls during rush
                </li>
                <li>
                  <Icon name="close" /> Staff tied to the phone
                </li>
              </ul>
            </div>
            <div className="voco-price-card">
              <span className="flat-rate">Flat Rate</span>
              <h3>VocoTable</h3>
              <div className="price">
                $80<span>/mo</span>
              </div>
              <ul>
                <li>
                  <Icon name="check" /> Zero per-cover fees
                </li>
                <li>
                  <Icon name="check" /> Unlimited AI answering
                </li>
                <li>
                  <Icon name="check" /> Seamless integration
                </li>
              </ul>
              <button onClick={() => navigate("/live-feed")}>
                {user ? "Open dashboard" : "Start free trial"}
              </button>
            </div>
          </div>
        </section>
      </main>
      {/* Modal renders ONLY when bookOpen flips true — the Cal.com JS chunk
          isn't fetched until first open (React.lazy + Suspense). Hidden
          entirely on builds where VITE_CALCOM_CAL_LINK is unset. */}
      {showBookButton && (
        <BookOnlineModal
          open={bookOpen}
          onClose={closeBookModal}
          triggerRef={bookTriggerRef}
        />
      )}
    </div>
  );
}

function VoiceDemo() {
  const bars = [32, 48, 28, 56, 40, 18, 62, 32];
  return (
    <div className="voice-demo">
      <div className="voice-demo-head">
        <span>Live Demo</span>
        <strong>
          <i />
          Listening
        </strong>
      </div>
      <div className="voice-bars" aria-hidden="true">
        {bars.map((height, index) => (
          <span
            key={height + index}
            style={{ height }}
            className={index % 2 === 0 ? "bar-primary" : "bar-secondary"}
          />
        ))}
      </div>
    </div>
  );
}

function FeatureCard({ icon, title, text, tone }) {
  return (
    <article className="feature-card">
      <div className={`feature-icon ${tone}`}>
        <Icon name={icon} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
    </article>
  );
}

function DashboardShell({ active, children, navigate, path }) {
  const { user } = useAuth();
  const isPhone = useMediaQuery("(max-width: 767px)");
  const burgerRef = useRef(null);
  const drawer = useDrawer({ pathname: path, triggerRef: burgerRef });
  const { scrolled, sentinelRef } = useScrolled();
  const drawerTitleId = useId();

  const items = [
    ["Live Tables", "table_restaurant", "/live-tables"],
    ["Live Feed", "graphic_eq", "/live-feed"],
    ["Booking Log", "menu_book", "/booking-log"],
    ["Analytics", "query_stats", "/analytics"]
  ];

  const handleSignOut = async () => {
    await signOutUser();
    navigate("/");
  };

  const sidebarMarkup = (
    <aside
      className="sidebar analytics-sidebar"
      role={isPhone ? "dialog" : undefined}
      aria-modal={isPhone ? "true" : undefined}
      aria-labelledby={isPhone ? drawerTitleId : undefined}
    >
      <div className="sidebar-top">
        <h2 id={drawerTitleId} className="sr-only">
          Menu
        </h2>
        <button
          className="dashboard-brand"
          onClick={() => navigate("/")}
          aria-label="VocoTable home"
        >
          <img
            src="/brand/mark-light-on-dark.svg"
            alt=""
            className="brand-mark"
            width="36"
            height="36"
          />
          <span className="dashboard-brand-text">
            <strong>VocoTable</strong>
            <span>Restaurant AI Hub</span>
          </span>
        </button>
      </div>

      <nav className="side-links" aria-label="Primary">
        {items.map(([label, icon, route]) => {
          const isActive = active === label;
          const isPending = !route;

          return (
            <button
              key={label}
              type="button"
              className={`${isActive ? "active" : ""} ${isPending ? "pending" : ""}`.trim()}
              onClick={() => {
                if (route) {
                  navigate(route);
                }
              }}
              aria-disabled={isPending}
              aria-current={isActive ? "page" : undefined}
            >
              <Icon name={icon} fill={isActive} />
              <span>{label}</span>
            </button>
          );
        })}
      </nav>

      <div className="sidebar-bottom">
        <button
          className={`settings-link ${active === "Billing" ? "active" : ""}`}
          type="button"
          onClick={() => navigate("/settings")}
          aria-current={active === "Billing" ? "page" : undefined}
        >
          <Icon name="credit_card" fill={active === "Billing"} />
          <span>Billing</span>
        </button>

        <SidebarUserButton
          user={user}
          active={active === "Profile"}
          onClick={() => navigate("/profile")}
        />
      </div>
    </aside>
  );

  if (!isPhone) {
    return (
      <div className="dashboard-shell">
        {sidebarMarkup}
        <main className="dashboard-content">{children}</main>
      </div>
    );
  }

  // Phone: top bar + drawer + scrollable main
  const initial = (user?.displayName || user?.email || "?").trim().charAt(0).toUpperCase();
  return (
    <div className="mobile-shell">
      <a href="#mobile-main" className="skip-link">
        Skip to content
      </a>
      <header className={`mobile-topbar ${scrolled ? "is-scrolled" : ""}`}>
        <button
          ref={burgerRef}
          type="button"
          className="mobile-topbar-burger"
          aria-label={drawer.isOpen ? "Close menu" : "Open menu"}
          aria-expanded={drawer.isOpen}
          aria-controls="primary-drawer"
          onClick={drawer.toggle}
        >
          <Icon name="menu" />
        </button>
        <button
          type="button"
          className="mobile-topbar-brand"
          onClick={() => navigate("/")}
          aria-label="VocoTable home"
        >
          <img
            src="/brand/mark-light-on-dark.svg"
            alt=""
            width="28"
            height="28"
          />
          <span>{active || "VocoTable"}</span>
        </button>
        <button
          type="button"
          className="mobile-topbar-avatar"
          onClick={() => navigate("/settings")}
          aria-label={user?.email ? `Account · ${user.email}` : "Account"}
        >
          {user?.photoURL ? (
            <img src={user.photoURL} alt="" />
          ) : (
            <span aria-hidden="true">{initial}</span>
          )}
        </button>
      </header>

      <div ref={sentinelRef} aria-hidden="true" className="topbar-sentinel" />

      <div
        className={`drawer-backdrop ${drawer.isOpen ? "is-open" : ""}`}
        onClick={drawer.close}
        aria-hidden="true"
      />
      <div
        id="primary-drawer"
        className={`drawer ${drawer.isOpen ? "is-open" : ""}`}
        // eslint-disable-next-line react/no-unknown-property
        inert={!drawer.isOpen ? "" : undefined}
      >
        {sidebarMarkup}
      </div>

      <main
        id="mobile-main"
        className="dashboard-content mobile-main"
        // eslint-disable-next-line react/no-unknown-property
        inert={drawer.isOpen ? "" : undefined}
      >
        {children}
      </main>
    </div>
  );
}

function SidebarUserButton({ user, active, onClick }) {
  return (
    <button
      className={`sidebar-user ${active ? "active" : ""}`}
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
    >
      <img src={user?.photoURL ?? restaurantImage} alt="" />
      <div>
        <strong>{user?.displayName ?? "User"}</strong>
        <span>{user?.email ?? ""}</span>
      </div>
      <Icon name="chevron_right" className="sidebar-user-chevron" />
    </button>
  );
}

function DashboardTopIcons() {
  return (
    <div className="dashboard-top-icons">
      <button aria-label="Notifications">
        <Icon name="notifications" />
      </button>
      <button aria-label="Account">
        <Icon name="account_circle" />
      </button>
    </div>
  );
}

// Live Feed polls every 5 s for fresh call activity. Plan: "Live Feed: 3-5
// second interval during soft launch." Keep the loading flag for the very
// first fetch only — subsequent refreshes update silently in the background.
const LIVE_FEED_POLL_MS = 5000;

function LiveFeedOverviewPage({ navigate, path }) {
  const [callLogs, setCallLogs] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const isPhone = useMediaQuery("(max-width: 767px)");

  useEffect(() => {
    let cancelled = false;

    const fetchAll = (isInitial) =>
      Promise.all([listCallLogs({ limit: 25 }), getAnalytics({ days: 1 })])
        .then(([calls, stats]) => {
          if (cancelled) return;
          setCallLogs(calls.call_logs ?? []);
          setAnalytics(stats.analytics ?? null);
          if (error) setError(null);
        })
        .catch((e) => {
          if (cancelled) return;
          // Only surface errors during the first fetch — silent retries
          // shouldn't replace a working list with an error banner.
          if (isInitial) setError(e.message);
        })
        .finally(() => {
          if (cancelled || !isInitial) return;
          setLoading(false);
        });

    fetchAll(true);
    const interval = setInterval(() => {
      if (document.hidden) return;
      fetchAll(false);
    }, LIVE_FEED_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const callRows = useMemo(() => {
    const rows = callLogs.map((row, i) => mapCallLogToRow(row, i));
    // Live calls float to the top, then most recent first.
    return rows.sort((a, b) => {
      if (a.status === "live" && b.status !== "live") return -1;
      if (b.status === "live" && a.status !== "live") return 1;
      return 0;
    });
  }, [callLogs]);
  const totalCalls = analytics?.total_calls ?? 0;
  const activeCalls = callRows.filter((r) => r.status === "live").length;
  const successRate =
    analytics && analytics.total_calls > 0
      ? `${Math.round((analytics.handled / analytics.total_calls) * 100)}%`
      : "—";

  return (
    <DashboardShell active="Live Feed" navigate={navigate} path={path}>

      <header className="operational-header">
        <div>
          <h1>Live Feed</h1>
          <p>Real-time overview of all AI call activity.</p>
        </div>
      </header>

      {/* Summary Cards */}
      <section className="feed-summary-cards">
        <article className="feed-stat-card">
          <div className="feed-stat-top">
            <span className="feed-stat-label">Total Calls Today</span>
            <Icon name="phone_in_talk" className="feed-stat-icon" />
          </div>
          <div className="feed-stat-bottom">
            <span className="feed-stat-value">{loading ? "…" : totalCalls}</span>
            <span className="feed-stat-sub">Last 24h</span>
          </div>
        </article>

        <article className="feed-stat-card feed-stat-active">
          <div className="feed-stat-top">
            <span className="feed-stat-label">Active Calls</span>
            <div className="feed-stat-live-dot">
              <span className="live-ping" />
              <span className="live-core" />
            </div>
          </div>
          <div className="feed-stat-bottom">
            <span className="feed-stat-value accent">{loading ? "…" : activeCalls}</span>
            <span className="feed-stat-sub">Live Now</span>
          </div>
        </article>

        <article className="feed-stat-card">
          <div className="feed-stat-top">
            <span className="feed-stat-label">AI Success Rate</span>
            <Icon name="auto_awesome" className="feed-stat-icon" />
          </div>
          <div className="feed-stat-bottom">
            <span className="feed-stat-value">{loading ? "…" : successRate}</span>
            <span className="feed-stat-sub">Handled w/o transfer</span>
          </div>
        </article>
      </section>

      {/* Recent Activity Table */}
      <section className="feed-activity-card">
        <div className="feed-activity-header">
          <h2>Recent Activity</h2>
          <div className="feed-activity-actions">
            <button className="feed-action-btn">
              <Icon name="filter_list" /> Filter
            </button>
            <button className="feed-action-btn">
              <Icon name="download" /> Export
            </button>
          </div>
        </div>

        {isPhone ? (
          <ul className="feed-card-list" aria-label="Recent calls">
            {callRows.length === 0 && !loading && (
              <li className="feed-card-empty">No calls yet.</li>
            )}
            {callRows.map((row) => (
              <FeedCardItem
                key={row.id}
                row={row}
                onClick={() => navigate(`/live-feed/${row.id}`)}
              />
            ))}
          </ul>
        ) : (
          <div className="feed-table-wrap">
            <table className="feed-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Status</th>
                  <th>Intent</th>
                  <th>Duration</th>
                  <th>Time Snapshot</th>
                  <th className="text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {callRows.map((row) => (
                  <FeedCallRow
                    key={row.id}
                    row={row}
                    onClick={() => navigate(`/live-feed/${row.id}`)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="feed-table-footer">
          <span>
            {loading
              ? "Loading…"
              : error
              ? `Error: ${error}`
              : `${callRows.length} call${callRows.length === 1 ? "" : "s"}`}
          </span>
        </div>
      </section>
    </DashboardShell>
  );
}

const INTENT_LABEL = {
  book: "New booking",
  modify: "Modify booking",
  cancel: "Cancellation",
  info: "Info / FAQ",
  other: "Other"
};

function humanizeIntent(row) {
  if (row.intent && INTENT_LABEL[row.intent]) return INTENT_LABEL[row.intent];
  if (row.reservation_id) return "Booking";
  if (row.summary) return row.summary.slice(0, 40);
  return "Inbound call";
}

// Calls without an ended_at older than this are treated as stale (Retell
// end-of-call webhook never landed) rather than "live forever".
const LIVE_THRESHOLD_MS = 10 * 60 * 1000;

function mapCallLogToRow(row, index) {
  const ended = !!row.ended_at;
  const started = row.started_at ? new Date(row.started_at) : new Date(row.created_at);
  const recent = Date.now() - started.getTime() < LIVE_THRESHOLD_MS;
  const isLive = !ended && recent;
  const status = isLive ? "live" : row.transferred_to_staff ? "transferred" : "handled";
  const durationSec =
    typeof row.duration_seconds === "number"
      ? row.duration_seconds
      : ended
        ? Math.max(0, Math.round((new Date(row.ended_at) - started) / 1000))
        : null;
  const tones = ["neutral", "secondary", "tertiary"];

  return {
    id: row.id,
    name: row.caller_phone ? "Caller" : "Unknown Caller",
    initials: null,
    phone: row.caller_phone ?? "Unknown",
    status,
    intent: humanizeIntent(row),
    duration: durationSec != null ? formatDuration(durationSec) : "—",
    time: started.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: true }),
    timeNote: relativeTime(started),
    avatarTone: tones[index % tones.length]
  };
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function relativeTime(date) {
  const diffMs = Date.now() - date.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function FeedCallRow({ row, onClick }) {
  const isLive = row.status === "live";

  return (
    <tr
      className={`feed-row ${isLive ? "feed-row-live" : ""}`}
      onClick={onClick}
    >
      <td>
        <div className="feed-customer">
          <div className={`feed-avatar ${row.avatarTone}`}>
            {row.initials ? (
              row.initials
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/>
              </svg>
            )}
          </div>
          <div>
            <strong>{row.name}</strong>
            <span className={isLive ? "phone-live" : ""}>{row.phone}</span>
          </div>
        </div>
      </td>
      <td>
        {isLive && (
          <span className="feed-badge feed-badge-live">
            <span className="feed-badge-ping" />
            <span className="feed-badge-core" />
            LIVE NOW
          </span>
        )}
        {row.status === "handled" && (
          <span className="feed-badge feed-badge-handled">
            <Icon name="check_circle" /> Handled by AI
          </span>
        )}
        {row.status === "transferred" && (
          <span className="feed-badge feed-badge-transferred">
            <Icon name="call_split" /> Transferred
          </span>
        )}
      </td>
      <td className="feed-intent">{row.intent}</td>
      <td className={`feed-duration ${isLive ? "accent" : ""}`}>{row.duration}</td>
      <td>
        <div className="feed-time">
          <strong>{row.time}</strong>
          <span className={isLive ? "time-note-live" : ""}>{row.timeNote}</span>
        </div>
      </td>
      <td className="text-right">
        {isLive ? (
          <button className="feed-listen-btn" aria-label="Listen in">
            <Icon name="headset_mic" />
          </button>
        ) : (
          <button className="feed-chevron-btn" aria-label="View details">
            <Icon name="chevron_right" />
          </button>
        )}
      </td>
    </tr>
  );
}

function FeedCardItem({ row, onClick }) {
  const isLive = row.status === "live";
  return (
    <li className={`feed-card ${isLive ? "feed-card-live" : ""}`}>
      <button type="button" className="feed-card-button" onClick={onClick}>
        <div className="feed-card-row feed-card-row-top">
          <div className="feed-card-identity">
            <div className={`feed-avatar ${row.avatarTone}`} aria-hidden="true">
              {row.initials || (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z" />
                </svg>
              )}
            </div>
            <div className="feed-card-name">
              <strong>{row.name}</strong>
              <span>{row.phone}</span>
            </div>
          </div>
          <div className="feed-card-time">
            <strong>{row.time}</strong>
            <span>{row.timeNote}</span>
          </div>
        </div>
        <div className="feed-card-row feed-card-row-meta">
          {isLive ? (
            <span className="feed-badge feed-badge-live">
              <span className="feed-badge-ping" />
              <span className="feed-badge-core" />
              LIVE
            </span>
          ) : row.status === "handled" ? (
            <span className="feed-badge feed-badge-handled">
              <Icon name="check_circle" /> Handled
            </span>
          ) : row.status === "transferred" ? (
            <span className="feed-badge feed-badge-transferred">
              <Icon name="call_split" /> Transferred
            </span>
          ) : null}
          <span className="feed-card-intent">{row.intent}</span>
          <span className={`feed-card-duration ${isLive ? "accent" : ""}`}>
            <Icon name="timer" />
            {row.duration}
          </span>
        </div>
      </button>
    </li>
  );
}

function LiveFeedDetailPage({ navigate, callId, path }) {
  const [callLog, setCallLog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const isPhone = useMediaQuery("(max-width: 767px)");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getCallLog(callId)
      .then((res) => !cancelled && setCallLog(res.call_log ?? null))
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [callId]);

  const messages = parseTranscript(callLog?.transcript);
  const isLive = !!callLog && !callLog.ended_at;
  const durationLabel =
    callLog?.duration_seconds != null ? formatDuration(callLog.duration_seconds) : "—";
  const intentLabel = callLog ? humanizeIntent(callLog) : "—";
  const sentiment = callLog?.user_sentiment ?? null;
  const outcome = callLog?.booking_outcome ?? null;

  return (
    <DashboardShell active="Live Feed" navigate={navigate} path={path}>
      <header className="operational-header">
        <div className="detail-header-left">
          <button
            className="back-button"
            onClick={() => navigate("/live-feed")}
            aria-label="Back to Live Feed"
          >
            <Icon name="arrow_back" />
          </button>
          <div>
            <h1>Call detail</h1>
            <p>
              {loading
                ? "Loading…"
                : error
                  ? `Error: ${error}`
                  : callLog
                    ? `${callLog.caller_phone ?? "Unknown caller"} · ${durationLabel}`
                    : "Call not found"}
            </p>
          </div>
        </div>
        {isLive ? (
          <div className="active-call-pill">
            <PulseBars small />
            <span>Live</span>
          </div>
        ) : (
          <div className="active-call-pill" style={{ opacity: 0.6 }}>
            <span>{callLog?.status ?? "ended"}</span>
          </div>
        )}
      </header>

      <section className="live-feed-grid">
        <article className="active-call-card">
          <div className="active-call-head">
            <div className="agent-identity">
              <div className="agent-avatar">B</div>
              <div>
                <strong>Bella (AI Agent)</strong>
                <span>
                  {isLive
                    ? `In call with ${callLog?.caller_phone ?? "unknown"}`
                    : callLog?.caller_phone ?? "Unknown caller"}
                </span>
              </div>
            </div>
            <time>{durationLabel}</time>
          </div>

          <div className="transcript-stream">
            {loading && <p style={{ color: "#94a3b8", padding: 12 }}>Loading transcript…</p>}
            {!loading && messages.length === 0 && (
              <p style={{ color: "#64748b", padding: 12 }}>
                No transcript captured for this call.
              </p>
            )}
            {messages.map((message, index) => (
              <TranscriptBubble key={index} message={message} delay={index} />
            ))}
          </div>

          {callLog?.recording_url && (
            <div className="call-control-bar">
              <a
                href={callLog.recording_url}
                target="_blank"
                rel="noopener noreferrer"
                className="listen-button"
              >
                <Icon name="headphones" />
                Listen to recording
              </a>
            </div>
          )}
        </article>

        <aside className="call-side-panel">
          <article className="live-card">
            <h2>Call metrics</h2>
            <div className="live-metric-grid">
              <div>
                <span>
                  <Icon name="speed" />
                  Latency
                </span>
                <strong>
                  {callLog?.latency_ms != null ? callLog.latency_ms : "—"} <small>ms</small>
                </strong>
              </div>
              <div>
                <span>
                  <Icon name="timer" />
                  Duration
                </span>
                <strong className="blue">{durationLabel}</strong>
              </div>
            </div>
            <div className="intent-row">
              <span>Intent</span>
              <div>
                <i />
              </div>
              <strong>{intentLabel}</strong>
            </div>
          </article>

          <article className="context-card">
            <h2>Outcome</h2>
            <div className="context-line" />
            <ContextItem
              icon="event_available"
              label="Booking outcome"
              value={outcome ? humanizeOutcome(outcome) : "—"}
            />
            <ContextItem
              icon="mood"
              label="Caller sentiment"
              value={sentiment ? capitalize(sentiment) : "—"}
            />
            <ContextItem
              icon="voicemail"
              label="Voicemail"
              value={callLog?.in_voicemail ? "Yes" : "No"}
            />
            {callLog?.special_requests && (
              <div className="context-note">
                <span>Special requests</span>
                <p>{callLog.special_requests}</p>
              </div>
            )}
            {callLog?.summary && (
              <div className="context-note">
                <span>Summary</span>
                <p>{callLog.summary}</p>
              </div>
            )}
            {callLog?.reservation_id && (
              <button
                className="primary-action"
                style={{ marginTop: 16 }}
                onClick={() => navigate("/booking-log")}
              >
                <Icon name="check_circle" />
                View reservation
              </button>
            )}
          </article>
        </aside>
      </section>
    </DashboardShell>
  );
}

const OUTCOME_LABEL = {
  confirmed: "Confirmed",
  no_availability: "No availability",
  declined: "Caller declined",
  transferred: "Transferred to staff",
  none: "No booking attempted"
};
function humanizeOutcome(o) {
  return OUTCOME_LABEL[o] ?? o;
}
function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// Retell delivers transcript either as plain text or as a JSON-encoded array of
// { role: 'agent' | 'user', content: string }. Best-effort parser.
function parseTranscript(raw) {
  if (!raw) return [];
  // JSON array path
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const role = entry.role ?? entry.speaker;
          const text = entry.content ?? entry.text ?? entry.message;
          if (!text) return null;
          return { speaker: role === "agent" || role === "ai" ? "ai" : "guest", text };
        })
        .filter(Boolean);
    }
  } catch {
    // not JSON, fall through to plain-text parser
  }
  // Plain text: split on "Agent:" / "User:" markers Retell uses
  const out = [];
  const lines = String(raw).split(/\n+/).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^\s*(Agent|User|Aria|Bella|Caller)\s*:\s*(.*)$/i);
    if (m) {
      const role = m[1].toLowerCase();
      out.push({
        speaker: role === "agent" || role === "aria" || role === "bella" ? "ai" : "guest",
        text: m[2].trim()
      });
    } else if (out.length > 0) {
      out[out.length - 1].text += " " + line.trim();
    } else {
      out.push({ speaker: "ai", text: line.trim() });
    }
  }
  return out;
}

function TranscriptBubble({ message, delay }) {
  const isAi = message.speaker === "ai";

  return (
    <div
      className={`transcript-row ${isAi ? "ai" : "guest"}`}
      style={{ animationDelay: `${delay * 80}ms` }}
    >
      <div className="speaker-dot">
        <Icon name={isAi ? "robot_2" : "person"} />
      </div>
      <div className="bubble-group">
        <div className="transcript-bubble">
          {message.text}
          {message.typing && (
            <span className="typing-dots">
              <i />
              <i />
              <i />
            </span>
          )}
        </div>
        {message.time && <time>{message.time}</time>}
      </div>
    </div>
  );
}

function PulseBars({ small = false }) {
  return (
    <div className={small ? "pulse-bars small" : "pulse-bars"} aria-hidden="true">
      {[14, 24, 18, 28, 16].map((height, index) => (
        <span key={`${height}-${index}`} style={{ height }} />
      ))}
    </div>
  );
}

function ContextItem({ icon, label, value }) {
  return (
    <div className="context-item">
      <span>{label}</span>
      <strong>
        <Icon name={icon} />
        {value}
      </strong>
    </div>
  );
}

function BookingLogPage({ navigate, path }) {
  const [reservations, setReservations] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [mutationError, setMutationError] = useState(null);
  const [pendingIds, setPendingIds] = useState(() => new Set());
  const [confirmState, setConfirmState] = useState(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const isPhone = useMediaQuery("(max-width: 767px)");

  useEffect(() => {
    let cancelled = false;
    Promise.all([listReservations({ limit: 100 }), getAnalytics({ days: 30 })])
      .then(([res, stats]) => {
        if (cancelled) return;
        setReservations(res.reservations ?? []);
        setAnalytics(stats.analytics ?? null);
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const markPending = (id, on) =>
    setPendingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const applyStatusLocally = (id, status) => {
    setReservations((prev) =>
      prev.map((r) => (r.id === id ? { ...r, status } : r))
    );
  };

  const requestConfirm = (action, id) => {
    const reservation = reservations.find((r) => r.id === id);
    setConfirmState({ action, id, reservation });
  };

  const dismissConfirm = () => {
    if (confirmBusy) return;
    setConfirmState(null);
  };

  const runMutation = async (action, id) => {
    markPending(id, true);
    setMutationError(null);
    setConfirmBusy(true);
    try {
      if (action === "no-show") {
        await updateReservationStatus(id, "no_show");
        applyStatusLocally(id, "no_show");
      } else if (action === "cancel") {
        await cancelReservation(id);
        applyStatusLocally(id, "cancelled");
      } else if (action === "restore") {
        await updateReservationStatus(id, "confirmed");
        applyStatusLocally(id, "confirmed");
      }
      setConfirmState(null);
    } catch (e) {
      setMutationError(e.message ?? String(e));
      setConfirmState(null);
    } finally {
      setConfirmBusy(false);
      markPending(id, false);
    }
  };

  const handleMarkNoShow = (id) => requestConfirm("no-show", id);
  const handleCancel = (id) => requestConfirm("cancel", id);
  const handleRestore = (id) => runMutation("restore", id);

  const rows = reservations.map((r) => ({
    ...mapReservationToRow(r),
    pending: pendingIds.has(r.id)
  }));
  const totalBookings = reservations.length;
  const confirmed = reservations.filter((r) => r.status === "confirmed").length;
  const cancelled = reservations.filter((r) => r.status === "cancelled").length;
  const successRate =
    analytics && analytics.total_calls > 0
      ? `${Math.round((analytics.bookings_created / analytics.total_calls) * 100)}%`
      : "—";

  return (
    <DashboardShell active="Booking Log" navigate={navigate} path={path}>

      <header className="booking-log-header">
        <div>
          <h1>Booking Log</h1>
          <p>Manage reservations and AI interactions.</p>
        </div>
        <div className="booking-actions">
          <label className="booking-search">
            <Icon name="search" />
            <input placeholder="Search bookings..." />
          </label>
          <button className="square-action" aria-label="Filter bookings">
            <Icon name="filter_list" />
          </button>
          <button className="new-booking-button">
            <Icon name="add" />
            New
          </button>
        </div>
      </header>

      <section className="booking-stats">
        <BookingStat title="Total Bookings" value={loading ? "…" : String(totalBookings)} note="Last 100 records" icon="book_online" />
        <BookingStat title="Confirmed" value={loading ? "…" : String(confirmed)} note="Via AI & Web" icon="check_circle" />
        <BookingStat title="Cancelled" value={loading ? "…" : String(cancelled)} note="Customer or staff" icon="warning" tone="warning" />
        <BookingStat title="Booking Rate" value={loading ? "…" : successRate} note="Bookings per call (30d)" icon="smart_toy" tone="primary" />
      </section>

      <section className="reservations-panel">
        <div className="reservations-head">
          <div>
            <h2>Recent Reservations</h2>
            <span>{new Date().toLocaleDateString("en-AU", { year: "numeric", month: "long", day: "numeric" })}</span>
          </div>
          <button>Export</button>
        </div>

        {mutationError && (
          <div className="booking-mutation-error" role="alert">
            <Icon name="error" />
            <span>{mutationError}</span>
            <button type="button" onClick={() => setMutationError(null)} aria-label="Dismiss">
              <Icon name="close" />
            </button>
          </div>
        )}

        {isPhone ? (
          <ul className="booking-card-list" aria-label="Reservations">
            {rows.length === 0 && !loading && (
              <li className="booking-card-empty">No reservations yet.</li>
            )}
            {rows.map((row) => (
              <BookingCardItem key={row.id} row={row} />
            ))}
          </ul>
        ) : (
          <div className="booking-table-wrap">
            <table className="booking-table">
              <thead>
                <tr>
                  <th>Date / Time</th>
                  <th>Guest</th>
                  <th>Party</th>
                  <th>Status</th>
                  <th>Notes</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <BookingRow
                    key={row.id}
                    row={row}
                    onMarkNoShow={handleMarkNoShow}
                    onCancel={handleCancel}
                    onRestore={handleRestore}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <footer className="booking-table-footer">
          <span>
            {loading
              ? "Loading…"
              : error
              ? `Error: ${error}`
              : `${rows.length} reservation${rows.length === 1 ? "" : "s"}`}
          </span>
        </footer>
      </section>

      <ConfirmModal
        state={confirmState}
        busy={confirmBusy}
        onCancel={dismissConfirm}
        onConfirm={() => confirmState && runMutation(confirmState.action, confirmState.id)}
      />
    </DashboardShell>
  );
}

const CONFIRM_COPY = {
  "no-show": {
    title: "Mark as no-show?",
    description:
      "The guest didn't arrive. Marking as no-show frees the table for walk-ins and shows the booking as struck through on this list. You can restore it later if they call.",
    confirmLabel: "Mark no-show",
    confirmTone: "warning",
    icon: "person_off"
  },
  cancel: {
    title: "Cancel this reservation?",
    description:
      "This will set the booking to Cancelled and free the slot. The caller will not be notified automatically — please follow up with them if needed.",
    confirmLabel: "Cancel reservation",
    confirmTone: "danger",
    icon: "block"
  }
};

function ConfirmModal({ state, busy, onConfirm, onCancel }) {
  useEffect(() => {
    if (!state) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape" && !busy) onCancel();
      if (e.key === "Enter" && !busy) onConfirm();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [state, busy, onCancel, onConfirm]);

  if (!state) return null;
  const copy = CONFIRM_COPY[state.action];
  if (!copy) return null;

  const r = state.reservation;
  const dateLabel = r ? formatReservationDate(r.reservation_date) : "";
  const timeLabel = r ? formatVoiceTime12h(r.start_time) : "";

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div className="modal-card">
        <div className={`modal-icon tone-${copy.confirmTone}`}>
          <Icon name={copy.icon} />
        </div>
        <h2 id="confirm-modal-title" className="modal-title">{copy.title}</h2>
        <p className="modal-description">{copy.description}</p>

        {r && (
          <div className="modal-context">
            <div className="modal-context-row">
              <span className="modal-context-label">Guest</span>
              <strong>{r.customer_name || "Unknown"}</strong>
            </div>
            <div className="modal-context-row">
              <span className="modal-context-label">When</span>
              <strong>
                {dateLabel} · {timeLabel}
              </strong>
            </div>
            <div className="modal-context-row">
              <span className="modal-context-label">Party</span>
              <strong>{r.party_size}</strong>
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button
            type="button"
            className="modal-button ghost"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`modal-button ${copy.confirmTone}`}
            disabled={busy}
            onClick={onConfirm}
            autoFocus
          >
            {busy ? (
              <>
                <span className="modal-spinner" aria-hidden="true" />
                Working…
              </>
            ) : (
              copy.confirmLabel
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function mapReservationToRow(row) {
  const statusToneMap = {
    confirmed: "confirmed",
    cancelled: "cancelled",
    seated: "seated",
    completed: "confirmed",
    no_show: "no_show"
  };
  const statusLabelMap = {
    confirmed: "Confirmed",
    cancelled: "Cancelled",
    seated: "Seated",
    completed: "Completed",
    no_show: "No-show"
  };
  return {
    id: row.id,
    dateLabel: formatReservationDate(row.reservation_date),
    timeLabel: formatVoiceTime12h(row.start_time),
    guest: row.customer_name || "Unknown",
    phone: formatPhoneDisplay(row.customer_phone),
    party: row.party_size,
    status: statusLabelMap[row.status] ?? row.status,
    statusTone: statusToneMap[row.status] ?? "confirmed",
    note: row.notes || (row.source === "voice" ? "Booked via phone" : `Booked via ${row.source}`),
    muted: row.status === "cancelled" || row.status === "no_show"
  };
}

function formatReservationDate(isoDateOrString) {
  if (!isoDateOrString) return "—";
  // PG DATE columns serialise as either "2026-05-27" or full ISO.
  const ymd = String(isoDateOrString).slice(0, 10);
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC"
  });
}

function formatVoiceTime12h(timeStr) {
  if (!timeStr) return "";
  const [hStr, mStr] = String(timeStr).split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (Number.isNaN(h)) return String(timeStr);
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return m === 0 ? `${h12} ${suffix}` : `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

function formatPhoneDisplay(raw) {
  if (!raw) return "";
  // +61450011140 → "+61 450 011 140"
  const m = String(raw).match(/^(\+\d{1,3})(\d{3})(\d{3})(\d{3,4})$/);
  return m ? `${m[1]} ${m[2]} ${m[3]} ${m[4]}` : String(raw);
}

function BookingStat({ title, value, note, icon, tone = "" }) {
  return (
    <article className={`booking-stat ${tone}`}>
      <div>
        <span>{title}</span>
        <Icon name={icon} />
      </div>
      <strong>{value}</strong>
      <p>{note}</p>
    </article>
  );
}

function BookingRow({ row, onMarkNoShow, onCancel, onRestore }) {
  const tone = row.statusTone;
  const isClosed = tone === "cancelled" || tone === "no_show";
  const canMarkNoShow = !isClosed && tone !== "seated";
  const canCancel = !isClosed;
  const canRestore = isClosed;

  return (
    <tr className={`${row.muted ? "muted" : ""} ${row.pending ? "pending" : ""}`}>
      <td className="booking-time">
        <strong>{row.dateLabel}</strong>
        <span>{row.timeLabel}</span>
      </td>
      <td>
        <strong>{row.guest}</strong>
        <span>{row.phone}</span>
      </td>
      <td>{row.party}</td>
      <td>
        <span className={`status-pill ${row.statusTone}`}>
          {row.statusTone === "cancelled" && <Icon name="cancel" />}
          {row.statusTone === "no_show" && <Icon name="person_off" />}
          {row.statusTone === "seated" && <Icon name="directions_walk" />}
          {row.statusTone !== "cancelled" && row.statusTone !== "no_show" && row.statusTone !== "seated" && <i />}
          {row.status}
        </span>
      </td>
      <td>
        <div className="booking-note">
          {row.icon && <Icon name={row.icon} />}
          {row.tag && <em>{row.tag}</em>}
          <span>{row.note}</span>
        </div>
      </td>
      <td>
        <div className="row-actions">
          {canMarkNoShow && (
            <button
              type="button"
              aria-label={`Mark ${row.guest} as no-show`}
              title="Mark as no-show"
              disabled={row.pending}
              onClick={() => onMarkNoShow?.(row.id)}
            >
              <Icon name="person_off" />
            </button>
          )}
          {canCancel && (
            <button
              type="button"
              aria-label={`Cancel ${row.guest}`}
              title="Cancel reservation"
              disabled={row.pending}
              onClick={() => onCancel?.(row.id)}
            >
              <Icon name="block" />
            </button>
          )}
          {canRestore && (
            <button
              type="button"
              aria-label={`Restore ${row.guest}`}
              title="Restore to confirmed"
              disabled={row.pending}
              onClick={() => onRestore?.(row.id)}
            >
              <Icon name="restore" />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function BookingCardItem({ row }) {
  return (
    <li className={`booking-card ${row.muted ? "muted" : ""}`}>
      <div className="booking-card-row booking-card-row-top">
        <div className="booking-card-when">
          <strong>{row.dateLabel}</strong>
          <span>{row.timeLabel}</span>
        </div>
        <span className={`status-pill ${row.statusTone}`}>
          {row.statusTone === "cancelled" && <Icon name="cancel" />}
          {row.statusTone === "seated" && <Icon name="directions_walk" />}
          {row.statusTone !== "cancelled" && row.statusTone !== "seated" && <i />}
          {row.status}
        </span>
      </div>
      <div className="booking-card-row booking-card-guest">
        <strong>{row.guest}</strong>
        <span>{row.phone}</span>
      </div>
      <div className="booking-card-row booking-card-meta">
        <span className="booking-card-party">
          <Icon name="group" />
          Party of {row.party}
        </span>
        {row.note && <span className="booking-card-note">{row.note}</span>}
      </div>
    </li>
  );
}

// ----------------------------------------------------------------------------
// Live Tables — mock-data scaffold. Wire to GET /api/tables-status when ready.
// Delete MOCK_TABLES + the loadMock effect to switch to real data.
// ----------------------------------------------------------------------------
const MOCK_TABLES = [
  { label: "T1", minCapacity: 1, maxCapacity: 2, status: "available" },
  {
    label: "T2",
    minCapacity: 1,
    maxCapacity: 2,
    status: "reserved",
    reservation: { time: "7:30 PM", guest: "John", party: 2, minutesUntil: 30 }
  },
  {
    label: "T3",
    minCapacity: 2,
    maxCapacity: 4,
    status: "seated",
    reservation: { time: "6:45 PM", guest: "Maria", party: 4, freesAt: "8:15 PM", seatedMinutesAgo: 12 }
  },
  { label: "T4", minCapacity: 2, maxCapacity: 4, status: "available" },
  {
    label: "T5",
    minCapacity: 4,
    maxCapacity: 6,
    status: "reserved",
    reservation: { time: "8:00 PM", guest: "Sam", party: 5, minutesUntil: 60 }
  },
  { label: "T6", minCapacity: 6, maxCapacity: 8, status: "available" },
  { label: "T7", minCapacity: 8, maxCapacity: 10, status: "available" }
];

function LiveTablesPage({ navigate }) {
  const [tables, setTables] = useState([]);
  const [refreshedAt, setRefreshedAt] = useState(new Date());

  useEffect(() => {
    setTables(MOCK_TABLES);
  }, []);

  const refresh = () => {
    setTables([...MOCK_TABLES]);
    setRefreshedAt(new Date());
  };

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
    <DashboardShell active="Live Tables" navigate={navigate} branded>
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
          <span className="mock-badge">MOCK DATA</span>
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
          <div className="feed-activity-actions">
            <button className="feed-action-btn">
              <Icon name="person_add" />
              Assign Walk-in
            </button>
          </div>
        </div>

        <div className="live-tables-list">
          <div className="live-tables-row live-tables-row-head">
            <span>Table</span>
            <span>Capacity</span>
            <span>Status</span>
            <span className="live-tables-action-col">Action</span>
          </div>
          {tables.map((t) => (
            <TableRow key={t.label} table={t} />
          ))}
        </div>
      </section>
    </DashboardShell>
  );
}

function TableRow({ table }) {
  const isReserved = table.status === "reserved";
  const isSeated = table.status === "seated";
  const r = table.reservation;

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
            Reserved {r.time} — {r.guest} ({r.party}pp)
            <em className="status-sub">in {formatMinutes(r.minutesUntil)}</em>
          </>
        )}
        {isSeated && (
          <>
            Seated {r.time} — {r.guest} ({r.party}pp)
            <em className="status-sub">frees up at {r.freesAt}</em>
          </>
        )}
      </span>
      <span className="live-tables-action-col">
        {table.status === "available" && (
          <button className="row-action ghost">
            <Icon name="person_add" /> Walk-in
          </button>
        )}
        {isReserved && (
          <>
            <button className="row-action primary">
              <Icon name="chair_alt" /> Seat
            </button>
            <button className="row-action danger-ghost" aria-label="Cancel reservation">
              <Icon name="close" />
            </button>
          </>
        )}
        {isSeated && (
          <button className="row-action primary">
            <Icon name="check" /> Mark Done
          </button>
        )}
      </span>
    </div>
  );
}

function formatMinutes(mins) {
  if (mins == null) return "—";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function formatRefreshedAgo(date) {
  const seconds = Math.max(1, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `Refreshed ${seconds}s ago`;
  const m = Math.floor(seconds / 60);
  return `Refreshed ${m}m ago`;
}

function AnalyticsPage({ navigate }) {
  const [analytics, setAnalytics] = useState(null);
  const [dailySeries, setDailySeries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getAnalytics({ days: 7 }), getAnalyticsDailySeries({ days: 7 })])
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
  }, []);

  const totalCalls = analytics?.total_calls ?? 0;
  // Prefer the new analyzer-driven `bookings_confirmed`; fall back to the
  // legacy `bookings_created` count of call_logs linked to a reservation.
  const bookingsCount = analytics?.bookings_confirmed ?? analytics?.bookings_created ?? 0;
  const bookingRate =
    totalCalls > 0 ? `${Math.round((bookingsCount / totalCalls) * 100)}%` : "—";
  const dailyRevenue = `$${((bookingsCount * 80) / 30).toFixed(0)}`;
  const avgLatency = analytics?.avg_latency_ms
    ? `${(analytics.avg_latency_ms / 1000).toFixed(1)}s`
    : "—";
  const avgDuration =
    analytics?.avg_duration_seconds != null
      ? formatDuration(analytics.avg_duration_seconds)
      : "—";

  return (
    <DashboardShell active="Analytics" navigate={navigate} branded>
      <header className="analytics-header">
        <div>
          <h1>Performance Analytics</h1>
          <p>{error ? `Error: ${error}` : "Last 7 days of VocoTable AI activity."}</p>
        </div>
        <div className="analytics-actions">
          <button>
            Last 7 Days
            <Icon name="expand_more" />
          </button>
          <button>
            <Icon name="download" />
            Export
          </button>
        </div>
      </header>

      <section className="metric-grid">
        <Metric icon="call" label="Total Calls" value={loading ? "…" : String(totalCalls)} change="last 7d" />
        <Metric icon="event_available" label="Booking Conversion" value={loading ? "…" : bookingRate} change={`${bookingsCount} bookings`} tone="secondary" />
        <Metric icon="payments" label="Daily Avg Revenue" value={loading ? "…" : dailyRevenue} change="$80 / booking" tone="tertiary" />
        <Metric icon="timer" label="Avg Call Duration" value={loading ? "…" : avgDuration} change={analytics?.avg_latency_ms ? `${avgLatency} latency` : ""} />
      </section>

      <section className="analytics-lower-grid">
        <CallVolumeChart series={dailySeries} loading={loading} />
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

function decorateDailySeries(rawSeries) {
  const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return rawSeries.map((row) => {
    const [y, m, d] = row.date.split("-").map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return {
      key: row.date,
      label: dayLabels[date.getUTCDay()],
      total: row.total ?? 0,
      confirmed: row.confirmed ?? 0
    };
  });
}

function CallVolumeChart({ series, loading }) {
  const maxTotal = Math.max(1, ...series.map((d) => d.total));
  const niceMax = Math.max(4, Math.ceil(maxTotal / 4) * 4);
  const ticks = [niceMax, Math.round(niceMax * 0.75), Math.round(niceMax * 0.5), Math.round(niceMax * 0.25), 0];

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
        <div className="bars">
          {series.map((d) => {
            const totalPct = niceMax > 0 ? (d.total / niceMax) * 100 : 0;
            const confirmedPct = d.total > 0 ? (d.confirmed / d.total) * 100 : 0;
            return (
              <div className="bar-column" key={d.key} title={`${d.label}: ${d.total} calls, ${d.confirmed} confirmed`}>
                <div className="bar total" style={{ height: `${totalPct}%` }}>
                  <div className="confirmed" style={{ height: `${confirmedPct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="x-axis">
        {series.map((d) => (
          <span key={d.key}>{d.label}</span>
        ))}
      </div>
      {!loading && series.every((d) => d.total === 0) && (
        <p style={{ color: "var(--outline)", fontSize: 12, marginTop: 8, textAlign: "center" }}>
          No calls in the last 7 days.
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

function BrandMark({ brand }) {
  if (brand === "google") {
    // Official Google "G" — multi-color
    return (
      <svg viewBox="0 0 48 48" width="22" height="22" aria-hidden="true">
        <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34.1 6.1 29.3 4 24 4 12.95 4 4 12.95 4 24s8.95 20 20 20 20-8.95 20-20c0-1.3-.1-2.4-.4-3.5z" />
        <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
        <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2L31 33.5c-2 1.6-4.5 2.5-7 2.5-5.2 0-9.6-3.3-11.2-8L6.3 33C9.6 39.5 16.3 44 24 44z" />
        <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.3-4.1 5.7l6.4 5.3C40.9 35.4 44 30.1 44 24c0-1.3-.1-2.4-.4-3.5z" />
      </svg>
    );
  }
  if (brand === "apple") {
    return (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
        <path d="M17.05 20.28c-.98.95-2.05.94-3.08.49-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.49C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
      </svg>
    );
  }
  return null;
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

function BillingPage({ navigate }) {
  return (
    <DashboardShell active="Billing" navigate={navigate}>
      <header className="billing-header">
        <h1>Billing & Subscription</h1>
        <p>Manage your payment methods and view past invoices.</p>
      </header>

      <section className="billing-grid">
        <article className="plan-card">
          <div className="plan-glow" />
          <div className="plan-head">
            <div>
              <h2>
                VocoTable Core Plan <span>Active</span>
              </h2>
              <p>Flat rate monthly subscription for unlimited AI agent bookings.</p>
            </div>
            <Icon name="verified" fill className="verified-icon" />
          </div>
          <div className="plan-bottom">
            <div>
              <strong>
                $80.00 <span>/ month</span>
              </strong>
              <p>
                <Icon name="calendar_month" />
                Next billing date: Oct 1, 2023
              </p>
            </div>
            <button>Manage Plan</button>
          </div>
        </article>

        <article className="payment-card">
          <h2>Payment Method</h2>
          <div className="card-line">
            <div className="card-icon">
              <Icon name="credit_card" />
            </div>
            <div>
              <p>•••• •••• •••• 4242</p>
              <span>Expires 12/2025</span>
            </div>
            <Icon name="check_circle" className="check-circle" />
          </div>
          <button>
            Update Payment Details
            <Icon name="arrow_forward" />
          </button>
        </article>

        <article className="billing-history">
          <div className="billing-history-head">
            <h2>Billing History</h2>
            <button>
              <Icon name="filter_list" />
              Filter
            </button>
          </div>
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
              {["Sep 1, 2023", "Aug 1, 2023", "Jul 1, 2023"].map((date) => (
                <tr key={date}>
                  <td>{date}</td>
                  <td>$80.00</td>
                  <td>
                    <span className="paid-dot" />
                    Paid
                  </td>
                  <td>
                    <button aria-label={`Download ${date} receipt`}>
                      <Icon name="download" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
