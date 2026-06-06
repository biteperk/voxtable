import { useEffect, useRef, useState } from "react";
import { useAuth } from "../../auth";
import { BiteperkMark } from "../../components/brand/BiteperkMark";
import { BookOnlineModal, isCalcomConfigured } from "../../features/booking/BookOnlineModal";
import { TIERS, COMPARE_ROWS, FAQ, buildPricingSchema } from "../../data/pricing";
import { track } from "../../lib/analytics";

// V-shape brand mark used in the landing nav + footer. Inlined SVG so we
// don't burn an HTTP request on a 1 KB icon. Same geometry as the reference
// design in public/Bella/biteperk-website.html.
export function LandingPage({ navigate }) {
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

          <div className="lp-price-row lp-price-row-4">
            {TIERS.map((tier) => (
              <TierCard
                key={tier.id}
                tier={tier}
                highlighted={highlightedPlan === tier.id}
                onCta={handleTierCta(tier)}
                ctaRef={tier.custom ? enterpriseCtaRef : undefined}
              />
            ))}
          </div>

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

export function TierCard({ tier, highlighted, onCta, ctaRef }) {
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
