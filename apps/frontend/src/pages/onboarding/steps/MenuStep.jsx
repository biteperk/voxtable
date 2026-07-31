import { useEffect, useRef, useState } from "react";
import { useAuth } from "../../../auth";
import { sha256OfPages, uploadMenuPage } from "../../../firebase";
import {
  describeFailure,
  describeJobFailure,
  describePartialPages,
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
          setNotice(describePartialPages(r.failed_pages));
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

