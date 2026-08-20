/**
 * Single source of truth for landing-page pricing.
 *
 * Tier cards AND the comparison table render from this file. Editing copy
 * here keeps the two surfaces in lockstep — they cannot drift.
 *
 * @typedef {"solo"|"pro"|"group"|"enterprise"} TierId
 *
 * @typedef {Object} Tier
 * @property {TierId} id
 * @property {string} name
 * @property {string} tagline
 * @property {string} price          // "$80", "$150", "$250", "Let's talk"
 * @property {string} suffix         // "/month" or ""
 * @property {string[]} features
 * @property {string} cta            // primary button label
 * @property {string} [ctaSecondary] // optional caption under the button
 * @property {"venue"|"groups"} group
 * @property {boolean} [featured]    // amber border + "Our pick" eyebrow
 * @property {boolean} [custom]      // opens Cal.com modal instead of scrolling
 *
 * @typedef {Object} CompareRow
 * @property {string} label
 * @property {Record<TierId, string>} values
 *
 * @typedef {Object} FaqItem
 * @property {string} q
 * @property {string} a
 */

import { PHONE_DISPLAY } from "../lib/brand";

/**
 * Every price in TIERS is ex-GST — see the FAQ entry below. Stripe adds GST at
 * checkout, so a "$80" plan bills A$88.00.
 *
 * Anywhere we show a price immediately before someone hands over a card must
 * say so, or the number on the Stripe page won't match the number they agreed
 * to. Use priceIncGst() rather than writing the grossed-up figure by hand, so
 * the two can never disagree.
 */
export const GST_RATE = 0.1;

/**
 * Free trial length, for MARKETING copy on the public site.
 *
 * The signup wizard does NOT use this — it reads the real number back from the
 * API, which is the same value Stripe is given at checkout. This constant only
 * exists because the landing page renders before anyone is signed in and has no
 * API call to piggyback on.
 *
 * The two are tied together by a test (menuImportPlan.test.js's sibling,
 * pricing.test.js) that fails if this and the backend default drift apart —
 * which is exactly what happened before: this file said 7 days while the wizard
 * and Stripe both said 14.
 */
export const TRIAL_DAYS = 7;

/** "7-day" / "one-week" phrasing from one number. */
export function trialLengthLabel() {
  return TRIAL_DAYS === 7 ? "7-day" : `${TRIAL_DAYS}-day`;
}

/** "$80" → "A$88.00". Returns null for non-numeric prices ("Let's talk"). */
export function priceIncGst(price) {
  const amount = Number(String(price).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return `A$${(amount * (1 + GST_RATE)).toFixed(2)}`;
}

/** @type {Tier[]} */
export const TIERS = [
  {
    id: "solo",
    name: "Solo",
    tagline: "For a single restaurant getting started with AI calls.",
    price: "$80",
    suffix: "/month",
    group: "venue",
    features: [
      "Up to 300 booked tables per month",
      "1 phone number, 1 location",
      "24/7 answering in natural Australian voice (Bella)",
      "Live booking into your dashboard",
      "Transcripts & call recordings",
      "Basic analytics & no-show tracking",
      "Unlimited dashboard users",
      "Email support, business hours",
      "After 300 bookings, you'll be invited to upgrade — no surprise charge",
    ],
    cta: "Start with Solo →",
    ctaSecondary: "Live in 48 hours",
  },
  {
    id: "pro",
    name: "Pro",
    tagline: "For busy restaurants that want every call answered.",
    price: "$150",
    suffix: "/month",
    group: "venue",
    featured: true,
    features: [
      "Unlimited bookings, 24/7",
      "1 phone number, 1 location",
      "Everything in Solo, plus:",
      "SMS booking confirmations to guests",
      "Integrations: Cal.com, OpenTable, ResDiary",
      "Custom greeting & menu prompts",
      "Deeper analytics, call-quality reports, peak-hour insights",
      "Priority Sydney support, 7 days a week",
    ],
    cta: "Start with Pro →",
    ctaSecondary: "Live in 48 hours",
  },
  {
    id: "group",
    name: "Group",
    tagline: "For small restaurant groups with 2–3 locations.",
    price: "$250",
    suffix: "/month",
    group: "groups",
    features: [
      "Up to 3 locations in one dashboard",
      "Per-site phone numbers & host configuration",
      "Everything in Pro, plus:",
      "Multi-location reporting & roll-up analytics",
      "Cross-location guest history",
      "Dedicated account manager",
      "99.9% uptime SLA",
      "Priority onboarding — we set it up for you",
    ],
    cta: "Start with Group →",
    ctaSecondary: "Live in 48 hours",
  },
  {
    id: "enterprise",
    name: "Enterprise",
    tagline: "For groups with 4+ locations, custom voices, or bespoke integrations.",
    price: "Let's talk",
    suffix: "",
    group: "groups",
    custom: true,
    features: [
      "Unlimited locations & numbers",
      "Custom voice persona (your accent, your tone)",
      "Multilingual options (en-AU, zh, vi, ko, ja…)",
      "API access & custom integrations",
      "Dedicated success engineer",
      "Bespoke SLA & 24×7 incident response",
      "Custom onboarding, training & playbooks",
    ],
    cta: "Book a 20-min call →",
    ctaSecondary: `Or call ${PHONE_DISPLAY}`,
  },
];

/** @type {CompareRow[]} */
export const COMPARE_ROWS = [
  {
    label: "Bookings per month",
    values: { solo: "300", pro: "Unlimited", group: "Unlimited", enterprise: "Unlimited" },
  },
  {
    label: "Locations",
    values: { solo: "1", pro: "1", group: "Up to 3", enterprise: "Unlimited" },
  },
  {
    label: "Phone numbers",
    values: { solo: "1", pro: "1", group: "1 per location", enterprise: "Unlimited" },
  },
  {
    label: "SMS confirmations",
    values: { solo: "—", pro: "✓", group: "✓", enterprise: "✓" },
  },
  {
    label: "Integrations (Cal.com / OpenTable / ResDiary)",
    values: { solo: "—", pro: "✓", group: "✓", enterprise: "✓ + custom" },
  },
  {
    label: "Analytics",
    values: { solo: "Basic", pro: "Advanced", group: "Multi-site", enterprise: "Advanced + custom reports" },
  },
  {
    label: "Support",
    values: { solo: "Email", pro: "Priority 7-day", group: "Dedicated AM", enterprise: "Success engineer + 24×7" },
  },
  {
    label: "SLA",
    values: { solo: "—", pro: "—", group: "99.9%", enterprise: "Bespoke" },
  },
];

/** @type {FaqItem[]} */
export const FAQ = [
  {
    q: "What happens if I exceed Solo's 300 bookings?",
    a: "No hard cutoff, no surprise charge. We'll invite you to upgrade to Pro — you keep every booking already made.",
  },
  {
    q: "Are prices in AUD? Is GST included?",
    a: "All prices are in AUD and exclude GST (10%). Tax invoices are issued monthly.",
  },
  {
    q: "Can I switch between plans?",
    a: "Yes — upgrade or downgrade any time. Changes prorate to the day. No contract.",
  },
  {
    q: "Can I cancel?",
    a: "Cancel any time from your dashboard. You keep every booking Bella has already made for you.",
  },
  {
    q: "Do you offer annual plans?",
    a: "Yes — pay annually and save the equivalent of two months. Talk to us to set it up.",
  },
  {
    q: `What does the ${trialLengthLabel()} free trial cover?`,
    a: "Full access to your chosen plan. No card required. If you don't continue, every booking Bella made for you is still yours.",
  },
];

/**
 * Build Schema.org JSON-LD for the pricing page.
 * Renders as <script type="application/ld+json"> so Google can extract
 * product + offer data for rich pricing snippets.
 */
export function buildPricingSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: "VoxTable",
    description: "AI phone host for restaurants. Bella answers every call 24/7, books the table, and never sleeps.",
    brand: { "@type": "Brand", name: "VoxTable by BitePerk" },
    offers: {
      "@type": "AggregateOffer",
      priceCurrency: "AUD",
      lowPrice: "80",
      highPrice: "250",
      offerCount: TIERS.filter((t) => !t.custom).length,
      offers: TIERS.filter((t) => !t.custom).map((t) => ({
        "@type": "Offer",
        name: `VoxTable ${t.name}`,
        description: t.tagline,
        price: t.price.replace(/[^0-9]/g, ""),
        priceCurrency: "AUD",
        priceSpecification: {
          "@type": "UnitPriceSpecification",
          price: t.price.replace(/[^0-9]/g, ""),
          priceCurrency: "AUD",
          unitText: "MONTH",
        },
      })),
    },
  };
}
