import { useEffect, useRef, useState } from "react";
import { useAuth } from "../../../auth";
import { sha256OfPages, uploadMenuPage } from "../../../firebase";
import {
  MENU_IMPORT_LIMITS,
  REVIEW_ACK_HINT,
  REVIEW_ACK_LABEL,
  REVIEW_CONCERNS_HEADING,
  describeAddLimit,
  describeCommitBlock,
  describeFailure,
  describeImportSummary,
  describeJobFailure,
  describeReviewConcerns,
  describeStartOverConfirm,
  progressCopy,
  validateSelection
} from "../../../lib/menuImportPlan";
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

/**
 * A row the owner is about to type into.
 *
 * Deliberately carries no `confidence`: a row a person typed is not something
 * the parser was unsure about, and giving it one would render it flagged.
 */
const blankRow = () => ({ uid: nextUid(), name: "", price_cents: 0, priceText: "" });

/** A price we would read aloud as free. See the concerns panel. */
const isUnpriced = (item) => !Number.isFinite(item.price_cents) || item.price_cents <= 0;

// `cats` lives in the parent so a failed save can't destroy the user's edits —
// this component unmounts the moment a commit starts.
function MenuDraftReview({ cats, setCats, onCommit, onCancel, committing, pageResults }) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [limitNote, setLimitNote] = useState(null);
  /** uid of a row we just created, so the caret lands in it rather than off-screen. */
  const [focusUid, setFocusUid] = useState(null);

  const setItem = (ci, ii, patch) =>
    setCats((prev) =>
      prev.map((c, i) =>
        i !== ci ? c : { ...c, items: c.items.map((it, j) => (j !== ii ? it : { ...it, ...patch })) }
      )
    );
  const removeItem = (ci, ii) =>
    setCats((prev) => prev.map((c, i) => (i !== ci ? c : { ...c, items: c.items.filter((_, j) => j !== ii) })));
  const setCatName = (ci, name) => setCats((prev) => prev.map((c, i) => (i !== ci ? c : { ...c, name })));

  const addItem = (ci) => {
    if (cats[ci].items.length >= MENU_IMPORT_LIMITS.MAX_ITEMS_PER_CATEGORY) {
      setLimitNote(describeAddLimit("item"));
      return;
    }
    const row = blankRow();
    setLimitNote(null);
    setFocusUid(row.uid);
    setCats((prev) => prev.map((c, i) => (i !== ci ? c : { ...c, items: [...c.items, row] })));
  };

  const addCategory = () => {
    if (cats.length >= MENU_IMPORT_LIMITS.MAX_CATEGORIES) {
      setLimitNote(describeAddLimit("category"));
      return;
    }
    // Seeded with one row, so a category with no dishes is never representable —
    // an empty one would otherwise commit as a real, dishless section.
    const cat = { uid: nextUid(), name: "", items: [blankRow()] };
    setLimitNote(null);
    setFocusUid(cat.uid);
    setCats((prev) => [...prev, cat]);
  };

  /** Move the caret into a just-added row. Fires once; clears itself. */
  const focusNew = (uid) => (el) => {
    if (!el || uid !== focusUid) return;
    el.focus();
    el.scrollIntoView?.({ block: "center", behavior: "smooth" });
    setFocusUid(null);
  };

  const itemCount = cats.reduce((n, c) => n + c.items.length, 0);
  const unpricedCount = cats.reduce((n, c) => n + c.items.filter(isUnpriced).length, 0);
  const unnamedCount = cats.reduce((n, c) => n + c.items.filter((it) => !it.name.trim()).length, 0);
  const unnamedCategoryCount = cats.filter((c) => !c.name.trim()).length;

  const concerns = describeReviewConcerns({ pageResults, unpricedCount });
  const commitBlock = describeCommitBlock({ unnamedCount, unnamedCategoryCount });
  // An import with something worth checking is committable — but as a decision,
  // not a default. Blocking outright would leave "Start over" as the only way
  // out, and that re-uploads the same file and returns the same job.
  const needsAck = concerns.length > 0;
  const canCommit = !committing && itemCount > 0 && !commitBlock && (!needsAck || acknowledged);

  return (
    <div className="onboarding-card onboarding-card-wide">
      <h1>Review your menu</h1>
      <p className="onboarding-lead">{describeImportSummary({ itemCount, pageResults })}</p>

      {needsAck && (
        <div className="menu-review-concerns">
          <h2>{REVIEW_CONCERNS_HEADING}</h2>
          <ul>
            {concerns.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <label className="onboarding-consent">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            <span>{REVIEW_ACK_LABEL}</span>
          </label>
        </div>
      )}

      <div className="menu-review">
        {cats.map((c, ci) => (
          <div key={c.uid} className="menu-review-cat">
            <input
              className="menu-review-catname"
              value={c.name}
              aria-label="Category name"
              placeholder="e.g. Pizzas"
              ref={focusNew(c.uid)}
              onChange={(e) => setCatName(ci, e.target.value)}
            />
            {c.items.map((it, ii) => {
              const unsure = typeof it.confidence === "number" && it.confidence < 0.5;
              const unpriced = isUnpriced(it);
              return (
                <div
                  key={it.uid}
                  className={`menu-review-row${unsure ? " is-unsure" : ""}${unpriced ? " is-unpriced" : ""}`}
                >
                  <input
                    className="menu-review-name"
                    value={it.name}
                    aria-label="Item name"
                    placeholder="Dish name"
                    ref={focusNew(it.uid)}
                    onChange={(e) => setItem(ci, ii, { name: e.target.value })}
                  />
                  <div className="menu-review-price">
                    <span aria-hidden="true">$</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={it.priceText}
                      placeholder="0.00"
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
                  {unpriced && <span className="menu-review-nopricetag">No price</span>}
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
            <button type="button" className="menu-review-add" onClick={() => addItem(ci)}>
              <Icon name="add" aria-hidden="true" /> Add an item
            </button>
          </div>
        ))}
      </div>
      {/*
        Outside .menu-review on purpose — that list is a scroll container capped
        at 52vh, and anything at the bottom of it is below the fold. This is the
        button an owner needs when a whole section was dropped, so it must not be
        the least discoverable thing on the screen.
      */}
      <button type="button" className="menu-review-add menu-review-addcat" onClick={addCategory}>
        <Icon name="add" aria-hidden="true" /> Add a category
      </button>

      {limitNote && (
        <p className="onboarding-note" role="status">
          {limitNote}
        </p>
      )}
      {commitBlock && (
        <p className="onboarding-note" role="status">
          {commitBlock}
        </p>
      )}
      {needsAck && !acknowledged && !commitBlock && (
        <p className="onboarding-note" role="status">
          {REVIEW_ACK_HINT}
        </p>
      )}

      {confirmingReset ? (
        <>
          <p className="onboarding-note" role="alert">
            {describeStartOverConfirm(itemCount)}
          </p>
          <div className="onboarding-actions">
            <button type="button" className="ghost-button" onClick={() => setConfirmingReset(false)}>
              Keep editing
            </button>
            <button type="button" className="primary-button" onClick={onCancel}>
              Yes, start over
            </button>
          </div>
        </>
      ) : (
        <div className="onboarding-actions">
          <button
            type="button"
            className="ghost-button"
            onClick={() => setConfirmingReset(true)}
            disabled={committing}
          >
            Start over
          </button>
          <button type="button" className="primary-button" onClick={onCommit} disabled={!canCommit}>
            {committing ? "Saving…" : `Looks good — import ${itemCount} item${itemCount === 1 ? "" : "s"}`}
            <Icon name="arrow_forward" />
          </button>
        </div>
      )}
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
  /** Per-page parse outcomes from the backend; [] means "not reported". */
  const [pageResults, setPageResults] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [ocrUnavailable, setOcrUnavailable] = useState(false);
  /** { page, pageCount, percent } — drives the determinate bar. */
  const [progress, setProgress] = useState(null);
  /** A truthful note that doesn't block, e.g. "your PDF has 60 pages". */
  const [notice, setNotice] = useState(null);
  /** Set when polling gives up, so the owner gets a way forward not a spinner. */
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const pollRef = useRef(null);
  /** Cancels an in-flight prepare (AbortController) and upload (task.cancel). */
  const cancelRef = useRef(null);
  // The commit is three calls (save draft → commit → advance) and only the
  // first is rejected once the job is committed. Without this, a failure at
  // step 3 made every retry replay step 1 and get a permanent 409
  // INGESTION_NOT_EDITABLE — the step could never be completed again.
  const committedRef = useRef(false);

  useEffect(() => () => clearTimeout(pollRef.current), []);

  /**
   * Watch a job to a terminal state.
   *
   * Self-scheduling timeout rather than setInterval, so a slow response can't
   * stack overlapping requests. Bounded at POLL_CEILING_MS — matching the
   * worker's realistic worst case — because an unbounded spinner is not a
   * state, it's an abandonment. `committed` is handled explicitly: re-uploading
   * an already-imported menu returns that status, and the old poller only
   * recognised parsed/failed, so it span forever.
   */
  const pollJob = (id) => {
    clearTimeout(pollRef.current);
    const startedAt = Date.now();
    const POLL_CEILING_MS = 10 * 60_000;

    const tick = async () => {
      try {
        const r = await getMenuIngestion(id);
        if (r.status === "parsed") {
          setCats(draftToRows(r.draft ?? { categories: [] }));
          // Absent until the parser reports per-page outcomes. An empty array
          // means "we know nothing about the pages" — which the review copy
          // says plainly rather than reading as "all fine".
          setPageResults(r.page_results ?? []);
          setPhase("review");
          return;
        }
        if (r.status === "committed") {
          setPhase("choose");
          setNotice("That menu is already imported — you can continue, or open Manage menu to edit it.");
          return;
        }
        if (r.status === "failed") {
          // Never render last_error: it holds parser internals, and showing it
          // is how a restaurant owner ended up reading "Unexpected end of JSON
          // input".
          setError(describeJobFailure(r));
          setPhase("choose");
          return;
        }
      } catch (e) {
        setError(describeFailure(e));
        setPhase("choose");
        return;
      }
      if (Date.now() - startedAt > POLL_CEILING_MS) {
        setPollTimedOut(true);
        setPhase("choose");
        return;
      }
      // Tighter early (most menus land quickly), slower after, to stay light.
      const delay = Date.now() - startedAt < 30_000 ? 2_500 : 5_000;
      pollRef.current = setTimeout(tick, delay);
    };

    pollRef.current = setTimeout(tick, 2_500);
  };

  const handleFiles = async (event) => {
    const picked = [...(event.target.files ?? [])];
    event.target.value = ""; // allow re-selecting the same file
    if (picked.length === 0 || !activeRestaurantId) return;

    setError(null);
    setNotice(null);
    setPollTimedOut(false);
    setProgress(null);

    // Everything wrong with the selection is caught HERE, before a single byte
    // moves, so the owner gets an instant answer that names the real problem.
    setPhase("validating");
    const verdict = validateSelection(picked);
    if (!verdict.ok) {
      setError(verdict.message);
      setPhase("choose");
      return;
    }

    const controller = new AbortController();
    cancelRef.current = { abort: () => controller.abort() };

    try {
      // pdf.js is ~1 MB, so it loads only once someone actually imports a menu.
      const { prepareMenuUpload } = await import("../../../lib/menuImportPrepare.js");
      setPhase("preparing");
      const prepared = await prepareMenuUpload(verdict.files, {
        signal: controller.signal,
        onProgress: (p) => setProgress(p)
      });

      if (prepared.truncatedFrom) {
        setNotice(progressCopy({ phase: "truncated", truncatedFrom: prepared.truncatedFrom }));
      }

      setPhase("uploading");
      const urls = [];
      for (let i = 0; i < prepared.pages.length; i += 1) {
        const upload = uploadMenuPage(activeRestaurantId, prepared.pages[i], {
          fileName: `page-${i + 1}.jpg`,
          onProgress: (percent) =>
            setProgress({ page: i + 1, pageCount: prepared.pages.length, percent })
        });
        cancelRef.current = { abort: () => { controller.abort(); upload.cancel(); } };
        urls.push(await upload.promise);
      }

      const sha256 = await sha256OfPages(prepared.pages);
      const job = await startMenuIngestion({
        source_urls: urls,
        source_kind: prepared.sourceKind,
        sha256
      });
      setJobId(job.job_id);
      setProgress({ pageCount: prepared.pages.length });

      // A re-upload of an already-finished menu comes back terminal — go
      // straight there instead of polling for something that already happened.
      if (job.status === "parsed" || job.status === "committed") {
        pollJob(job.job_id);
        return;
      }
      setPhase("parsing");
      pollJob(job.job_id);
    } catch (e) {
      if (e?.name === "AbortError") {
        setPhase("choose");
        return;
      }
      if (e?.code === "MENU_OCR_DISABLED") {
        setOcrUnavailable(true);
        setPhase("choose");
        return;
      }
      setError(describeFailure(e));
      setPhase("choose");
    } finally {
      cancelRef.current = null;
    }
  };

  const cancelWork = () => {
    cancelRef.current?.abort();
    cancelRef.current = null;
    clearTimeout(pollRef.current);
    setProgress(null);
    setPhase("choose");
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
          pageResults={pageResults}
          committing={phase === "committing" || busy}
          onCommit={handleCommit}
          onCancel={() => {
            committedRef.current = false;
            setCats(null);
            setPageResults([]);
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

  const working =
    phase === "validating" ||
    phase === "preparing" ||
    phase === "uploading" ||
    phase === "parsing" ||
    phase === "committing";

  // Overall completion where it's meaningful. Preparing knows page x of n;
  // uploading knows both the page and its byte percentage, so a 12-page upload
  // advances smoothly rather than jumping in twelfths.
  const percentDone = (() => {
    if (!progress?.pageCount) return null;
    if (phase === "preparing" && progress.page) {
      return ((progress.page - 1) / progress.pageCount) * 100;
    }
    if (phase === "uploading" && progress.page) {
      const done = progress.page - 1;
      const current = Number.isFinite(progress.percent) ? progress.percent / 100 : 0;
      return ((done + current) / progress.pageCount) * 100;
    }
    return null;
  })();

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
      {error && (
        <p className="onboarding-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="onboarding-note" role="status">
          <Icon name="info" aria-hidden="true" /> {notice}
        </p>
      )}
      {pollTimedOut && (
        <p className="onboarding-note" role="status">
          <Icon name="info" aria-hidden="true" /> Still reading — this is taking longer than usual.{" "}
          <button type="button" className="link-button" onClick={() => jobId && (setPollTimedOut(false), setPhase("parsing"), pollJob(jobId))}>
            Check again
          </button>
        </p>
      )}

      {working ? (
        <div className="menu-prep">
          {/* Determinate where we can be, so a minute-long render doesn't look
              like a hang. aria-live announces each page as it completes. */}
          <p className="onboarding-note" aria-live="polite">
            <Icon name="hourglass_top" aria-hidden="true" />{" "}
            {progressCopy({
              phase: phase === "preparing" && progress?.phase ? progress.phase : phase,
              page: progress?.page,
              pageCount: progress?.pageCount,
              percent: progress?.percent
            })}
          </p>
          {percentDone !== null && (
            <div
              className="menu-prep-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(percentDone)}
              aria-label="Menu import progress"
            >
              <div className="menu-prep-progress-fill" style={{ width: `${percentDone}%` }} />
            </div>
          )}
        </div>
      ) : (
        <label className="onboarding-dropzone">
          <Icon name="photo_camera" aria-hidden="true" />
          <span className="dz-title">Snap or upload your menu</span>
          <span className="dz-sub">JPG, PNG or PDF — several photos are fine</span>
          {/* Visually hidden rather than display:none, so it stays in the tab
              order and the dropzone is reachable by keyboard. */}
          <input
            type="file"
            className="visually-hidden-input"
            accept="image/*,application/pdf"
            multiple
            onChange={handleFiles}
          />
        </label>
      )}

      {/* Always mounted — never hidden behind `working`. Preparing a 12-page
          menu takes a minute, and a minute with no way out is a trap. */}
      <div className="onboarding-actions" style={{ marginTop: 14 }}>
        {working ? (
          <button type="button" className="ghost-button" onClick={cancelWork}>
            Cancel
          </button>
        ) : (
          onBack && (
            <button type="button" className="ghost-button" onClick={onBack} disabled={busy}>
              <Icon name="arrow_back" aria-hidden="true" /> Back
            </button>
          )
        )}
        <button type="button" className="ghost-button" onClick={() => navigate("/manage-menu")}>
          <Icon name="restaurant_menu" aria-hidden="true" /> Add manually
        </button>
        <button type="button" className="ghost-button" onClick={handleManualContinue} disabled={busy}>
          {busy ? "Checking…" : "I've already added my menu — continue"}
        </button>
      </div>
    </div>
  );
}

