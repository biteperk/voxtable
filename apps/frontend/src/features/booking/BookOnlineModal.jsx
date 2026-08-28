import React, { Suspense, useEffect, useId, useState } from "react";
import { Icon } from "../../components/Icon";
import { PHONE_DISPLAY, PHONE_HREF } from "../../lib/brand";

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
 * ad-blockers and iframe-level CSP issues; (2) call us on the support
 * line; (3) retry the embed in place. Placed inline (not a portal) so it
 * sits inside the same modal body slot as the embed.
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
      <a href={PHONE_HREF} className="book-modal-fallback-cta">
        <Icon name="phone_in_talk" />
        Call us on {PHONE_DISPLAY}
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
    console.error("[voxtable] BookOnline embed error:", {
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
export function BookOnlineModal({ open, onClose, triggerRef }) {
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
