// Google Places address autocomplete — new PlaceAutocompleteElement API.
//
// Powered by Google. The Maps JS key is a BROWSER key (VITE_GOOGLE_MAPS_KEY,
// baked at build time), so it is public — anyone can read it out of the bundle.
// That is only safe if the key is locked down in the Cloud console, which is
// the ONLY thing standing between this and someone billing Google usage to us.
//
// It needs BOTH of these, and they are separate settings:
//   1. Application restriction → HTTP referrers, listing our origins only.
//   2. API restriction → the Maps/Places APIs only.
//
// Checked 31 Jul 2026: the key in use (Firebase's auto-created browser key) had
// NEITHER — no referrer restriction at all, and an API list of 27 Firebase
// services with no maps or places entry, which is why autocomplete 403'd with
// API_KEY_SERVICE_BLOCKED. An earlier version of this comment asserted the key
// was restricted; it was not. Verify in the console rather than trusting this
// comment — and prefer a dedicated Maps key over the Firebase one, which
// Firebase tooling manages and may rewrite.
//
// NOTE: the legacy `places.Autocomplete` constructor is NOT available to Google
// Cloud projects created after 2025-03-01 (it constructs but never renders).
// New projects must use `PlaceAutocompleteElement` — a web component appended to
// the DOM that emits `gmp-select` with a Place you call fetchFields() on. This
// helper loads the library and builds that element; callers mount it + handle
// selection. Progressive enhancement: no key / load failure → null, caller
// keeps the plain manual inputs.

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY || "";

let placesLibPromise = null;

export function isPlacesEnabled() {
  return Boolean(MAPS_KEY);
}

// Load the Maps JS bootstrap + the Places library via importLibrary (the modern
// loader). Resolves to the places library namespace, or null on failure.
export function loadPlacesLibrary() {
  if (!MAPS_KEY) return Promise.resolve(null);
  if (placesLibPromise) return placesLibPromise;

  placesLibPromise = new Promise((resolve) => {
    // Poll until google.maps.importLibrary exists, then import "places".
    // (The script's onload can fire a tick before importLibrary is attached,
    // so don't rely on onload alone — poll up to ~10s.)
    let tries = 0;
    const tryImport = () => {
      if (window.google?.maps?.importLibrary) {
        window.google.maps
          .importLibrary("places")
          .then((lib) => resolve(lib))
          .catch(() => resolve(null));
        return true;
      }
      return false;
    };
    const poll = () => {
      if (tryImport()) return;
      if (++tries > 100) return resolve(null); // ~10s
      setTimeout(poll, 100);
    };
    try {
      if (tryImport()) return;
      if (!document.getElementById("gmaps-js")) {
        const s = document.createElement("script");
        s.id = "gmaps-js";
        s.async = true;
        s.src =
          `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(MAPS_KEY)}` +
          `&v=weekly&loading=async&region=AU&language=en-AU`;
        s.onerror = () => resolve(null);
        document.head.appendChild(s);
      }
      poll();
    } catch {
      resolve(null);
    }
  });
  return placesLibPromise;
}

/**
 * Parse a new-API Place (after fetchFields(["addressComponents"])) into our
 * profile fields. Returns { address, suburb, state, postcode } — any may be "".
 */
export function parsePlaceNew(place) {
  const comps = place?.addressComponents ?? [];
  const get = (type) => comps.find((c) => (c.types || []).includes(type));
  const streetNumber = get("street_number")?.longText ?? "";
  const route = get("route")?.longText ?? "";
  const suburb =
    get("locality")?.longText ??
    get("postal_town")?.longText ??
    get("sublocality")?.longText ??
    "";
  // short_name of admin_area_level_1 is the AU abbrev (e.g. "NSW").
  const state = get("administrative_area_level_1")?.shortText ?? "";
  const postcode = get("postal_code")?.longText ?? "";
  const address = [streetNumber, route].filter(Boolean).join(" ").trim();
  return { address, suburb, state, postcode };
}
