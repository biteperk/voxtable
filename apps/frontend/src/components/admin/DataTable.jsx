import { useMemo, useState } from "react";

import { nextSort, sortRows } from "../../lib/adminTable";
import { Icon } from "../Icon";
import { EmptyState } from "./EmptyState";
import { SkeletonRows } from "./Skeleton";

/**
 * A real `<table>` with `scope="col"`, a caption, sortable headers, and honest
 * loading and empty states. Venues and Support were card stacks, so neither
 * could be scanned down a column or sorted at all.
 *
 * columns: [{ key, label, sortable, align, render(row) }]
 */
export function DataTable({
  caption,
  columns,
  rows,
  loading = false,
  empty,
  onRowClick,
  rowKey = (row) => row.id,
  initialSort = null
}) {
  const [sort, setSort] = useState(initialSort);

  const sorted = useMemo(() => sortRows(rows, sort), [rows, sort]);

  const toggleSort = (key) => setSort((current) => nextSort(current, key));

  // An empty table is a message, not an empty grid with headers.
  if (!loading && (!rows || rows.length === 0) && empty) {
    return <div className="adm-table-wrap">{empty}</div>;
  }

  return (
    <div className="adm-table-wrap">
      <table className="adm-table">
        {caption ? <caption>{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((col) => {
              const active = sort?.key === col.key;
              const ariaSort = active ? sort.direction : "none";
              return (
                <th key={col.key} scope="col" style={col.align ? { textAlign: col.align } : undefined}>
                  {col.sortable ? (
                    <button
                      type="button"
                      className="adm-table-sort"
                      aria-sort={ariaSort}
                      onClick={() => toggleSort(col.key)}
                    >
                      {col.label}
                      <Icon
                        name={
                          active
                            ? sort.direction === "ascending"
                              ? "arrow_upward"
                              : "arrow_downward"
                            : "unfold_more"
                        }
                      />
                    </button>
                  ) : (
                    col.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <SkeletonRows columns={columns.length} />
          ) : (
            sorted.map((row) => (
              <tr
                key={rowKey(row)}
                className={onRowClick ? "is-clickable" : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onRowClick(row);
                        }
                      }
                    : undefined
                }
              >
                {columns.map((col) => (
                  <td key={col.key} style={col.align ? { textAlign: col.align } : undefined}>
                    {col.render ? col.render(row) : row[col.key]}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export { EmptyState };
