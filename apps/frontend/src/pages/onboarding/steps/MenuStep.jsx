import { useEffect, useRef, useState } from "react";
import { useAuth } from "../../../auth";
import { uploadMenuFile } from "../../../firebase";
import { advanceOnboarding, commitMenuDraft, getMenuIngestion, saveMenuDraft, startMenuIngestion } from "../../../api";
import { centsToDollars, dollarsToCents } from "../../../lib/format";
import { Icon } from "../../../components/Icon";

// Stable identity for rows so React keys survive a deletion. Using the array
// index as a key meant deleting a mid-list item re-used the DOM node for its
// successor — and because the price field was uncontrolled, it kept showing the
// DELETED row's price while state held the new one. Prices visibly desynced
// from what was actually committed.
let rowUid = 0;
const nextUid = () => `r${(rowUid += 1)}`;

/**
 * Normalise an OCR draft into editable rows. `priceText` is what the user types
 * (kept as a string so "12." and "" are representable mid-edit); `price_cents`
 * is what we send. Deriving one from the other on every keystroke is what let a
 * cleared field silently commit $0.00.
 */
export function draftToRows(draft) {
  return (draft?.categories ?? []).map((c) => ({
    ...c,
    uid: nextUid(),
    items: (c.items ?? []).map((it) => ({
      ...it,
      uid: nextUid(),
      priceText: centsToDollars(it.price_cents)
    }))
  }));
}

/** Back to the wire shape the API expects — drop our editing-only fields. */
export function rowsToDraft(cats) {
  return {
    categories: cats.map(({ uid, items, ...cat }) => ({
      ...cat,
      items: items.map(({ uid: _itemUid, priceText, ...item }) => item)
    }))
  };
}

// `cats` lives in the parent so a failed save can't destroy the user's edits —
// this component unmounts the moment a commit starts.
function MenuDraftReview({ cats, setCats, onCommit, onCancel, committing }) {
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
          <div key={c.uid} className="menu-review-cat">
            <input
              className="menu-review-catname"
              value={c.name}
              aria-label="Category name"
              onChange={(e) => setCatName(ci, e.target.value)}
            />
            {c.items.map((it, ii) => {
              const unsure = typeof it.confidence === "number" && it.confidence < 0.5;
              return (
                <div key={it.uid} className={`menu-review-row${unsure ? " is-unsure" : ""}`}>
                  <input
                    className="menu-review-name"
                    value={it.name}
                    aria-label="Item name"
                    onChange={(e) => setItem(ci, ii, { name: e.target.value })}
                  />
                  <div className="menu-review-price">
                    <span aria-hidden="true">$</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={it.priceText}
                      aria-label={`Price for ${it.name || "this item"} in dollars`}
                      onChange={(e) =>
                        setItem(ci, ii, {
                          priceText: e.target.value,
                          price_cents: dollarsToCents(e.target.value)
                        })
                      }
                    />
                  </div>
                  {unsure && (
                    <span className="menu-review-flag" role="img" aria-label="Double-check this price">
                      ⚠
                    </span>
                  )}
                  <button
                    type="button"
                    className="menu-review-del"
                    onClick={() => removeItem(ci, ii)}
                    aria-label={`Remove ${it.name || "this item"}`}
                  >
                    <Icon name="close" aria-hidden="true" />
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
          onClick={onCommit}
          disabled={committing || itemCount === 0}
        >
          {committing ? "Saving…" : `Looks good — import ${itemCount} item${itemCount === 1 ? "" : "s"}`}
          <Icon name="arrow_forward" />
        </button>
      </div>
    </div>
  );
}

export function MenuStep({ onContinue, navigate, onBack = null }) {
  const { activeRestaurantId } = useAuth();
  // phase: choose | uploading | parsing | review | committing
  const [phase, setPhase] = useState("choose");
  const [jobId, setJobId] = useState(null);
  // The user's edits. Held HERE, not inside MenuDraftReview, because that
  // component unmounts as soon as a commit starts — when a save failed, its
  // state died with it and ten minutes of price corrections silently reverted
  // to the raw OCR output.
  const [cats, setCats] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [ocrUnavailable, setOcrUnavailable] = useState(false);
  const pollRef = useRef(null);
  // The commit is three calls (save draft → commit → advance) and only the
  // first is rejected once the job is committed. Without this, a failure at
  // step 3 made every retry replay step 1 and get a permanent 409
  // INGESTION_NOT_EDITABLE — the step could never be completed again.
  const committedRef = useRef(false);

  useEffect(() => () => clearInterval(pollRef.current), []);

  const pollJob = (id) => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const r = await getMenuIngestion(id);
        if (r.status === "parsed") {
          clearInterval(pollRef.current);
          setCats(draftToRows(r.draft ?? { categories: [] }));
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

  const handleCommit = async () => {
    if (busy || !cats) return;
    setBusy(true);
    setError(null);
    setPhase("committing");
    try {
      // Resume from wherever the last attempt stopped. Saving the draft is only
      // valid while the job is still editable, so once the commit has landed we
      // must never replay it — that's the 409 trap.
      if (!committedRef.current) {
        await saveMenuDraft(jobId, rowsToDraft(cats));
        await commitMenuDraft(jobId);
        committedRef.current = true;
      }
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

  // Stays mounted through "committing" — unmounting on submit is what threw the
  // user's edits away, and it also made the "Saving…" state unreachable.
  if ((phase === "review" || phase === "committing") && cats) {
    return (
      <>
        <MenuDraftReview
          cats={cats}
          setCats={setCats}
          committing={phase === "committing" || busy}
          onCommit={handleCommit}
          onCancel={() => {
            committedRef.current = false;
            setCats(null);
            setJobId(null);
            setPhase("choose");
          }}
        />
        {error && (
          <p className="onboarding-error" role="alert">
            {error}
          </p>
        )}
      </>
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
            {onBack && (
              <button type="button" className="ghost-button" onClick={onBack} disabled={busy}>
                <Icon name="arrow_back" /> Back
              </button>
            )}
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

