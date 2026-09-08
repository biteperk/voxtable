import { useEffect, useState } from "react";

import { getAdminRestaurants } from "../../api";
import { AdminAction } from "../../components/admin/AdminAction";
import { RefreshControl } from "../../components/admin/RefreshControl";
import { SectionCard } from "../../components/admin/SectionCard";
import { Icon } from "../../components/Icon";
import { useAdminData } from "../../hooks/useAdminData";
import { relativeTime } from "../../lib/format";
import { VenueDrawer } from "./venues/VenueDrawer";
import { VenuesTable } from "./venues/VenuesTable";

const STATUSES = [
  "",
  "account_created",
  "profile",
  "agreement",
  "menu",
  "trial",
  "provisioning",
  "live",
  "suspended",
  "cancelled"
];

const PAGE_SIZE = 25;

/**
 * Deep links live in the query string, read here rather than pushed through the
 * router: the router tracks `pathname` only, so a path carrying `?venue=…`
 * would break every `path === "/admin/venues"` comparison it makes. Same
 * approach as AcceptInvitePage.
 */
function readQuery() {
  if (typeof window === "undefined") return {};
  const params = new URLSearchParams(window.location.search);
  return { venue: params.get("venue") ?? null, status: params.get("status") ?? "" };
}

export function AdminVenues() {
  const initial = readQuery();
  const [filter, setFilter] = useState({
    status: STATUSES.includes(initial.status) ? initial.status : "",
    q: ""
  });
  const [offset, setOffset] = useState(0);
  const [openVenue, setOpenVenue] = useState(
    initial.venue ? { id: initial.venue, name: "This venue" } : null
  );

  // `deps` is the refetch-on-filter contract: the fetcher itself is held in a
  // ref inside the hook, so it needs no useCallback and a keystroke cannot
  // restart anything but the request it should.
  const {
    data: page,
    error,
    lastUpdatedAt,
    refreshing,
    announcement,
    refresh
  } = useAdminData(
    () =>
      getAdminRestaurants({
        status: filter.status || undefined,
        q: filter.q || undefined,
        limit: PAGE_SIZE,
        offset
      }),
    { deps: [filter.status, filter.q, offset] }
  );

  // A venue arriving by deep link has no name until the list resolves it, and
  // the drawer's heading should not read "This venue" once we know better.
  useEffect(() => {
    if (!openVenue || openVenue.name !== "This venue") return;
    const match = page?.restaurants?.find((r) => r.id === openVenue.id);
    if (match) setOpenVenue({ id: match.id, name: match.name });
  }, [page, openVenue]);

  const open = (venue) => {
    setOpenVenue({ id: venue.id, name: venue.name });
    window.history.replaceState({}, "", `/admin/venues?venue=${encodeURIComponent(venue.id)}`);
  };

  const close = () => {
    setOpenVenue(null);
    window.history.replaceState({}, "", "/admin/venues");
  };

  const setStatus = (status) => {
    setOffset(0);
    setFilter((f) => ({ ...f, status }));
  };

  const total = page?.total ?? 0;
  const shown = page?.restaurants?.length ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = offset + shown;

  return (
    <div className="admin-stack">
      <SectionCard
        title="Venues"
        icon="storefront"
        subtitle={
          page
            ? `${total} venue${total === 1 ? "" : "s"} on the platform${
                filter.status || filter.q ? " matching this filter" : ""
              }.`
            : "Loading…"
        }
        actions={
          <RefreshControl
            lastUpdatedAt={lastUpdatedAt}
            refreshing={refreshing}
            announcement={announcement}
            onRefresh={refresh}
          />
        }
      >
        <div className="adm-toolbar">
          <label className="adm-search">
            <Icon name="search" />
            <input
              className="admin-input"
              type="search"
              placeholder="Search by venue name or contact email…"
              value={filter.q}
              onChange={(e) => {
                setOffset(0);
                setFilter((f) => ({ ...f, q: e.target.value }));
              }}
              aria-label="Search venues"
            />
          </label>
          <select
            className="admin-input"
            value={filter.status}
            onChange={(e) => setStatus(e.target.value)}
            aria-label="Filter by onboarding status"
          >
            {STATUSES.map((s) => (
              <option key={s || "all"} value={s}>
                {s ? s.replace(/_/g, " ") : "All statuses"}
              </option>
            ))}
          </select>
        </div>

        {error ? (
          <div className="adm-stale-notice" role="status">
            <Icon name="cloud_off" />
            <span>
              Couldn&apos;t refresh — showing the last good data from{" "}
              {lastUpdatedAt ? relativeTime(new Date(lastUpdatedAt)).toLowerCase() : "earlier"}. {error}
            </span>
          </div>
        ) : null}

        <VenuesTable
          rows={page?.restaurants}
          loading={!page && !error}
          publishedTerms={page?.published_terms_version ?? null}
          onOpen={open}
          onClear={
            filter.status || filter.q
              ? () => {
                  setOffset(0);
                  setFilter({ status: "", q: "" });
                }
              : null
          }
        />

        {/* Pagination, stated. The list used to stop at 200 rows in silence. */}
        {total > 0 ? (
          <div className="adm-pager">
            <span className="admin-muted">
              Showing {from}–{to} of {total}
            </span>
            <div className="adm-card-actions">
              <AdminAction
                icon="chevron_left"
                blocked={offset === 0 ? "You're on the first page." : null}
                onAct={() => setOffset((o) => Math.max(o - PAGE_SIZE, 0))}
              >
                Previous
              </AdminAction>
              <AdminAction
                icon="chevron_right"
                blocked={to >= total ? "That's every venue matching this filter." : null}
                onAct={() => setOffset((o) => o + PAGE_SIZE)}
              >
                Next
              </AdminAction>
            </div>
          </div>
        ) : null}
      </SectionCard>

      {openVenue ? (
        <VenueDrawer
          venueId={openVenue.id}
          venueName={openVenue.name}
          publishedTerms={page?.published_terms_version ?? null}
          onClose={close}
          onChanged={refresh}
        />
      ) : null}
    </div>
  );
}
