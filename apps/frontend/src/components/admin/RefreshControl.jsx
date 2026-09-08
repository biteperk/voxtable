import { AdminAction } from "./AdminAction";
import { relativeTime } from "../../lib/format";

/**
 * The Refresh button, and the thing that makes it honest.
 *
 * The button alone was indistinguishable from a dead control: on a screen of
 * zeroes, a successful refresh changed nothing visible, and it never passed
 * `busy` so there was no disabled state and no label change either. The
 * timestamp is what answers "did that do anything?" — even when every figure
 * on the page is the same, the stamp moves.
 *
 * The announcement is a separate visually-hidden status region rather than
 * `aria-live` on the stamp itself, because the stamp's text changes every 30
 * seconds and a live region there would read the clock out forever.
 */
export function RefreshControl({ lastUpdatedAt, refreshing, announcement, onRefresh }) {
  return (
    <div className="adm-refresh">
      <span className="adm-card-stamp">
        {lastUpdatedAt ? `Updated ${relativeTime(new Date(lastUpdatedAt)).toLowerCase()}` : "Loading…"}
      </span>
      <AdminAction onAct={onRefresh} icon="refresh" busy={refreshing} busyLabel="Refreshing…">
        Refresh
      </AdminAction>
      <p className="sr-only" role="status">
        {announcement}
      </p>
    </div>
  );
}
