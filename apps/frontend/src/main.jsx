import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

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

  const page = useMemo(() => {
    if (path === "/live-feed") {
      return <LiveFeedPage navigate={navigate} />;
    }

    if (path === "/booking-log") {
      return <BookingLogPage navigate={navigate} />;
    }

    if (path === "/analytics") {
      return <AnalyticsPage navigate={navigate} />;
    }

    if (path === "/settings") {
      return <BillingPage navigate={navigate} />;
    }

    return <LandingPage navigate={navigate} />;
  }, [path]);

  return page;
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
  const items = [
    ["Live Feed", "graphic_eq", "/live-feed"],
    ["Booking Log", "menu_book", "/booking-log"],
    ["Analytics", "query_stats", "/analytics"]
  ];

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
            <img src={restaurantImage} alt="Natalia" />
            <div>
              <strong>Natalia</strong>
              <span>Manager</span>
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

function LiveFeedPage({ navigate }) {
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
      <DashboardTopIcons />

      <header className="operational-header">
        <div>
          <h1>Live Feed</h1>
          <p>Monitoring active AI interactions in real-time.</p>
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
  const rows = [
    {
      time: "18:30",
      guest: "Sarah Jenkins",
      phone: "+61 400 123 456",
      party: 2,
      status: "Confirmed",
      statusTone: "confirmed",
      note: "Requested a quiet corner. Anniversary dinner."
    },
    {
      time: "19:00",
      guest: "Michael Chen",
      phone: "+61 411 987 654",
      party: 8,
      status: "Awaiting Deposit",
      statusTone: "pending",
      note: "Large group policy triggered. Payment link sent via SMS by AI. Pending.",
      icon: "info"
    },
    {
      time: "19:15",
      guest: "Emma Thompson",
      phone: "+61 422 345 678",
      party: 4,
      status: "Confirmed",
      statusTone: "confirmed",
      note: "Severe peanut allergy noted by caller.",
      tag: "Allergy"
    },
    {
      time: "19:45",
      guest: "David Lee",
      phone: "Unknown",
      party: 2,
      status: "Cancelled",
      statusTone: "cancelled",
      note: "Cancelled via SMS reply at 14:20.",
      muted: true
    },
    {
      time: "20:00",
      guest: "Walk-in (Table 12)",
      phone: "No details",
      party: 3,
      status: "Seated",
      statusTone: "seated",
      note: "Added manually by staff."
    }
  ];

  return (
    <DashboardShell active="Booking Log" navigate={navigate}>
      <DashboardTopIcons />

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
        <BookingStat title="Total Bookings" value="142" note="+12% today" icon="book_online" />
        <BookingStat title="Confirmed" value="128" note="Via AI & Web" icon="check_circle" />
        <BookingStat title="Awaiting Action" value="14" note="Requires staff review" icon="warning" tone="warning" />
        <BookingStat title="AI Success Rate" value="94%" note="Zero human intervention" icon="smart_toy" tone="primary" />
      </section>

      <section className="reservations-panel">
        <div className="reservations-head">
          <div>
            <h2>Today's Reservations</h2>
            <span>Nov 14, 2023</span>
          </div>
          <button>Export</button>
        </div>

        <div className="booking-table-wrap">
          <table className="booking-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Guest</th>
                <th>Party</th>
                <th>Status</th>
                <th>AI Notes</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <BookingRow key={`${row.time}-${row.guest}`} row={row} />
              ))}
            </tbody>
          </table>
        </div>

        <footer className="booking-table-footer">
          <span>Showing 1-5 of 142</span>
          <div>
            <button disabled aria-label="Previous page">
              <Icon name="chevron_left" />
            </button>
            <button aria-label="Next page">
              <Icon name="chevron_right" />
            </button>
          </div>
        </footer>
      </section>
    </DashboardShell>
  );
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
  return (
    <DashboardShell active="Analytics" navigate={navigate} branded>
      <header className="analytics-header">
        <div>
          <h1>Performance Analytics</h1>
          <p>Comprehensive overview of VocoTable AI efficiency and impact.</p>
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
        <Metric icon="call" label="Total Calls Handled" value="4,285" change="12.5%" />
        <Metric icon="event_available" label="Booking Success Rate" value="87.4%" change="8.2%" tone="secondary" />
        <Metric icon="payments" label="Est. Revenue Saved" value="$12,450" change="15.1%" tone="tertiary" />
        <Metric icon="speed" label="Avg. AI Response Time" value="0.8s" change="1.2s" down />
      </section>

      <section className="analytics-lower-grid">
        <CallVolumeChart />
        <OutcomeBreakdown />
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

function OutcomeBreakdown() {
  return (
    <article className="outcome-card">
      <h2>Outcome Breakdown</h2>
      <div className="outcome-art">
        <div className="diamond diamond-primary" />
        <div className="diamond diamond-secondary" />
        <div className="diamond diamond-tertiary" />
        <div className="outcome-center">
          <strong>4.2k</strong>
          <span>Total</span>
        </div>
      </div>
      <div className="outcome-list">
        <OutcomeItem color="primary" label="Confirmed Bookings" value="65%" />
        <OutcomeItem color="secondary" label="FAQ Answered" value="25%" />
        <OutcomeItem color="tertiary" label="Transferred to Staff" value="10%" />
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
