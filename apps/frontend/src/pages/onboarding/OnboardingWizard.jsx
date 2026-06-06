import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../../auth";
import { signOutUser, uploadMenuFile } from "../../firebase";
import { loadPlacesLibrary, isPlacesEnabled, parsePlaceNew } from "../../places";
import {
  advanceOnboarding,
  commitMenuDraft,
  createBillingCheckoutSession,
  createRestaurant,
  getMenuIngestion,
  getOnboardingStatus,
  getPhoneSetup,
  getRestaurantProfile,
  saveMenuDraft,
  startMenuIngestion,
  updateRestaurantProfile,
  verifyForwarding
} from "../../api";
import { centsToDollars, dollarsToCents } from "../../lib/format";
import { track } from "../../lib/analytics";
import { Icon } from "../../components/Icon";

// ===== Onboarding wizard (Phase 1) =====

const ONBOARDING_CUISINES = [
  "Italian", "Chinese", "Japanese", "Thai", "Indian", "Vietnamese", "Greek",
  "Lebanese", "Mexican", "French", "Modern Australian", "Cafe", "Steakhouse",
  "Seafood", "Pizza", "Burgers", "Vegan", "Other"
];
const ONBOARDING_STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"];

function OnboardingShell({ checklist, children, onSignOut, welcome = false, currentKey = null }) {
  const total = checklist?.length ?? 0;
  const currentIndex = checklist ? checklist.findIndex((s) => s.status === "current") : -1;
  const current = currentIndex >= 0 ? checklist[currentIndex] : null;
  const doneCount = checklist ? checklist.filter((s) => s.status === "done").length : 0;
  const allDone = total > 0 && doneCount === total;
  const ONBOARDING_CONTEXT = {
    profile: "Used by Bella on every call — change it anytime",
    menu: "Lets Bella answer “how much is…” questions",
    trial: "Card not charged for 14 days · cancel anytime",
    phone: "Works with Telstra, Optus & Vodafone"
  };
  const contextLine = ONBOARDING_CONTEXT[currentKey] ?? null;
  return (
    <div className={`onboarding-shell${welcome ? " is-welcome" : ""}`}>
      <div className="onboarding-glow onboarding-glow-1" aria-hidden="true" />
      <div className="onboarding-glow onboarding-glow-2" aria-hidden="true" />
      <header className="onboarding-top">
        <div className="onboarding-brand">
          <img src="/brand/mark-light-on-dark.svg" alt="" width="30" height="30" />
          <strong>VocoTable</strong>
        </div>
        <button type="button" className="onboarding-signout" onClick={onSignOut}>
          Sign out
        </button>
      </header>
      <div className="onboarding-body">
        {total > 0 && (
          <div className="onboarding-progress">
            <p className="onboarding-progress-caption" aria-live="polite">
              {current ? (
                <>
                  <span className="step-count">Step {currentIndex + 1} of {total}</span>
                  {" · "}
                  <span className="step-label">{current.label}</span>
                </>
              ) : (
                <span className="step-label">Setup complete</span>
              )}
            </p>
            <div
              className="onboarding-progress-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={doneCount}
              aria-label="Setup progress"
            >
              {checklist.map((s) => (
                <span
                  key={s.key}
                  className={`onboarding-progress-seg is-${s.status}`}
                  aria-label={`${s.label} — ${s.status === "done" ? "completed" : s.status === "current" ? "in progress" : "not started"}`}
                />
              ))}
              {allDone && (
                <span className="onboarding-progress-cap" aria-hidden="true">
                  <Icon name="check" />
                </span>
              )}
            </div>
            {contextLine && (
              <p className="onboarding-progress-context">
                <Icon name="check" />
                {contextLine}
              </p>
            )}
          </div>
        )}
        <main className="onboarding-main" key={current?.key ?? (welcome ? "welcome" : "done")}>
          {children}
        </main>
      </div>
    </div>
  );
}

function CreateRestaurantStep({ onCreated }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createRestaurant({ name: name.trim() });
      await onCreated();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  const shown = name.trim() || "your restaurant";

  return (
    <div className="onboarding-card">
      <img className="onboarding-welcome-mark" src="/brand/mark-light-on-dark.svg" alt="" />
      <h1>Welcome to VocoTable</h1>
      <p className="onboarding-lead">
        Let's set up Bella, your AI phone host. First — what's your restaurant called?
      </p>
      <form onSubmit={submit} className="onboarding-form">
        <label className="onboarding-field">
          <span>Restaurant name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Natalia's Bistro"
            autoFocus
            maxLength={120}
            required
          />
        </label>
        <div className="onboarding-preview" aria-live="polite">
          <span className="onboarding-preview-label">How Bella answers</span>
          <div className={`onboarding-callcard${name.trim() ? " is-live" : ""}`}>
            <span className="onboarding-callcard-status">
              {name.trim() ? "Incoming call" : "Waiting for the name"}
            </span>
            <p className="onboarding-callcard-greeting">
              “Good evening, you've reached <strong>{shown}</strong>. This is Bella — how can I help?”
            </p>
          </div>
        </div>
        {error && <p className="onboarding-error">{error}</p>}
        <button type="submit" className="primary-button" disabled={busy || !name.trim()}>
          {busy ? "Creating…" : "Create & continue"}
          <Icon name="arrow_forward" />
        </button>
      </form>
    </div>
  );
}

function ProfileStep({ onSaved }) {
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const placesReady = isPlacesEnabled();
  const [placesMounted, setPlacesMounted] = useState(false);

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
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  if (!form) {
    return (
      <div className="onboarding-card is-loading">
        <p style={{ color: "var(--on-surface-variant)" }}>{error ? `Couldn't load: ${error}` : "Loading…"}</p>
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
      setError(e.message);
      setBusy(false);
    }
  };

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
          <span className="onboarding-field-help">
            <Icon name="info" /> Later you'll forward this number to Bella — nothing changes for your callers.
          </span>
        </label>
        <label className="onboarding-field">
          <span>Street address</span>
          {/* Google Places element mounts here when enabled. */}
          {placesReady && <div ref={placesHostRef} className="onboarding-places-host" />}
          {/* Fallback / manual input — hidden once the Places element mounts. */}
          <input
            type="text"
            value={form.address}
            onChange={set("address")}
            maxLength={200}
            autoComplete="off"
            style={placesReady && placesMounted ? { display: "none" } : undefined}
          />
          {placesReady && placesMounted && (
            <span className="onboarding-field-help">
              <Icon name="search" /> Pick your address — suburb, state &amp; postcode fill in automatically.
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
        {error && <p className="onboarding-error">{error}</p>}
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
function MenuDraftReview({ draft, onCommit, onCancel, committing }) {
  const [cats, setCats] = useState(() =>
    (draft.categories ?? []).map((c) => ({
      ...c,
      items: (c.items ?? []).map((it) => ({ ...it }))
    }))
  );

  const setItem = (ci, ii, patch) =>
    setCats((prev) =>
      prev.map((c, i) =>
        i !== ci ? c : { ...c, items: c.items.map((it, j) => (j !== ii ? it : { ...it, ...patch })) }
      )
    );
  const removeItem = (ci, ii) =>
    setCats((prev) => prev.map((c, i) => (i !== ci ? c : { ...c, items: c.items.filter((_, j) => j !== ii) })));
  const setCatName = (ci, name) => setCats((prev) => prev.map((c, i) => (i !== ci ? c : { ...c, name })));

  const itemCount = cats.reduce((n, c) => n + c.items.length, 0);
  const lowConfidence = cats.some((c) => c.items.some((it) => typeof it.confidence === "number" && it.confidence < 0.5));

  return (
    <div className="onboarding-card onboarding-card-wide">
      <h1>Review your menu</h1>
      <p className="onboarding-lead">
        I read {itemCount} item{itemCount === 1 ? "" : "s"} from your menu. Check the names and prices —
        {lowConfidence ? " I've flagged a few I wasn't sure about." : " everything looked clear."}
      </p>
      {lowConfidence && (
        <div className="onboarding-bella">
          <span className="onboarding-bella-avatar" aria-hidden="true"><Icon name="headset_mic" /></span>
          <p>Give the highlighted rows a quick double-check — I wasn't 100% sure on those prices.</p>
        </div>
      )}
      <div className="menu-review">
        {cats.map((c, ci) => (
          <div key={ci} className="menu-review-cat">
            <input
              className="menu-review-catname"
              value={c.name}
              onChange={(e) => setCatName(ci, e.target.value)}
            />
            {c.items.map((it, ii) => {
              const unsure = typeof it.confidence === "number" && it.confidence < 0.5;
              return (
                <div key={ii} className={`menu-review-row${unsure ? " is-unsure" : ""}`}>
                  <input
                    className="menu-review-name"
                    value={it.name}
                    onChange={(e) => setItem(ci, ii, { name: e.target.value })}
                  />
                  <div className="menu-review-price">
                    <span>$</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      defaultValue={centsToDollars(it.price_cents)}
                      onChange={(e) => setItem(ci, ii, { price_cents: dollarsToCents(e.target.value) })}
                    />
                  </div>
                  {unsure && <span className="menu-review-flag" title="Double-check this price">⚠</span>}
                  <button type="button" className="menu-review-del" onClick={() => removeItem(ci, ii)} aria-label="Remove item">
                    <Icon name="close" />
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="onboarding-actions">
        <button type="button" className="ghost-button" onClick={onCancel} disabled={committing}>
          Start over
        </button>
        <button
          type="button"
          className="primary-button"
          onClick={() => onCommit({ categories: cats })}
          disabled={committing || itemCount === 0}
        >
          {committing ? "Saving…" : `Looks good — import ${itemCount} item${itemCount === 1 ? "" : "s"}`}
          <Icon name="arrow_forward" />
        </button>
      </div>
    </div>
  );
}

function MenuStep({ onContinue, navigate }) {
  const { activeRestaurantId } = useAuth();
  // phase: choose | uploading | parsing | review | committing
  const [phase, setPhase] = useState("choose");
  const [jobId, setJobId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [ocrUnavailable, setOcrUnavailable] = useState(false);
  const pollRef = useRef(null);

  useEffect(() => () => clearInterval(pollRef.current), []);

  const pollJob = (id) => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const r = await getMenuIngestion(id);
        if (r.status === "parsed") {
          clearInterval(pollRef.current);
          setDraft(r.draft ?? { categories: [] });
          setPhase("review");
        } else if (r.status === "failed") {
          clearInterval(pollRef.current);
          setError(r.last_error || "We couldn't read that menu. Try a clearer photo, or add items manually.");
          setPhase("choose");
        }
      } catch (e) {
        clearInterval(pollRef.current);
        setError(e.message);
        setPhase("choose");
      }
    }, 2500);
  };

  const handleFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-selecting the same file
    if (!file || !activeRestaurantId) return;
    setError(null);
    setPhase("uploading");
    try {
      const { url, sha256, sourceKind } = await uploadMenuFile(activeRestaurantId, file);
      const job = await startMenuIngestion({ source_url: url, source_kind: sourceKind, sha256 });
      setJobId(job.job_id);
      setPhase("parsing");
      pollJob(job.job_id);
    } catch (e) {
      if (e.code === "MENU_OCR_DISABLED") {
        setOcrUnavailable(true);
        setPhase("choose");
      } else {
        setError(e.message);
        setPhase("choose");
      }
    }
  };

  const handleCommit = async (editedDraft) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setPhase("committing");
    try {
      await saveMenuDraft(jobId, editedDraft);
      await commitMenuDraft(jobId);
      await advanceOnboarding("menu_completed");
      await onContinue();
    } catch (e) {
      setError(e.message);
      setBusy(false);
      setPhase("review");
    }
  };

  const handleManualContinue = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await advanceOnboarding("menu_completed");
      await onContinue();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  if (phase === "review" && draft) {
    return (
      <MenuDraftReview
        draft={draft}
        committing={phase === "committing" || busy}
        onCommit={handleCommit}
        onCancel={() => {
          setDraft(null);
          setJobId(null);
          setPhase("choose");
        }}
      />
    );
  }

  const working = phase === "uploading" || phase === "parsing" || phase === "committing";

  return (
    <div className="onboarding-card">
      <div className="onboarding-bella">
        <span className="onboarding-bella-avatar" aria-hidden="true"><Icon name="headset_mic" /></span>
        <p>Share your menu and I'll learn every dish and price — so I can answer “how much is…” on a call.</p>
      </div>
      <h1>Add your menu</h1>
      <p className="onboarding-lead">
        Snap a photo or upload a PDF and I'll type it up for you — or add items by hand in the editor.
      </p>

      {ocrUnavailable && (
        <p className="onboarding-note">
          <Icon name="info" /> Photo import isn't switched on yet — please add your menu in the editor
          for now.
        </p>
      )}
      {error && <p className="onboarding-error">{error}</p>}

      {working ? (
        <p className="onboarding-note">
          <Icon name="hourglass_top" />{" "}
          {phase === "uploading" ? "Uploading your menu…" : phase === "parsing" ? "Reading your menu… this takes a few seconds." : "Saving…"}
        </p>
      ) : (
        <>
          <label className="onboarding-dropzone">
            <Icon name="photo_camera" />
            <span className="dz-title">Snap or upload your menu</span>
            <span className="dz-sub">JPG, PNG or PDF — Bella reads it for you</span>
            <input
              type="file"
              accept="image/*,application/pdf"
              onChange={handleFile}
              style={{ display: "none" }}
            />
          </label>
          <div className="onboarding-actions" style={{ marginTop: 14 }}>
            <button type="button" className="ghost-button" onClick={() => navigate("/manage-menu")}>
              <Icon name="restaurant_menu" /> Add manually
            </button>
            <button type="button" className="ghost-button" onClick={handleManualContinue} disabled={busy}>
              {busy ? "Checking…" : "I've already added my menu — continue"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function TrialStep({ onRefresh }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [unavailable, setUnavailable] = useState(false);
  const pollsRef = useRef(0);

  // After returning from Stripe Checkout the webhook may lag a few seconds
  // before advancing the status, so poll a bounded number of times.
  useEffect(() => {
    const id = setInterval(() => {
      pollsRef.current += 1;
      if (pollsRef.current > 8) {
        clearInterval(id);
        return;
      }
      onRefresh?.();
    }, 4000);
    return () => clearInterval(id);
  }, [onRefresh]);

  const startTrial = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { url } = await createBillingCheckoutSession();
      if (url) window.location.href = url;
      else setBusy(false);
    } catch (e) {
      if (e.code === "BILLING_NOT_CONFIGURED") setUnavailable(true);
      else setError(e.message);
      setBusy(false);
    }
  };

  return (
    <div className="onboarding-card">
      <div className="onboarding-bella">
        <span className="onboarding-bella-avatar" aria-hidden="true"><Icon name="headset_mic" /></span>
        <p>Try me free for 14 days. I'll start answering your calls now — your card isn't charged until the trial ends.</p>
      </div>
      <h1>Start your free trial</h1>
      <p className="onboarding-lead">
        Try VocoTable free for 14 days. We'll set up your AI phone host now — cancel anytime.
      </p>
      <div className="trial-plan">
        <div>
          <strong>VocoTable Starter</strong>
          <span>Unlimited AI-answered calls, bookings &amp; orders</span>
        </div>
        <div className="trial-price">
          <strong>$80</strong>
          <span>/ month after trial</span>
        </div>
      </div>
      <ul className="trial-reassure">
        <li><Icon name="check" /> 14-day free trial</li>
        <li><Icon name="check" /> Card not charged until the trial ends</li>
        <li><Icon name="check" /> Cancel anytime</li>
      </ul>
      {unavailable && (
        <p className="onboarding-note">
          <Icon name="info" /> Billing isn't switched on yet — your progress is saved and we'll email
          you when you can start your trial.
        </p>
      )}
      {error && <p className="onboarding-error">{error}</p>}
      {!unavailable && (
        <div className="onboarding-actions">
          <button type="button" className="primary-button" onClick={startTrial} disabled={busy}>
            {busy ? "Opening secure checkout…" : "Start 14-day free trial"}
            <Icon name="arrow_forward" />
          </button>
        </div>
      )}
    </div>
  );
}

function PhoneStep({ onRefresh }) {
  const [setup, setSetup] = useState(null);
  const [error, setError] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const pollRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const r = await getPhoneSetup();
      setSetup(r);
      if (r.forwarding_verified) onRefresh?.();
    } catch (e) {
      setError(e.message);
    }
  }, [onRefresh]);

  useEffect(() => {
    load();
    // Poll while the number is being provisioned by an admin.
    pollRef.current = setInterval(load, 6000);
    return () => clearInterval(pollRef.current);
  }, [load]);

  const verify = async () => {
    if (verifying) return;
    setVerifying(true);
    setError(null);
    try {
      const r = await verifyForwarding();
      if (r.verified) onRefresh?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setVerifying(false);
    }
  };

  if (!setup) {
    return (
      <div className="onboarding-card is-loading">
        <p style={{ color: "var(--on-surface-variant)" }}>{error ? `Couldn't load: ${error}` : "Loading…"}</p>
      </div>
    );
  }

  if (!setup.number_ready) {
    return (
      <div className="onboarding-card">
        <Icon name="hourglass_top" className="phone-provisioning-icon" />
        <h1>We're setting up your phone line</h1>
        <p className="onboarding-lead">
          Our team is provisioning your dedicated VocoTable number and configuring Bella with your
          menu. This usually takes a short while — we'll email you the moment it's ready, and this page
          will update automatically.
        </p>
        <p className="onboarding-note">
          <Icon name="info" /> Provisioning in progress…
        </p>
      </div>
    );
  }

  return (
    <div className="onboarding-card">
      <h1>Connect your phone</h1>
      <p className="onboarding-lead">
        Your VocoTable number is ready. Forward your restaurant's calls to it so Bella can answer.
      </p>
      <div className="phone-number-box">
        <span>Your VocoTable number</span>
        <strong>{setup.vocotable_number}</strong>
      </div>
      <ol className="phone-steps">
        <li>
          On the phone that customers call, set up <strong>call forwarding</strong> to{" "}
          <strong>{setup.vocotable_number}</strong>. Most AU carriers use a code from the handset:
          <ul>
            <li>All calls: <code>*21*{setup.vocotable_number}#</code></li>
            <li>When busy / no answer: <code>*61*{setup.vocotable_number}#</code></li>
          </ul>
          (Exact steps vary by carrier — Telstra, Optus and Vodafone all support these GSM codes.)
        </li>
        <li>From a different phone, call your restaurant's normal number to test it.</li>
        <li>Tap verify below — we'll confirm the call reached Bella.</li>
      </ol>
      {error && <p className="onboarding-error">{error}</p>}
      <div className="onboarding-actions">
        <button type="button" className="primary-button" onClick={verify} disabled={verifying}>
          {verifying ? "Checking for your test call…" : "I've forwarded my number — verify"}
          <Icon name="arrow_forward" />
        </button>
      </div>
    </div>
  );
}

function ComingSoonStep({ title, body }) {
  return (
    <div className="onboarding-card">
      <h1>{title}</h1>
      <p className="onboarding-lead">{body}</p>
      <p className="onboarding-note">
        <Icon name="info" /> Your progress is saved — you can pick up here when this step ships.
      </p>
    </div>
  );
}

export function OnboardingWizard({ navigate }) {
  const { memberships, refreshMe } = useAuth();
  const [status, setStatus] = useState(null);
  const [checklist, setChecklist] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const hasRestaurant = (memberships?.length ?? 0) > 0;

  const load = useCallback(async () => {
    if (!hasRestaurant) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await getOnboardingStatus();
      setStatus(r.onboarding_status);
      setChecklist(r.checklist);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [hasRestaurant]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSignOut = async () => {
    await signOutUser();
    navigate("/");
  };

  if (loading) {
    return (
      <OnboardingShell onSignOut={handleSignOut}>
        <div className="onboarding-card">
          <p style={{ color: "var(--on-surface-variant)" }}>Loading…</p>
        </div>
      </OnboardingShell>
    );
  }

  if (!hasRestaurant) {
    return (
      <OnboardingShell onSignOut={handleSignOut} welcome>
        <CreateRestaurantStep onCreated={refreshMe} />
      </OnboardingShell>
    );
  }

  if (error) {
    return (
      <OnboardingShell onSignOut={handleSignOut}>
        <div className="onboarding-card">
          <p className="onboarding-error">Couldn't load your setup: {error}</p>
        </div>
      </OnboardingShell>
    );
  }

  const current = checklist?.find((s) => s.status === "current")?.key ?? null;

  let content;
  if (current === "profile") {
    content = <ProfileStep onSaved={load} />;
  } else if (current === "menu") {
    content = <MenuStep onContinue={load} navigate={navigate} />;
  } else if (current === "trial") {
    content = <TrialStep onRefresh={load} />;
  } else if (current === "phone") {
    content = <PhoneStep onRefresh={load} />;
  } else {
    content = (
      <div className="onboarding-card">
        <div className="onboarding-done-check" aria-hidden="true"><Icon name="check" /></div>
        <h1>You're all set</h1>
        <p className="onboarding-lead">Bella is answering your calls now. Watch them land live in your dashboard.</p>
        <div className="onboarding-actions">
          <button type="button" className="primary-button" onClick={() => navigate("/live-feed")}>
            Go to dashboard <Icon name="arrow_forward" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <OnboardingShell checklist={checklist} currentKey={current} onSignOut={handleSignOut}>
      {content}
    </OnboardingShell>
  );
}

