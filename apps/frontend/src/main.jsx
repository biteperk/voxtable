import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { AuthProvider, useAuth } from "./auth";
import { signInWithGoogle, signOutUser } from "./firebase";
import { getAnalytics, listCallLogs, listReservations } from "./api";

const restaurantImage =
  "https://lh3.googleusercontent.com/aida-public/AB6AXuAgvs7qA0qHOd2Nob8Vl9D-gIFHp0BmQY1DOKvAMXDTT6bBAyL8U1lrq-MJV9hWv6MzfT7aNcQk6xL_pujBCXaCuo4ExjvEYGkRayK6-gLpd0Y8DC1Ob8QfyIyg9MMSyRAklEVHlsUdVxYc92Bl2bdKwZNbozxITISxFGSTMm1GFjFgG4jhDIby6jRZKnR_RslKyO96YbopcDOm2xoUgLx4eSTSXZli5KtJYcV_HcCcUo9FGjv2Bxy7pOCxyMYwTdf_kEv41JzNcmE";

function Icon({ name, fill = false, className = "" }) {
  return (
    <span
      className={`material-symbols-outlined ${className}`}
      style={{ fontVariationSettings: `'FILL' ${fill ? 1 : 0}, 'wght' 400, 'GRAD' 0, 'opsz' 24` }}
    >
      {name}
    </span>
  );
}

function App() {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = (nextPath) => {
    window.history.pushState({}, "", nextPath);
    setPath(nextPath);
  };

  const dashboardPaths = ["/live-feed/detail", "/live-feed", "/booking-log", "/analytics", "/settings"];
  const isDashboard = dashboardPaths.includes(path);

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

  if (path === "/live-feed/detail") return <LiveFeedDetailPage navigate={navigate} />;
  if (path === "/live-feed") return <LiveFeedOverviewPage navigate={navigate} />;
  if (path === "/booking-log") return <BookingLogPage navigate={navigate} />;
  if (path === "/analytics") return <AnalyticsPage navigate={navigate} />;
  if (path === "/settings") return <BillingPage navigate={navigate} />;
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
    } catch (e) {
      setError(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-shell">
      <div className="login-card">
        <h1>VocoTable</h1>
        <p>Sign in to access the restaurant dashboard.</p>
        <button onClick={handleSignIn} disabled={busy} className="login-google">
          <Icon name="login" /> Continue with Google
        </button>
        {error && <p className="login-error">{error}</p>}
        <button onClick={() => navigate("/")} className="login-back">
          Back to landing
        </button>
      </div>
    </div>
  );
}

function LandingPage({ navigate }) {
  return (
    <div className="landing-shell">
      <nav className="top-nav">
        <button className="brand-button" onClick={() => navigate("/")}>
          VocoTable
        </button>
        <div className="top-icons">
          <button className="icon-button" aria-label="Notifications">
            <Icon name="notifications" />
          </button>
          <button className="icon-button" aria-label="Account">
            <Icon name="account_circle" />
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
              <button className="primary-action">
                <Icon name="play_circle" />
                Hear the AI
              </button>
              <button className="secondary-action" onClick={() => navigate("/analytics")}>
                Get Started
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
              <button onClick={() => navigate("/analytics")}>Start Free Trial</button>
            </div>
          </div>
        </section>
      </main>
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

function DashboardShell({ active, children, navigate }) {
  const { user } = useAuth();
  const items = [
    ["Live Feed", "graphic_eq", "/live-feed"],
    ["Booking Log", "menu_book", "/booking-log"],
    ["Analytics", "query_stats", "/analytics"]
  ];

  const handleSignOut = async () => {
    await signOutUser();
    navigate("/");
  };

  return (
    <div className="dashboard-shell">
      <aside className="sidebar analytics-sidebar">
        <div className="sidebar-top">
          <button className="dashboard-brand" onClick={() => navigate("/")}>
            <strong>VocoTable</strong>
            <span>Restaurant AI Hub</span>
          </button>
        </div>

        <nav className="side-links">
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
              >
                <Icon name={icon} fill={isActive} />
                <span>{label}</span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-bottom">
          <button
            className={`settings-link ${active === "Settings" ? "active" : ""}`}
            type="button"
            onClick={() => navigate("/settings")}
          >
            <Icon name="settings" fill={active === "Settings"} />
            <span>Settings</span>
          </button>


          <div className="sidebar-user">
            <img src={user?.photoURL ?? restaurantImage} alt={user?.displayName ?? "User"} />
            <div>
              <strong>{user?.displayName ?? "User"}</strong>
              <span>{user?.email ?? ""}</span>
            </div>
          </div>
        </div>
      </aside>
      <main className="dashboard-content">{children}</main>
    </div>
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

function LiveFeedOverviewPage({ navigate }) {
  const [callLogs, setCallLogs] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listCallLogs({ limit: 25 }), getAnalytics({ days: 1 })])
      .then(([calls, stats]) => {
        if (cancelled) return;
        setCallLogs(calls.call_logs ?? []);
        setAnalytics(stats.analytics ?? null);
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const callRows = callLogs.map((row, i) => mapCallLogToRow(row, i));
  const totalCalls = analytics?.total_calls ?? 0;
  const activeCalls = callLogs.filter((r) => !r.ended_at && r.status !== "completed" && r.status !== "failed").length;
  const successRate =
    analytics && analytics.total_calls > 0
      ? `${Math.round((analytics.handled / analytics.total_calls) * 100)}%`
      : "—";

  return (
    <DashboardShell active="Live Feed" navigate={navigate}>

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
                  onClick={() => navigate("/live-feed/detail")}
                />
              ))}
            </tbody>
          </table>
        </div>

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

function mapCallLogToRow(row, index) {
  const ended = !!row.ended_at;
  const status = !ended ? "live" : row.transferred_to_staff ? "transferred" : "handled";
  const started = row.started_at ? new Date(row.started_at) : new Date(row.created_at);
  const endedAt = row.ended_at ? new Date(row.ended_at) : null;
  const durationSec = endedAt ? Math.max(0, Math.round((endedAt - started) / 1000)) : null;
  const tones = ["neutral", "secondary", "tertiary"];

  return {
    id: row.id,
    name: row.caller_phone ? "Caller" : "Unknown Caller",
    initials: null,
    phone: row.caller_phone ?? "Unknown",
    status,
    intent: row.summary?.slice(0, 40) || (row.reservation_id ? "Booking" : "Inbound call"),
    duration: durationSec != null ? formatDuration(durationSec) : "—",
    time: started.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
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

function LiveFeedDetailPage({ navigate }) {
  const messages = [
    {
      speaker: "guest",
      time: "00:05",
      text: "Hi there, I'd like to make a reservation for this Friday evening if possible?"
    },
    {
      speaker: "ai",
      time: "00:09",
      text: "Absolutely, I can help with that. What time were you thinking, and for how many people?"
    },
    {
      speaker: "guest",
      time: "00:15",
      text: "Around 7:30 PM, for a party of 4. It's actually a birthday dinner."
    },
    {
      speaker: "ai",
      time: "00:22",
      text: "Wonderful. Happy birthday to them. Let me check availability for 4 people at 7:30 PM this Friday. Yes, we have a table available."
    },
    {
      speaker: "guest",
      text: "That's great, can we also request...",
      typing: true
    }
  ];

  return (
    <DashboardShell active="Live Feed" navigate={navigate}>

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
            <h1>Live Feed</h1>
            <p>Monitoring active AI interactions in real-time.</p>
          </div>
        </div>
        <div className="active-call-pill">
          <PulseBars small />
          <span>1 Active Call</span>
        </div>
      </header>

      <section className="live-feed-grid">
        <article className="active-call-card">
          <div className="active-call-head">
            <div className="agent-identity">
              <div className="agent-avatar">A</div>
              <div>
                <strong>Aria (AI Agent)</strong>
                <span>In call with +61 412 *** 789</span>
              </div>
            </div>
            <time>00:42</time>
          </div>

          <div className="transcript-stream">
            {messages.map((message, index) => (
              <TranscriptBubble key={message.text} message={message} delay={index} />
            ))}
          </div>

          <div className="call-control-bar">
            <PulseBars />
            <div className="call-actions">
              <button className="listen-button">
                <Icon name="headphones" />
                Listen In
              </button>
              <button className="override-button">
                <Icon name="front_hand" />
                Manual Override
              </button>
            </div>
          </div>
        </article>

        <aside className="call-side-panel">
          <article className="live-card">
            <h2>Live Metrics</h2>
            <div className="live-metric-grid">
              <div>
                <span>
                  <Icon name="speed" />
                  Latency
                </span>
                <strong>
                  420 <small>ms</small>
                </strong>
              </div>
              <div>
                <span>
                  <Icon name="psychology" />
                  Confidence
                </span>
                <strong className="blue">
                  98 <small>%</small>
                </strong>
              </div>
            </div>
            <div className="intent-row">
              <span>Intent Recognition</span>
              <div>
                <i />
              </div>
              <strong>New Booking</strong>
            </div>
          </article>

          <article className="context-card">
            <h2>Extracted Context</h2>
            <div className="context-line" />
            <ContextItem icon="event" label="Requested Date & Time" value="Friday, Oct 27 @ 7:30 PM" />
            <ContextItem icon="group" label="Party Size" value="4 Guests" />
            <div className="context-note">
              <span>Extracted Notes</span>
              <p>Birthday dinner. Currently detailing special requests.</p>
            </div>
            <span className="pending-chip">
              <i />
              Pending Confirmation
            </span>
          </article>
        </aside>
      </section>
    </DashboardShell>
  );
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

function BookingLogPage({ navigate }) {
  const [reservations, setReservations] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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

  const rows = reservations.map(mapReservationToRow);
  const totalBookings = reservations.length;
  const confirmed = reservations.filter((r) => r.status === "confirmed").length;
  const cancelled = reservations.filter((r) => r.status === "cancelled").length;
  const successRate =
    analytics && analytics.total_calls > 0
      ? `${Math.round((analytics.bookings_created / analytics.total_calls) * 100)}%`
      : "—";

  return (
    <DashboardShell active="Booking Log" navigate={navigate}>

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
            <span>{new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}</span>
          </div>
          <button>Export</button>
        </div>

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
                <BookingRow key={row.id} row={row} />
              ))}
            </tbody>
          </table>
        </div>

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
    </DashboardShell>
  );
}

function mapReservationToRow(row) {
  const statusToneMap = {
    confirmed: "confirmed",
    cancelled: "cancelled",
    seated: "seated",
    completed: "confirmed",
    no_show: "cancelled"
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
    time: `${row.reservation_date} ${String(row.start_time).slice(0, 5)}`,
    guest: row.customer_name || "Unknown",
    phone: row.customer_phone || "Unknown",
    party: row.party_size,
    status: statusLabelMap[row.status] ?? row.status,
    statusTone: statusToneMap[row.status] ?? "confirmed",
    note: row.notes || (row.source === "voice" ? "Booked via phone" : `Booked via ${row.source}`),
    muted: row.status === "cancelled"
  };
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

function BookingRow({ row }) {
  return (
    <tr className={row.muted ? "muted" : ""}>
      <td className="booking-time">{row.time}</td>
      <td>
        <strong>{row.guest}</strong>
        <span>{row.phone}</span>
      </td>
      <td>{row.party}</td>
      <td>
        <span className={`status-pill ${row.statusTone}`}>
          {row.statusTone === "cancelled" && <Icon name="cancel" />}
          {row.statusTone === "seated" && <Icon name="directions_walk" />}
          {row.statusTone !== "cancelled" && row.statusTone !== "seated" && <i />}
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
          <button aria-label={`Edit ${row.guest}`}>
            <Icon name="edit" />
          </button>
          <button aria-label={`Cancel ${row.guest}`}>
            <Icon name={row.muted ? "restore" : "block"} />
          </button>
        </div>
      </td>
    </tr>
  );
}

function AnalyticsPage({ navigate }) {
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getAnalytics({ days: 7 })
      .then((res) => !cancelled && setAnalytics(res.analytics))
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const totalCalls = analytics?.total_calls ?? 0;
  const bookingRate =
    analytics && analytics.total_calls > 0
      ? `${Math.round((analytics.bookings_created / analytics.total_calls) * 100)}%`
      : "—";
  const revenueSaved = `$${((analytics?.bookings_created ?? 0) * 80 / 30).toFixed(0)}`;
  const avgLatency = analytics?.avg_latency_ms ? `${(analytics.avg_latency_ms / 1000).toFixed(1)}s` : "—";

  return (
    <DashboardShell active="Analytics" navigate={navigate} branded>
      <header className="analytics-header">
        <div>
          <h1>Performance Analytics</h1>
          <p>Last 7 days of VocoTable AI activity.</p>
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
        <Metric icon="call" label="Total Calls Handled" value={loading ? "…" : String(totalCalls)} change={error ? "error" : "live"} />
        <Metric icon="event_available" label="Booking Conversion" value={loading ? "…" : bookingRate} change="of calls" tone="secondary" />
        <Metric icon="payments" label="Est. Revenue (daily avg)" value={loading ? "…" : revenueSaved} change="$80/booking" tone="tertiary" />
        <Metric icon="speed" label="Avg. AI Response Time" value={loading ? "…" : avgLatency} change="" />
      </section>

      <section className="analytics-lower-grid">
        <CallVolumeChart />
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

function CallVolumeChart() {
  const days = [
    ["Mon", 36, 58],
    ["Tue", 54, 74],
    ["Wed", 42, 64],
    ["Thu", 74, 86],
    ["Fri", 100, 90],
    ["Sat", 88, 78],
    ["Sun", 66, 70]
  ];

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
          <span>400</span>
          <span>300</span>
          <span>200</span>
          <span>100</span>
          <span>0</span>
        </div>
        <div className="bars">
          {days.map(([day, total, confirmed]) => (
            <div className="bar-column" key={day}>
              <div className="bar total" style={{ height: `${total}%` }}>
                <div className="confirmed" style={{ height: `${confirmed}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="x-axis">
        {days.map(([day]) => (
          <span key={day}>{day}</span>
        ))}
      </div>
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

function BillingPage({ navigate }) {
  return (
    <DashboardShell active="Settings" navigate={navigate}>
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

createRoot(document.getElementById("root")).render(<App />);
