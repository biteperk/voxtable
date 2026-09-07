import { Badge } from "../../../components/admin/Badge";
import { DataTable } from "../../../components/admin/DataTable";
import { EmptyState } from "../../../components/admin/EmptyState";
import { relativeTime } from "../../../lib/format";
import { LINE_LABEL, LINE_TONE, lineState } from "../../../lib/venueLine";

/**
 * The venue list as a table: scannable down a column and sortable, which a
 * stack of cards never was. Enough state per row to triage without opening
 * anything — status, whether the line can actually ring, terms drift, billing,
 * how much of the venue is set up, and when it last did something.
 */
export function VenuesTable({ rows, loading, publishedTerms, onOpen, onClear }) {
  return (
    <DataTable
      caption="Venues, newest first"
      loading={loading}
      rows={rows ?? []}
      rowKey={(row) => row.id}
      onRowClick={(row) => onOpen(row)}
      columns={[
        {
          key: "name",
          label: "Venue",
          sortable: true,
          render: (row) => (
            <span className="adm-venue-cell">
              <strong>{row.name}</strong>
              <span className="admin-muted">{row.contact_email ?? "no contact email"}</span>
            </span>
          )
        },
        {
          key: "onboarding_status",
          label: "Status",
          sortable: true,
          render: (row) => (
            <Badge state={row.onboarding_status === "live" ? "ok" : "neutral"} icon={null}>
              {row.onboarding_status.replace(/_/g, " ")}
            </Badge>
          )
        },
        {
          key: "line",
          label: "Phone line",
          render: (row) => {
            const state = lineState(row);
            return <Badge state={LINE_TONE[state]}>{LINE_LABEL[state]}</Badge>;
          }
        },
        {
          key: "setup",
          label: "Set up",
          render: (row) => (
            <span className="admin-muted adm-setup-cell">
              {row.hours_set ? "hours" : "no hours"} · {row.table_count ?? 0} tables ·{" "}
              {row.menu_item_count ?? 0} menu items
            </span>
          )
        },
        {
          key: "terms_version",
          label: "Terms",
          sortable: true,
          render: (row) => {
            if (!row.terms_version) return <Badge state="warn">none</Badge>;
            const drift = publishedTerms && row.terms_version !== publishedTerms;
            return (
              <Badge state={drift ? "warn" : "ok"} icon={null}>
                {row.terms_version}
                {drift ? " (old)" : ""}
              </Badge>
            );
          }
        },
        {
          key: "has_stripe_customer",
          label: "Billing",
          sortable: true,
          render: (row) =>
            row.has_stripe_customer ? (
              <Badge state="ok" icon={null}>
                stripe
              </Badge>
            ) : (
              <span className="admin-muted">—</span>
            )
        },
        {
          key: "last_call_at",
          label: "Last call",
          sortable: true,
          render: (row) =>
            row.last_call_at ? relativeTime(new Date(row.last_call_at)) : <span className="admin-muted">never</span>
        }
      ]}
      empty={
        <EmptyState
          icon="storefront"
          title="No venues match"
          action={
            onClear ? (
              <button type="button" className="ghost-button" onClick={onClear}>
                Clear the filters
              </button>
            ) : null
          }
        >
          Nothing on the platform matches this search and status.
        </EmptyState>
      }
    />
  );
}
