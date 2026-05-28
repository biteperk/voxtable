import React, { Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { AuthProvider, useAuth } from "./auth";
import { signInWithGoogle, signOutUser } from "./firebase";
import {
  cancelReservation,
  completeReservation,
  getAnalytics,
  getAnalyticsDailySeries,
  getCallLog,
  listCallLogs,
  listReservations,
  listTables,
  seatReservation,
  updateReservationStatus
} from "./api";
import { TIERS, COMPARE_ROWS, FAQ, buildPricingSchema } from "./data/pricing";
import { track } from "./lib/analytics";

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

// Direct link to open the Cal.com page in a new tab — useful as a hard
// fallback when the embed iframe is blocked (ad-blockers, restrictive
// network proxies). cal.com itself isn't usually blocked the way the embed
// script (`app.cal.com/embed/embed.js`) is.
const CALCOM_DIRECT_URL = CALCOM_CAL_LINK
  ? `https://cal.com/${CALCOM_CAL_LINK.replace(/^\/+/, "")}`
  : "";

export function isCalcomConfigured() {
  return Boolean(CALCOM_CAL_LINK);
}

/**
 * Reusable "embed failed — recover" card. Three escape hatches in priority
 * order: (1) open Cal.com directly in a new tab, which bypasses most
 * ad-blockers and iframe-level CSP issues; (2) call the restaurant —
 * Bella's always there; (3) retry the embed in place. Placed inline (not
 * a portal) so it sits inside the same modal body slot as the embed.
 */
function EmbedFailedFallback({ reason, onRetry }) {
  return (
    <div className="book-modal-fallback" role="alert" aria-live="assertive">
      <Icon name="error_outline" />
      <h2>Booking widget didn't load</h2>
      <p>
        {reason ||
          "Cal.com is taking longer than usual — often caused by an ad-blocker or strict network. You have three options:"}
      </p>
      {CALCOM_DIRECT_URL && (
        <a
          href={CALCOM_DIRECT_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="book-modal-fallback-cta book-modal-fallback-cta-primary"
        >
          <Icon name="open_in_new" />
          Open booking in a new tab
        </a>
      )}
      <a href="tel:+61275011140" className="book-modal-fallback-cta">
        <Icon name="phone_in_talk" />
        Call us on +61 2 7501 1140
      </a>
      {onRetry && (
        <button
          type="button"
          className="book-modal-fallback-retry"
          onClick={onRetry}
        >
          <Icon name="refresh" />
          Try the widget again
        </button>
      )}
      <p className="book-modal-fallback-hint">
        Bella's available 24/7 by phone if you'd rather skip the form.
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
 * Listens for the Cal.com iframe's actual ready signal and overlays a
 * recovery card if it never arrives within `timeoutMs`.
 *
 * Why postMessage instead of a dumb timer:
 *   Cal.com's embed script posts `{ type: "__iframeReady" }` (and later
 *   `linkReady`) from its iframe once it's actually rendered the booking
 *   UI. Listening for that event means a 1.5s slow paint doesn't trip the
 *   fallback, but a never-paint (ad-blocker swallowed the embed script)
 *   does — accurately.
 *
 * Why overlay instead of replace:
 *   If we replace `children` after timeout, even a late-loading Cal.com
 *   (e.g. cold-start at 11s) can never recover — the embed is unmounted.
 *   Overlaying keeps the iframe alive; if Cal.com signals ready after the
 *   timeout fired (rare but real), we dismiss the overlay automatically.
 *
 * Retry resets the timer + `attempt` key, which unmounts and remounts the
 * embed — gives the user one explicit re-shot without closing the modal.
 */
function EmbedTimeoutFallback({ timeoutMs, children, onAttemptChange }) {
  const [timedOut, setTimedOut] = useState(false);
  const [embedReady, setEmbedReady] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Timer — only counts down while embed hasn't signalled ready.
  useEffect(() => {
    if (embedReady) return undefined;
    setTimedOut(false);
    const t = setTimeout(() => setTimedOut(true), timeoutMs);
    return () => clearTimeout(t);
  }, [timeoutMs, embedReady, attempt]);

  // postMessage listener for Cal.com's ready signal. Cal.com SDK posts
  // multiple lifecycle events; we accept any of the known "actually
  // painted" markers. Origin is loosely checked (any *.cal.com) — the
  // event type is the real signal.
  useEffect(() => {
    const onMessage = (ev) => {
      if (typeof ev.origin !== "string") return;
      let host;
      try {
        host = new URL(ev.origin).host;
      } catch {
        return; // opaque / null origin — not from Cal.com
      }
      if (!/\.cal\.com$/.test(host) && host !== "cal.com") return;
      const data = ev.data;
      if (!data || typeof data !== "object") return;
      const type = data.type || data.data?.type;
      if (
        type === "__iframeReady" ||
        type === "linkReady" ||
        type === "__windowLoadComplete" ||
        type === "__dimensionChanged"
      ) {
        setEmbedReady(true);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Notify parent of the current attempt (used to key the embed below so
  // a retry forces a fresh mount).
  useEffect(() => {
    if (onAttemptChange) onAttemptChange(attempt);
  }, [attempt, onAttemptChange]);

  const handleRetry = () => {
    setTimedOut(false);
    setEmbedReady(false);
    setAttempt((n) => n + 1);
  };

  const showOverlay = timedOut && !embedReady;

  return (
    <div className="book-modal-embed-frame">
      {/* Embed stays mounted under the overlay — if it eventually loads we
          drop the overlay automatically (embedReady flips, showOverlay → false). */}
      <div className={`book-modal-embed-slot ${showOverlay ? "is-hidden" : ""}`}>
        {children}
      </div>
      {showOverlay && (
        <EmbedFailedFallback onRetry={handleRetry} />
      )}
    </div>
  );
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

  // `attempt` tracked here (not inside EmbedTimeoutFallback) so it can
  // key the <CalcomEmbed> below — bumping it forces a clean unmount/remount,
  // which is the only reliable way to retry a failed Cal.com embed load.
  const [embedAttempt, setEmbedAttempt] = useState(0);

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
          {/* Audit Sweep E + follow-up: error boundary catches chunk-load /
              render errors; EmbedTimeoutFallback overlays a recovery card
              if Cal.com's iframe never signals `linkReady` within 12s. The
              embed stays mounted under the overlay so a late paint can
              still recover, and a Retry button bumps `embedAttempt` to
              force a fresh mount. */}
          <EmbedErrorBoundary>
            <EmbedTimeoutFallback
              timeoutMs={12000}
              onAttemptChange={setEmbedAttempt}
            >
              <Suspense
                fallback={
                  <div className="book-modal-loading" role="status" aria-live="polite">
                    <span className="book-modal-spinner" aria-hidden="true" />
                    <span>Loading booking…</span>
                  </div>
                }
              >
                <CalcomEmbed
                  key={embedAttempt}
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
    // Forward to Sentry. No-op when VITE_SENTRY_DSN is unset.
    sentryCapture(error, { componentStack: info?.componentStack });
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
    path === "/manage-plan" ||
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
  if (path === "/manage-plan") return <ManagePlanPage navigate={navigate} path={path} />;
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

// V-shape brand mark used in the landing nav + footer. Inlined SVG so we
// don't burn an HTTP request on a 1 KB icon. Same geometry as the reference
// design in public/Bella/biteperk-website.html.
function BiteperkMark({ size = 42 }) {
  return (
    <svg
      viewBox="-160 -200 320 380"
      xmlns="http://www.w3.org/2000/svg"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="lp-mk" x1="18%" y1="0%" x2="60%" y2="100%">
          <stop offset="0%" stopColor="#fff" />
          <stop offset="46%" stopColor="#e2e7f1" />
          <stop offset="100%" stopColor="#919bac" />
        </linearGradient>
        <radialGradient id="lp-ok" cx="35%" cy="26%" r="86%">
          <stop offset="0%" stopColor="#fff" />
          <stop offset="20%" stopColor="#fdeede" />
          <stop offset="54%" stopColor="#ff9d3c" />
          <stop offset="100%" stopColor="#9a5a16" />
        </radialGradient>
        <filter id="lp-fk" x="-80%" y="-80%" width="260%" height="260%">
          <feDropShadow dx="0" dy="9" stdDeviation="18" floodColor="#000" floodOpacity="0.4" />
        </filter>
      </defs>
      <g filter="url(#lp-fk)">
        <path d="M -118 -130 L 4 88" stroke="url(#lp-mk)" strokeWidth="100" strokeLinecap="round" fill="none" />
        <path d="M 118 -130 L -4 88" stroke="url(#lp-mk)" strokeWidth="100" strokeLinecap="round" fill="none" />
      </g>
      <circle cx="0" cy="70" r="66" fill="url(#lp-ok)" filter="url(#lp-fk)" />
      <ellipse cx="-20" cy="44" rx="15" ry="9" fill="#fff" opacity="0.6" />
    </svg>
  );
}

function LandingPage({ navigate }) {
  const { user } = useAuth();
  const goToDashboard = () => navigate("/live-feed");

  // Sticky nav background flips at scroll > 40px. Pure CSS class toggle, no
  // re-render of children.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Enterprise "Book a call" → Cal.com modal. Falls back to mailto when the
  // VITE_CALCOM_CAL_LINK env var isn't configured (local dev without secrets).
  const [bookingOpen, setBookingOpen] = useState(false);
  const enterpriseCtaRef = useRef(null);

  // Deep-link: ?plan=X highlights the matching tier card briefly and scrolls
  // pricing into view. Lets sales send "here's the Pro plan" links that land
  // with intent.
  const [highlightedPlan, setHighlightedPlan] = useState(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const plan = params.get("plan");
    if (plan && TIERS.some((t) => t.id === plan)) {
      setHighlightedPlan(plan);
      setTimeout(() => {
        document.getElementById("pricing")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 80);
      const timer = setTimeout(() => setHighlightedPlan(null), 2200);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, []);

  const handleTierCta = (tier) => () => {
    track("pricing_cta_click", { plan: tier.id, source: "card" });
    try {
      window.history.replaceState({}, "", `?plan=${tier.id}#contact`);
    } catch {
      /* harmless in non-browser contexts */
    }
    if (tier.custom) {
      if (isCalcomConfigured()) {
        setBookingOpen(true);
      } else {
        window.location.href = "mailto:hello@biteperk.com.au?subject=VocoTable%20Enterprise%20%C2%B7%20scoping%20call";
      }
      return;
    }
    document.getElementById("contact")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Scroll-reveal — single IntersectionObserver wires up every .lp-reveal in
  // the page, adds .lp-in when it crosses into view. The fade-in styling is
  // gated on html.lp-js-ready so the page stays visible if JS fails or is
  // slow. Reduced-motion skips the animation entirely.
  useEffect(() => {
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      document.querySelectorAll(".lp-reveal").forEach((el) => el.classList.add("lp-in"));
      return;
    }
    document.documentElement.classList.add("lp-js-ready");
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("lp-in");
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0, rootMargin: "0px 0px -8% 0px" }
    );
    document.querySelectorAll(".lp-reveal").forEach((el) => io.observe(el));
    return () => {
      io.disconnect();
      document.documentElement.classList.remove("lp-js-ready");
    };
  }, []);

  // Smooth-scroll a nav anchor without changing the URL.
  const scrollTo = (id) => (event) => {
    event.preventDefault();
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const phoneHref = "tel:+61450011140";
  const emailHref = "mailto:hello@biteperk.com.au";

  return (
    <div className="lp-shell">
      <nav className={`lp-nav ${scrolled ? "lp-scrolled" : ""}`}>
        <div className="lp-wrap lp-nav-inner">
          <button className="lp-brand" onClick={() => navigate("/")} aria-label="VocoTable home">
            <span className="lp-mark">
              <BiteperkMark size={42} />
            </span>
            <span className="lp-brand-name">
              Voco<span className="lp-mist" style={{ fontWeight: 300 }}>Table</span>
            </span>
          </button>
          <div className="lp-nav-links">
            <button type="button" className="lp-lnk" onClick={scrollTo("how")}>
              How it works
            </button>
            <button type="button" className="lp-lnk" onClick={scrollTo("bella")}>
              Meet Bella
            </button>
            <button type="button" className="lp-lnk" onClick={scrollTo("pricing")}>
              Pricing
            </button>
            <button
              type="button"
              className="lp-btn-ghost"
              onClick={goToDashboard}
              aria-label={user ? "Open dashboard" : "Sign in"}
            >
              {user ? "Dashboard" : "Sign in"}
            </button>
            <button type="button" className="lp-btn" onClick={scrollTo("contact")}>
              Start free trial →
            </button>
          </div>
        </div>
      </nav>

      <header className="lp-hero">
        <div className="lp-hero-stage" aria-hidden="true">
          <div className="lp-hero-stage-glow" />
        </div>
        <div className="lp-wrap lp-hero-grid">
          <div className="lp-hero-text">
            <div className="lp-pill">
              <span className="lp-dot" />
              Meet Bella · your AI host
            </div>
            <h1 className="lp-hero-title">
              Never miss
              <br />
              another <span className="lp-amber">booking.</span>
            </h1>
            <p className="lp-sub">
              Bella answers every call in a warm Australian voice, books the table, and never
              sleeps — the AI phone host built for Sydney restaurants.
            </p>
            <div className="lp-hero-cta-row">
              <button type="button" className="lp-btn" onClick={scrollTo("contact")}>
                Start your free week →
              </button>
              <a className="lp-btn-ghost" href={phoneHref}>
                Hear Bella live ▸
              </a>
            </div>
          </div>
          <div className="lp-hero-visual">
            <figure className="lp-hero-card" aria-label="Bella, the AI phone host">
              <div className="lp-hero-card-halo" aria-hidden="true" />
              <div className="lp-hero-card-stage">
                <picture className="lp-hero-card-photo">
                  <source
                    media="(max-width: 560px)"
                    type="image/avif"
                    srcSet="/bella/hero-square.avif 540w, /bella/hero-square@2x.avif 1080w"
                    sizes="300px"
                  />
                  <source
                    media="(max-width: 560px)"
                    type="image/webp"
                    srcSet="/bella/hero-square.webp 540w, /bella/hero-square@2x.webp 1080w"
                    sizes="300px"
                  />
                  <source
                    type="image/avif"
                    srcSet="/bella/hero-portrait.avif 720w, /bella/hero-portrait@2x.avif 1080w"
                    sizes="(max-width: 980px) 360px, 480px"
                  />
                  <source
                    type="image/webp"
                    srcSet="/bella/hero-portrait.webp 720w, /bella/hero-portrait@2x.webp 1080w"
                    sizes="(max-width: 980px) 360px, 480px"
                  />
                  <img
                    src="/bella/hero-portrait.jpg"
                    width="720"
                    height="900"
                    alt="Bella, VocoTable's AI phone host, wearing a headset against the Australian flag"
                    fetchPriority="high"
                    loading="eager"
                    decoding="async"
                  />
                </picture>
                <div className="lp-hero-card-grade" aria-hidden="true" />
                <div className="lp-hero-card-name">
                  Bella<span className="lp-amber">.</span>
                </div>
              </div>
              <figcaption className="lp-hero-card-caption">
                <span className="lp-hero-card-dot" aria-hidden="true" />
                <span className="lp-mini-wave" aria-hidden="true">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <span key={i} style={{ animationDelay: `${i * 0.09}s` }} />
                  ))}
                </span>
                Live · 24/7
              </figcaption>
            </figure>
          </div>
        </div>
        <div className="lp-wrap lp-hero-stats-row">
          <div className="lp-stat">
            <div className="lp-n">24/7</div>
            <div className="lp-l">always answering</div>
          </div>
          <span className="lp-stat-divider" aria-hidden="true" />
          <div className="lp-stat">
            <div className="lp-n">&lt;1s</div>
            <div className="lp-l">to respond</div>
          </div>
          <span className="lp-stat-divider" aria-hidden="true" />
          <div className="lp-stat">
            <div className="lp-n">
              $80<span style={{ fontSize: 18, color: "var(--lp-mist)", fontWeight: 500 }}>/mo</span>
            </div>
            <div className="lp-l">flat, no lock-in</div>
          </div>
        </div>
      </header>

      <div className="lp-trust">
        <div className="lp-wrap lp-trust-inner">
          <span className="lp-dot" />
          <span>Trusted by Sydney restaurants</span>
          <span style={{ color: "#41464e" }}>•</span>
          <span>Made in Australia</span>
          <span style={{ color: "#41464e" }}>•</span>
          <span>Powered by VocoTable voice AI</span>
        </div>
      </div>

      <section className="lp-section" id="problem">
        <div className="lp-wrap">
          <div className="lp-pill" style={{ marginBottom: 18 }}>
            The problem
          </div>
          <h2>
            Your phone is ringing.
            <br />
            <span className="lp-amber">Nobody can pick up.</span>
          </h2>
          <p className="lp-lead">
            Peak call times are peak service times. Your team is serving guests, so the phone
            rings out. Here's what that costs you.
          </p>
          <div className="lp-stat-grid">
            <div className="lp-stat-card lp-reveal">
              <div className="lp-big">58%</div>
              <div className="lp-t">of calls go unanswered</div>
              <div className="lp-s">Most restaurant calls ring out, especially at peak and after hours.</div>
            </div>
            <div className="lp-stat-card lp-reveal">
              <div className="lp-big">69%</div>
              <div className="lp-t">give up if no answer</div>
              <div className="lp-s">Nearly 7 in 10 callers won't try again — they book elsewhere.</div>
            </div>
            <div className="lp-stat-card lp-reveal">
              <div className="lp-big">63%</div>
              <div className="lp-t">still prefer to phone</div>
              <div className="lp-s">Calling remains the #1 way guests reach a restaurant.</div>
            </div>
            <div className="lp-stat-card lp-reveal">
              <div className="lp-big">89%</div>
              <div className="lp-t">are happy with AI</div>
              <div className="lp-s">Almost 9 in 10 diners are open to an AI agent — if it's natural.</div>
            </div>
          </div>
        </div>
      </section>

      <section className="lp-section" id="bella" style={{ paddingTop: 20 }}>
        <div className="lp-wrap">
          <div className="lp-bella">
            <div className="lp-bella-text">
              <div className="lp-eyebrow">Say hello to</div>
              <h2>
                Bella<span className="lp-amber">.</span>
              </h2>
              <p>
                Bella — 'beautiful' — is the voice behind your phone line. Calm, clear and
                unmistakably Australian, she greets every caller like a regular. She never
                sleeps, never takes a smoke break, and never puts a guest on hold.
              </p>
              <div className="lp-bella-traits">
                <div className="lp-trait">
                  <div className="lp-ic">🇦🇺</div>
                  <div>
                    <div className="lp-tt">Natural Aussie accent</div>
                    <div className="lp-ts">Your regulars won't know she's AI</div>
                  </div>
                </div>
                <div className="lp-trait">
                  <div className="lp-ic">⏱</div>
                  <div>
                    <div className="lp-tt">Answers in under a second</div>
                    <div className="lp-ts">No menus, no hold music, ever</div>
                  </div>
                </div>
                <div className="lp-trait">
                  <div className="lp-ic">🗓</div>
                  <div>
                    <div className="lp-tt">Books, moves &amp; cancels</div>
                    <div className="lp-ts">Live into your system, no errors</div>
                  </div>
                </div>
                <div className="lp-trait">
                  <div className="lp-ic">∞</div>
                  <div>
                    <div className="lp-tt">Unlimited calls at once</div>
                    <div className="lp-ts">Ten callers? She greets all ten</div>
                  </div>
                </div>
              </div>
            </div>
            <div className="lp-bella-card" role="img" aria-label="Bella, the AI phone host">
              <picture className="lp-bella-card-photo">
                <source
                  type="image/avif"
                  srcSet="/bella/meet-portrait.avif"
                  sizes="(max-width: 720px) 320px, 420px"
                />
                <source
                  type="image/webp"
                  srcSet="/bella/meet-portrait.webp"
                  sizes="(max-width: 720px) 320px, 420px"
                />
                <img
                  src="/bella/meet-portrait.jpg"
                  width="720"
                  height="720"
                  alt="Bella, VocoTable's AI phone host, in profile against the Australian flag"
                  loading="lazy"
                  decoding="async"
                />
              </picture>
              <div className="lp-bella-card-grade" aria-hidden="true" />
              <div className="lp-bella-tag">
                <span className="lp-bella-dot" /> Live · Sydney
              </div>
              <div className="lp-bella-caption">
                <div className="lp-bella-caption-name">Bella</div>
                <div className="lp-bella-caption-role">AI phone host · en-AU</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="lp-section" id="features">
        <div className="lp-wrap">
          <div className="lp-center">
            <div className="lp-pill" style={{ marginBottom: 18 }}>
              Why restaurants switch
            </div>
            <h2>
              Every call answered.
              <br />
              <span className="lp-amber">Every table filled.</span>
            </h2>
          </div>
          <div className="lp-feat-grid">
            <div className="lp-feat lp-reveal">
              <div className="lp-ic">📞</div>
              <h3>Never miss a call</h3>
              <p>
                Bella picks up instantly, even mid-service or at 11pm — so a missed call never
                becomes a lost booking.
              </p>
            </div>
            <div className="lp-feat lp-reveal">
              <div className="lp-ic">🍽</div>
              <h3>Never double-books</h3>
              <p>
                She checks live table availability on every call, so two parties never land in
                the same slot.
              </p>
            </div>
            <div className="lp-feat lp-reveal">
              <div className="lp-ic">💬</div>
              <h3>Handles the awkward stuff</h3>
              <p>
                Date changes, cancellations, dietary notes, big groups — and transfers cleanly to
                a human when needed.
              </p>
            </div>
            <div className="lp-feat lp-reveal">
              <div className="lp-ic">🔒</div>
              <h3>You own your data</h3>
              <p>No third-party booking platform skimming your guests or your margins. It is all yours.</p>
            </div>
            <div className="lp-feat lp-reveal">
              <div className="lp-ic">❓</div>
              <h3>Top questions, answered</h3>
              <p>
                Hours, parking, set menus, BYO — answered instantly so your staff are not tied to
                the phone.
              </p>
            </div>
            <div className="lp-feat lp-reveal">
              <div className="lp-ic">📊</div>
              <h3>Live dashboard</h3>
              <p>
                Every call, booking and transcript in one place, in real time — with no-show
                tracking and analytics.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section
        className="lp-section"
        id="how"
        style={{
          background: "var(--lp-ink2)",
          borderTop: "1px solid var(--lp-line)",
          borderBottom: "1px solid var(--lp-line)"
        }}
      >
        <div className="lp-wrap">
          <div className="lp-pill" style={{ marginBottom: 18 }}>
            How it works
          </div>
          <h2>
            Set up in hours,
            <br />
            not weeks.
          </h2>
          <div className="lp-steps">
            <div className="lp-step lp-reveal">
              <div className="lp-num">01</div>
              <h3>Your guest calls</h3>
              <p>They dial your existing number, exactly like today. Nothing changes for them.</p>
            </div>
            <div className="lp-step lp-reveal">
              <div className="lp-num">02</div>
              <h3>Bella books it</h3>
              <p>She answers instantly, checks live availability, and confirms the booking on the spot.</p>
            </div>
            <div className="lp-step lp-reveal">
              <div className="lp-num">03</div>
              <h3>You see it live</h3>
              <p>Every call and reservation lands in your VocoTable dashboard in real time.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="lp-section" id="pricing">
        <div className="lp-wrap">
          <div className="lp-center">
            <div className="lp-pill" style={{ marginBottom: 18 }}>
              Pricing
            </div>
            <h2>
              Pricing that grows with you<span className="lp-amber">.</span>
            </h2>
            <p className="lp-lead">
              Try any plan free for 7 days. No card required. Keep every booking Bella makes,
              even if you don't continue.
            </p>
          </div>

          {[
            { eyebrow: "For your restaurant", tiers: TIERS.filter((t) => t.group === "venue") },
            { eyebrow: "For restaurant groups", tiers: TIERS.filter((t) => t.group === "groups") },
          ].map(({ eyebrow, tiers }) => (
            <div className="lp-price-group" key={eyebrow}>
              <div className="lp-price-eyebrow">{eyebrow}</div>
              <div className="lp-price-row lp-price-row-2">
                {tiers.map((tier) => (
                  <TierCard
                    key={tier.id}
                    tier={tier}
                    highlighted={highlightedPlan === tier.id}
                    onCta={handleTierCta(tier)}
                    ctaRef={tier.custom ? enterpriseCtaRef : undefined}
                  />
                ))}
              </div>
            </div>
          ))}

          <details className="lp-price-compare">
            <summary>Compare all features</summary>
            <div className="lp-compare-scroll">
              <table className="lp-compare-table">
                <thead>
                  <tr>
                    <th scope="col"></th>
                    {TIERS.map((t) => (
                      <th key={t.id} scope="col">
                        {t.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {COMPARE_ROWS.map((row) => (
                    <tr key={row.label}>
                      <th scope="row">{row.label}</th>
                      {TIERS.map((t) => {
                        const v = row.values[t.id];
                        const isTick = v === "✓";
                        const isDash = v === "—";
                        return (
                          <td key={t.id}>
                            {isTick ? (
                              <span className="lp-tick" aria-label="Included">
                                ✓
                              </span>
                            ) : isDash ? (
                              <span className="lp-dash" aria-label="Not included">
                                —
                              </span>
                            ) : (
                              v
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>

          <p className="lp-price-footnote">
            All prices in AUD, excludes GST. Pay annually and save the equivalent of two
            months — ask us.
          </p>

          <div className="lp-price-faq">
            <h3>Frequently asked</h3>
            {FAQ.map(({ q, a }) => (
              <details className="lp-faq-item" key={q}>
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>

          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: JSON.stringify(buildPricingSchema()) }}
          />
        </div>
      </section>

      <section
        className="lp-section"
        id="proof"
        style={{ background: "var(--lp-ink2)", borderTop: "1px solid var(--lp-line)" }}
      >
        <div className="lp-wrap">
          <div className="lp-quote-card lp-reveal">
            <div style={{ fontSize: 56, color: "var(--lp-amber)", lineHeight: 0.5 }}>“</div>
            <div className="lp-q">
              We used to lose tables every Friday night just because nobody could reach the phone.
              Now Bella picks up every single call — and the bookings just appear on our screen.
              It paid for itself in the first week.
            </div>
            <div className="lp-quote-author">
              <div className="lp-av">N</div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>Natalia</div>
                <div style={{ fontSize: 13, color: "var(--lp-mist)" }}>
                  Owner · Natalia's Bistro, Sydney
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="lp-cta" id="contact">
        <div className="lp-cta-glow" />
        <div className="lp-wrap lp-closing-content">
          <div className="lp-pill" style={{ marginBottom: 20 }}>
            <span className="lp-dot" />
            7-day free trial
          </div>
          <h2>
            Ready to stop
            <br />
            missing bookings?
          </h2>
          <p className="lp-lead lp-center" style={{ marginTop: 18 }}>
            We'll put Bella on your line in hours — no card required. Hear her answer your
            restaurant today.
          </p>
          <div
            style={{
              marginTop: 34,
              display: "flex",
              gap: 14,
              justifyContent: "center",
              flexWrap: "wrap"
            }}
          >
            <a className="lp-btn" href={phoneHref}>
              Call to start · 0450 011 140
            </a>
            <a className="lp-btn-ghost" href={emailHref}>
              Email us
            </a>
          </div>
          <div className="lp-contact-bar">
            <div className="lp-c">
              <div className="lp-cl">Call</div>
              <div className="lp-cv">
                <a href={phoneHref}>0450 011 140</a>
              </div>
            </div>
            <div className="lp-c">
              <div className="lp-cl">Email</div>
              <div className="lp-cv">
                <a href={emailHref}>hello@biteperk.com.au</a>
              </div>
            </div>
            <div className="lp-c">
              <div className="lp-cl">Web</div>
              <div className="lp-cv">biteperk.com.au</div>
            </div>
          </div>
        </div>
      </section>

      <footer className="lp-footer">
        <div className="lp-wrap">
          <div className="lp-foot-inner">
            <div className="lp-foot-brand">
              <div className="lp-brand" style={{ pointerEvents: "none" }}>
                <span className="lp-mark" style={{ width: 34, height: 34 }}>
                  <BiteperkMark size={34} />
                </span>
                <span className="lp-brand-name" style={{ fontSize: 17 }}>
                  Voco<span className="lp-mist" style={{ fontWeight: 300 }}>Table</span>
                </span>
              </div>
              <p>
                The AI phone host for restaurants. Bella answers every call, books the table, and
                never sleeps. Made in Sydney.
              </p>
              <a
                className="lp-biteperk-tag"
                href="https://biteperk.com.au"
                rel="noopener noreferrer"
                aria-label="Biteperk — the company behind VocoTable"
              >
                <span>A</span>
                <img
                  src="/brand/biteperk-logo.jpeg"
                  alt="Biteperk"
                  width="120"
                  height="32"
                  loading="lazy"
                  decoding="async"
                />
                <span>product</span>
              </a>
            </div>
            <div className="lp-foot-cols">
              <div className="lp-foot-col">
                <h4>Product</h4>
                <a href="#how" onClick={scrollTo("how")}>How it works</a>
                <a href="#bella" onClick={scrollTo("bella")}>Meet Bella</a>
                <a href="#features" onClick={scrollTo("features")}>Features</a>
                <a href="#pricing" onClick={scrollTo("pricing")}>Pricing</a>
              </div>
              <div className="lp-foot-col">
                <h4>Company</h4>
                <a href="#proof" onClick={scrollTo("proof")}>Customers</a>
                <a href={emailHref}>Contact</a>
                <a href="#contact" onClick={scrollTo("contact")}>Free trial</a>
              </div>
              <div className="lp-foot-col">
                <h4>Get in touch</h4>
                <a href={phoneHref}>0450 011 140</a>
                <a href={emailHref}>hello@biteperk.com.au</a>
                <a href="https://biteperk.com.au" rel="noopener noreferrer">biteperk.com.au</a>
              </div>
            </div>
          </div>
          <div className="lp-foot-bottom">
            <div>© {new Date().getFullYear()} Biteperk Pty Ltd. All rights reserved.</div>
            <div>VocoTable · Voice AI booking for restaurants · Sydney, Australia</div>
          </div>
        </div>
      </footer>

      <BookOnlineModal
        open={bookingOpen}
        onClose={() => setBookingOpen(false)}
        triggerRef={enterpriseCtaRef}
      />
    </div>
  );
}

function TierCard({ tier, highlighted, onCta, ctaRef }) {
  const ctaClass = tier.featured || tier.custom ? "lp-btn" : "lp-btn-ghost";
  return (
    <article
      className={
        "lp-tier" +
        (tier.featured ? " lp-tier-featured" : "") +
        (tier.custom ? " lp-tier-custom" : "") +
        (highlighted ? " lp-tier-highlighted" : "")
      }
      aria-label={tier.featured ? `${tier.name} plan — our pick` : `${tier.name} plan`}
    >
      {tier.featured && <div className="lp-tier-pick">Our pick</div>}
      <div className="lp-tier-name">{tier.name}</div>
      <div className="lp-tier-tagline">{tier.tagline}</div>
      <div className="lp-tier-price">
        {tier.price}
        {tier.suffix && <span className="lp-tier-price-suffix">{tier.suffix}</span>}
      </div>
      <ul className="lp-tier-features">
        {tier.features.map((feature) => (
          <li key={feature}>
            <span className="lp-tick" aria-hidden="true">
              ✓
            </span>
            <span>{feature}</span>
          </li>
        ))}
      </ul>
      <div className="lp-tier-cta">
        <button type="button" className={ctaClass} onClick={onCta} ref={ctaRef}>
          {tier.cta}
        </button>
        {tier.ctaSecondary && (
          <div className="lp-tier-cta-secondary">{tier.ctaSecondary}</div>
        )}
      </div>
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
          <span className="status-pill-label">{row.status}</span>
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
              busy={t.reservation && actionBusyId === t.reservation.id}
            />
          ))}
        </div>
      </section>
    </DashboardShell>
  );
}

function TableRow({ table, onSeat, onComplete, busy }) {
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
            <button onClick={() => navigate("/manage-plan")}>Manage Plan</button>
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

createRoot(document.getElementById("root")).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
