/**
 * Loading placeholder. Every admin panel showed a bare "Loading…" paragraph
 * with no `aria-busy` and no `role="status"`, so a screen reader was told
 * nothing at all — hence the wrappers below carry both.
 */
export function Skeleton({ width = "100%", height = 16, className = "", style }) {
  return (
    <span
      aria-hidden="true"
      className={`adm-skeleton ${className}`}
      style={{ display: "block", width, height, ...style }}
    />
  );
}

/** A block of stacked lines, for a panel body that is still loading. */
export function SkeletonLines({ lines = 3, label = "Loading" }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} style={{ display: "grid", gap: 8 }}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={i === lines - 1 ? "60%" : "100%"} />
      ))}
    </div>
  );
}

/** Placeholder row set for a table that is still loading. */
export function SkeletonRows({ rows = 3, columns = 4 }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} aria-hidden="true">
          {Array.from({ length: columns }, (__, c) => (
            <td key={c}>
              <Skeleton width={c === 0 ? "70%" : "45%"} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
