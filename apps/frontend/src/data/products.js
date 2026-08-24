/**
 * The Vox product registry — DISPLAY ONLY.
 *
 * ⚠️ This list must never become the sellable list. `AGREEMENT_SERVICES` in
 * apps/backend/src/http/schemas.ts is `["voxtable","voxorder","voxconcierge"]`,
 * and its own comment says the enforcement that VoxDrive can never be sold IS
 * its absence from that enum. There is no DB CHECK on `restaurants.services`, so
 * that enum is the only thing holding the line.
 *
 * A registry that quietly became the source of truth for what can be contracted
 * would dissolve that guarantee. So: `sellable` here is a mirror, never a
 * source, and products.test.js asserts the two never drift.
 *
 * Names are canonical per NAMES.md §1 — CamelCase, "by BitePerk" on first
 * external use. Do not reword them here.
 */

/** @typedef {"live"|"coming-soon"|"concept"} ProductStatus */

export const PRODUCTS = [
  {
    id: "voxtable",
    name: "VoxTable",
    tagline: "Takes bookings when nobody can get to the phone.",
    status: "live",
    sellable: true,
    segment: "all",
    route: "/live-feed",
    icon: "restaurant",
    metricKeys: ["covers_booked", "bookings_today"]
  },
  {
    id: "voxorder",
    name: "VoxOrder",
    tagline: "Takes the takeaway order the line was too busy to answer.",
    status: "live",
    sellable: true,
    segment: "all",
    route: "/kitchen-overview",
    icon: "takeout_dining",
    metricKeys: ["orders_waiting"],
    // The kitchen display is a separate app on its own origin, so it asks for
    // its own sign-in. Labelled in the UI so that is not a surprise.
    secondary: { label: "Open kitchen display", href: "https://vocotable-kds.web.app", external: true }
  },
  {
    id: "voxconcierge",
    name: "VoxConcierge",
    tagline: "Turns no-shows and waitlists into filled tables.",
    status: "coming-soon",
    sellable: true,
    segment: "all",
    route: null,
    icon: "concierge",
    metricKeys: []
  },
  {
    id: "voxstay",
    name: "VoxStay",
    tagline: "Answers the front desk when reception is with a guest.",
    status: "coming-soon",
    sellable: false,
    segment: "hotel",
    route: null,
    icon: "hotel",
    metricKeys: []
  },
  {
    id: "voxdrive",
    name: "VoxDrive",
    tagline: "Keeps the morning drive-thru queue moving.",
    status: "concept",
    sellable: false,
    segment: "all",
    route: null,
    icon: "drive_eta",
    metricKeys: []
  }
];

/** Products this venue has contracted for, in registry order. */
export function ownedProducts(services = []) {
  const owned = new Set(services);
  return PRODUCTS.filter((p) => owned.has(p.id));
}

/** Everything the venue does not have — shown quietly, never hidden. */
export function unownedProducts(services = []) {
  const owned = new Set(services);
  return PRODUCTS.filter((p) => !owned.has(p.id));
}

export const STATUS_LABEL = {
  live: "Live",
  "coming-soon": "Coming soon",
  concept: "Concept"
};
