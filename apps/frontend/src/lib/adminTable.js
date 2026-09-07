/**
 * Pure sorting logic for the admin DataTable, kept out of the component so it
 * can be tested without a DOM (the same split as lib/menuImportPlan.js).
 *
 * Two rules that are easy to get wrong and annoying to discover later:
 *
 *   1. Empty values sort LAST in both directions. An operator sorting by "last
 *      call" wants the venues that have calls — not a screen of blanks with the
 *      interesting rows pushed below the fold.
 *   2. Strings compare with `numeric: true`, so "10" doesn't land between "1"
 *      and "2". Venue names, phone numbers and version strings all hit this.
 */
export function compareRows(a, b, key, direction) {
  const av = a?.[key];
  const bv = b?.[key];
  const aEmpty = av === null || av === undefined || av === "";
  const bEmpty = bv === null || bv === undefined || bv === "";
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;

  const sign = direction === "descending" ? -1 : 1;
  if (typeof av === "number" && typeof bv === "number") return (av - bv) * sign;
  return String(av).localeCompare(String(bv), undefined, { numeric: true }) * sign;
}

/** Next sort state for a header click: same column flips, a new column starts ascending. */
export function nextSort(current, key) {
  if (current?.key === key) {
    return { key, direction: current.direction === "ascending" ? "descending" : "ascending" };
  }
  return { key, direction: "ascending" };
}

export function sortRows(rows, sort) {
  if (!sort || !rows) return rows ?? [];
  return [...rows].sort((a, b) => compareRows(a, b, sort.key, sort.direction));
}
