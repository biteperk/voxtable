// Google Places (New) address autocomplete — lazy-loaded helper.
//
// Powered by Google. The Maps JS API key is a BROWSER key (VITE_GOOGLE_MAPS_KEY,
// baked at build time) — it's safe to ship because it's restricted to our
// referrers + the Places/Maps APIs only in the Cloud console. No secret here.
//
// We load the Maps JS library on demand (first focus of the address field) so
// the rest of the app doesn't pay for the script. If the key is missing or the
// script fails, callers fall back to the plain manual inputs — autocomplete is
// a progressive enhancement, never a hard dependency.

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY || "";

let loaderPromise = null;

/** Lazy-load the Google Maps JS API (places library). Resolves to `google.maps` or null. */
export function loadGoogleMaps() {
  if (!MAPS_KEY) return Promise.resolve(null);
  if (typeof window !== "undefined" && window.google?.maps?.places) {
    return Promise.resolve(window.google.maps);
  }
  if (loaderPromise) return loaderPromise;

  loaderPromise = new Promise((resolve) => {
    try {
      const existing = document.getElementById("gmaps-js");
      if (existing) {
        existing.addEventListener("load", () => resolve(window.google?.maps ?? null));
        existing.addEventListener("error", () => resolve(null));
        return;
      }
      const s = document.createElement("script");
      s.id = "gmaps-js";
      s.async = true;
      s.defer = true;
      // weekly channel; libraries=places for Autocomplete.
      s.src =
        `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(MAPS_KEY)}` +
        `&libraries=places&loading=async&region=AU&language=en-AU`;
      s.onload = () => resolve(window.google?.maps ?? null);
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    } catch {
      resolve(null);
    }
  });
  return loaderPromise;
}

export function isPlacesEnabled() {
  return Boolean(MAPS_KEY);
}

/**
 * Parse a Google PlaceResult's address_components into our profile fields.
 * Returns { address, suburb, state, postcode } — any field may be "" if Google
 * didn't return it. `state` is mapped to the AU abbreviation our <select> uses.
 */
export function parsePlace(place) {
  const comps = place?.address_components ?? [];
  const get = (type) => comps.find((c) => c.types.includes(type));
  const streetNumber = get("street_number")?.long_name ?? "";
  const route = get("route")?.long_name ?? "";
  const suburb =
    get("locality")?.long_name ??
    get("postal_town")?.long_name ??
    get("sublocality")?.long_name ??
    "";
  // administrative_area_level_1 short_name is already the AU abbrev (e.g. "NSW").
  const state = get("administrative_area_level_1")?.short_name ?? "";
  const postcode = get("postal_code")?.long_name ?? "";
  const address = [streetNumber, route].filter(Boolean).join(" ").trim();
  return { address, suburb, state, postcode };
}
