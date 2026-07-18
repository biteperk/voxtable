// Shared CSV export for the dashboard (Live Feed + Booking Log).
//
// Excel-safe by construction:
//   - UTF-8 BOM prefix so Excel reads accented caller names correctly.
//   - CRLF (\r\n) line endings — the format Excel expects.
//   - RFC-4180 quoting: wrap cells containing quote/comma/newline, double inner quotes.
//   - Formula-injection guard: cells hold caller-supplied text (names, notes) that
//     could start with = + - @ and execute in Excel/Sheets — prefix those with a '.

const BOM = "﻿";

function escapeCell(value) {
  let s = value === null || value === undefined ? "" : String(value);
  // Formula-injection guard (OWASP): neutralise leading formula/control chars.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  // RFC-4180 quoting.
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// columns: [{ label, value }] where value is a field name or (row) => cell.
export function toCsv(columns, rows) {
  const header = columns.map((c) => escapeCell(c.label)).join(",");
  const body = rows.map((row) =>
    columns
      .map((c) => escapeCell(typeof c.value === "function" ? c.value(row) : row[c.value]))
      .join(",")
  );
  return BOM + [header, ...body].join("\r\n") + "\r\n";
}

// yyyy-mm-dd in local time (matches the dashboard's local-TZ assumption).
export function isoDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function downloadBlob(filename, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Exports the given (already filtered) rows to `vocotable-<page>-<yyyy-mm-dd>.csv`.
// Returns false and does nothing when there are no rows.
export function exportRowsToCsv({ page, columns, rows }) {
  if (!rows || rows.length === 0) return false;
  downloadBlob(`vocotable-${page}-${isoDate()}.csv`, toCsv(columns, rows));
  return true;
}
