import { useCallback, useEffect, useState } from "react";
import { getRestaurantProfile, updateRestaurantProfile } from "../../../api";
import { isPlacesEnabled, loadPlacesLibrary, parsePlaceNew } from "../../../places";
import { Icon } from "../../../components/Icon";

// Must stay identical to CUISINE_OPTIONS in apps/backend/src/http/schemas.ts —
// the backend rejects anything not in its enum, so an option missing here is an
// option no venue can ever choose. cuisineOptions.test.ts fails on drift.
const ONBOARDING_CUISINES = [
  "Italian", "Chinese", "Japanese", "Thai", "Indian", "Vietnamese", "Greek",
  "Lebanese", "Mexican", "French", "Modern Australian", "Cafe", "Steakhouse",
  "Seafood", "Pizza", "Burgers", "Vegan", "Mediterranean", "South American", "Chilean",
  "Other"
];
const ONBOARDING_STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"];

export function ProfileStep({ onSaved }) {
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null); // { message, code } | null
  const placesReady = isPlacesEnabled();
  const [placesMounted, setPlacesMounted] = useState(false);
  // Set when the owner chooses "Enter it manually instead" — brings the plain
  // address input back and leaves it there.
  const [manualAddress, setManualAddress] = useState(false);

  // Google Places address autocomplete (powered by Google) via the new
  // PlaceAutocompleteElement web component — the legacy `Autocomplete`
  // constructor is disabled for Cloud projects created after 2025-03-01.
  // A CALLBACK ref mounts the element into a container the moment it appears,
  // so it survives the interim loading card. On select we fetch the address
  // components and fill the form. Progressive enhancement: if Places is off or
  // the library fails to load, `placesMounted` stays false and the plain manual
  // street-address input is shown instead.
  const placesHostRef = useCallback(
    (host) => {
      if (!host || !placesReady || host.dataset.mounted === "1") return;
      host.dataset.mounted = "1";
      loadPlacesLibrary().then((lib) => {
        if (!lib?.PlaceAutocompleteElement) return;
        const el = new lib.PlaceAutocompleteElement({
          includedRegionCodes: ["au"],
          types: ["address"]
        });
        el.className = "onboarding-places-el";
        host.appendChild(el);
        setPlacesMounted(true);
        el.addEventListener("gmp-select", async ({ placePrediction }) => {
          try {
            const place = placePrediction.toPlace();
            await place.fetchFields({ fields: ["addressComponents", "formattedAddress"] });
            const parsed = parsePlaceNew(place);
            setForm((prev) => ({
              ...prev,
              address: parsed.address || prev.address,
              suburb: parsed.suburb || prev.suburb,
              state: parsed.state || prev.state,
              postcode: parsed.postcode || prev.postcode
            }));
          } catch {
            /* fetchFields failed — leave fields as-is, manual edit still works */
          }
        });
      });
    },
    [placesReady]
  );

  useEffect(() => {
    let cancelled = false;
    getRestaurantProfile()
      .then((r) => {
        if (cancelled) return;
        const p = r?.profile ?? {};
        setForm({
          name: p.name ?? "",
          owner_name: p.owner_name ?? "",
          contact_email: p.contact_email ?? "",
          existing_phone_number: p.existing_phone_number ?? "",
          address: p.address ?? "",
          suburb: p.suburb ?? "",
          state: p.state ?? "",
          postcode: p.postcode ?? "",
          cuisine_type: Array.isArray(p.cuisine_type) ? p.cuisine_type : [],
          timezone: p.timezone ?? "Australia/Sydney"
        });
      })
      .catch((e) => !cancelled && setError({ message: e.message, code: e.code }));
    return () => {
      cancelled = true;
    };
  }, []);

  if (!form) {
    return (
      <div className="onboarding-card is-loading">
        <p style={{ color: "var(--on-surface-variant)" }}>{error ? `Couldn't load: ${error.message}` : "Loading…"}</p>
      </div>
    );
  }

  const set = (field) => (e) => setForm((prev) => ({ ...prev, [field]: e.target.value }));
  const toggleCuisine = (c) =>
    setForm((prev) => ({
      ...prev,
      cuisine_type: prev.cuisine_type.includes(c)
        ? prev.cuisine_type.filter((x) => x !== c)
        : prev.cuisine_type.length < 5
          ? [...prev.cuisine_type, c]
          : prev.cuisine_type
    }));

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    // Send only filled fields (all optional server-side); cuisine only if chosen.
    const payload = {
      name: form.name.trim() || undefined,
      owner_name: form.owner_name.trim() || undefined,
      contact_email: form.contact_email.trim() || undefined,
      existing_phone_number: form.existing_phone_number.trim() || undefined,
      address: form.address.trim() || undefined,
      suburb: form.suburb.trim() || undefined,
      state: form.state || undefined,
      postcode: form.postcode.trim() || undefined,
      cuisine_type: form.cuisine_type.length ? form.cuisine_type : undefined,
      timezone: form.timezone || undefined
    };
    try {
      await updateRestaurantProfile(payload);
      await onSaved();
    } catch (e) {
      setError({ message: e.message, code: e.code });
      setBusy(false);
    }
  };

  // Phone-specific errors render under the phone field, not at the card foot.
  const phoneError = error && (error.code === "DUPLICATE_RESTAURANT" || error.code === "INVALID_PHONE");

  return (
    <div className="onboarding-card">
      <div className="onboarding-bella">
        <span className="onboarding-bella-avatar" aria-hidden="true"><Icon name="headset_mic" /></span>
        <p>Hi, I'm <strong>Bella</strong>. Tell me about your place and I'll use it to greet every caller.</p>
      </div>
      <h1>Tell us about your restaurant</h1>
      <p className="onboarding-lead">This is what Bella uses to answer your calls.</p>
      <form onSubmit={submit} className="onboarding-form">
        <label className="onboarding-field">
          <span>Restaurant name</span>
          <input type="text" value={form.name} onChange={set("name")} maxLength={120} required />
        </label>
        <div className="onboarding-field-row">
          <label className="onboarding-field">
            <span>Your name</span>
            <input type="text" value={form.owner_name} onChange={set("owner_name")} maxLength={120} />
          </label>
          <label className="onboarding-field">
            <span>Contact email</span>
            <input type="email" value={form.contact_email} onChange={set("contact_email")} maxLength={160} />
          </label>
        </div>
        <label className="onboarding-field">
          <span>Your current phone number <em>(the one customers call today)</em></span>
          <input
            type="tel"
            value={form.existing_phone_number}
            onChange={set("existing_phone_number")}
            placeholder="(02) 1234 5678"
            maxLength={32}
          />
          {phoneError ? (
            <p className="onboarding-error" role="alert">{error.message}</p>
          ) : (
            <span className="onboarding-field-help">
              <Icon name="info" /> Later you'll forward this number to Bella — nothing changes for your callers.
            </span>
          )}
        </label>
        <label className="onboarding-field">
          <span>Street address</span>
          {/* Google Places element mounts here when enabled. */}
          {placesReady && !manualAddress && <div ref={placesHostRef} className="onboarding-places-host" />}
          {/* Manual input — hidden once the autocomplete widget has MOUNTED.
              It used to stay visible until autocomplete had "proven" itself by
              delivering a selection, which sounds cautious but means every
              first-time user saw TWO address boxes: the widget, and a plain one
              underneath. People type in the plain one — it looks like the
              normal field — then wonder why Google never suggests anything.
              That happened to us in testing on 31 Jul 2026.
              The escape hatch below is always on screen, and if the widget
              fails to mount at all this input is shown, so nobody is ever left
              without somewhere to type. */}
          <input
            type="text"
            value={form.address}
            onChange={set("address")}
            maxLength={200}
            autoComplete="off"
            style={placesReady && placesMounted && !manualAddress ? { display: "none" } : undefined}
          />
          {placesReady && placesMounted && !manualAddress && (
            <span className="onboarding-field-help">
              <Icon name="search" /> Pick your address — suburb, state &amp; postcode fill in automatically.{" "}
              <button type="button" className="onboarding-inline-link" onClick={() => setManualAddress(true)}>
                Enter it manually instead
              </button>
            </span>
          )}
        </label>
        <div className="onboarding-field-row">
          <label className="onboarding-field">
            <span>Suburb</span>
            <input type="text" value={form.suburb} onChange={set("suburb")} maxLength={80} />
          </label>
          <label className="onboarding-field onboarding-field-sm">
            <span>State</span>
            <select value={form.state} onChange={set("state")}>
              <option value="">—</option>
              {ONBOARDING_STATES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <label className="onboarding-field onboarding-field-sm">
            <span>Postcode</span>
            <input
              type="text"
              inputMode="numeric"
              value={form.postcode}
              onChange={(e) => setForm((prev) => ({ ...prev, postcode: e.target.value.replace(/\D/g, "").slice(0, 4) }))}
              maxLength={4}
            />
          </label>
        </div>
        <div className="onboarding-field">
          <span>
            Cuisine <em>(pick up to 5)</em>
            <span className="ob-counter">{form.cuisine_type.length}/5</span>
          </span>
          <div className="onboarding-chips">
            {ONBOARDING_CUISINES.map((c) => (
              <button
                type="button"
                key={c}
                className={`onboarding-chip${form.cuisine_type.includes(c) ? " is-on" : ""}`}
                onClick={() => toggleCuisine(c)}
                aria-pressed={form.cuisine_type.includes(c)}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
        <div className="onboarding-preview" aria-live="polite">
          <span className="onboarding-preview-label">How Bella answers</span>
          <div className={`onboarding-callcard${form.name.trim() ? " is-live" : ""}`}>
            <span className="onboarding-callcard-status">
              {form.name.trim() ? "Incoming call" : "Waiting for details"}
            </span>
            <p className="onboarding-callcard-greeting">
              “Good evening, you've reached <strong>{form.name.trim() || "your restaurant"}</strong>. This is Bella — how can I help?”
            </p>
            {form.cuisine_type.length > 0 && (
              <p className="onboarding-field-help" style={{ marginTop: 8 }}>
                <Icon name="restaurant_menu" /> I'll mention you serve {form.cuisine_type.slice(0, 3).join(", ").toLowerCase()}.
              </p>
            )}
          </div>
        </div>
        {error && !phoneError && <p className="onboarding-error" role="alert">{error.message}</p>}
        <button type="submit" className="primary-button" disabled={busy}>
          {busy ? "Saving…" : "Save & continue"}
          <Icon name="arrow_forward" />
        </button>
      </form>
    </div>
  );
}


// Editable review of the OCR'd draft. Owner fixes names/prices and removes
// junk rows before committing. Variants/modifiers (if any) pass through
// untouched and are editable later in the full menu editor.
