// Lazy-loaded PDF export for Performance Analytics.
// Bundled as a separate chunk via dynamic import in AnalyticsPage —
// users who never click "Export" don't pay the jsPDF download cost.

import { jsPDF } from "jspdf";

const COLOR = {
  text:   [17, 17, 17],
  muted:  [110, 110, 110],
  border: [220, 224, 232],
  card:   [247, 249, 252],
  primary:    [75, 142, 255],   // matches --primary-container
  secondary:  [0, 219, 233],    // --secondary-fixed-dim
  tertiary:   [255, 138, 101],
};

function setFill(doc, [r, g, b]) { doc.setFillColor(r, g, b); }
function setStroke(doc, [r, g, b]) { doc.setDrawColor(r, g, b); }
function setText(doc, [r, g, b]) { doc.setTextColor(r, g, b); }

export function exportAnalyticsPdf({ days, periodLabel, metrics, dailySeries, analytics }) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const M = 40;
  const contentW = W - M * 2;
  let y = M;

  // ─── Header ────────────────────────────────────────────────────────────
  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  setText(doc, COLOR.text);
  doc.text("Performance Analytics", M, y + 4);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  setText(doc, COLOR.muted);
  doc.text("VocoTable AI activity report", M, y + 22);

  const generatedAt = new Date().toLocaleString("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  doc.text(`Generated ${generatedAt}`, W - M, y + 4, { align: "right" });
  doc.setFont("helvetica", "bold");
  doc.text(periodLabel, W - M, y + 22, { align: "right" });

  y += 40;
  setStroke(doc, COLOR.border);
  doc.setLineWidth(0.6);
  doc.line(M, y, W - M, y);
  y += 18;

  // ─── KPI grid (2x2) ────────────────────────────────────────────────────
  const cardW = (contentW - 14) / 2;
  const cardH = 76;

  const kpis = [
    { label: "Total Calls",        value: String(metrics.totalCalls),  hint: `last ${days}d` },
    { label: "Booking Conversion", value: metrics.bookingRate,         hint: `${metrics.bookingsCount} bookings` },
    { label: "Daily Avg Revenue",  value: metrics.dailyRevenue,        hint: "$80 / booking" },
    { label: "Avg Call Duration",  value: metrics.avgDuration,         hint: analytics?.avg_latency_ms ? `${metrics.avgLatency} latency` : "" },
  ];

  kpis.forEach((kpi, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = M + col * (cardW + 14);
    const cy = y + row * (cardH + 12);

    setFill(doc, COLOR.card);
    setStroke(doc, COLOR.border);
    doc.roundedRect(x, cy, cardW, cardH, 6, 6, "FD");

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    setText(doc, COLOR.muted);
    doc.text(kpi.label.toUpperCase(), x + 14, cy + 18);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(24);
    setText(doc, COLOR.text);
    doc.text(kpi.value, x + 14, cy + 48);

    if (kpi.hint) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      setText(doc, COLOR.muted);
      doc.text(kpi.hint, x + 14, cy + 65);
    }
  });
  y += cardH * 2 + 12 + 24;

  // ─── Call Volume chart ─────────────────────────────────────────────────
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  setText(doc, COLOR.text);
  doc.text("Call Volume & Outcomes", M, y);

  // Legend
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  setFill(doc, COLOR.primary);
  doc.rect(M + 200, y - 8, 10, 10, "F");
  setText(doc, COLOR.muted);
  doc.text("Total Calls", M + 215, y);
  setFill(doc, COLOR.secondary);
  doc.rect(M + 290, y - 8, 10, 10, "F");
  doc.text("Confirmed Bookings", M + 305, y);
  y += 14;

  const chartH = 160;
  const chartX = M + 32;
  const chartY = y;
  const chartW = contentW - 32;

  // Y axis
  const maxTotal = Math.max(1, ...dailySeries.map((d) => d.total));
  const niceMax = Math.max(4, Math.ceil(maxTotal / 4) * 4);
  setStroke(doc, COLOR.border);
  doc.setLineWidth(0.4);
  for (let i = 0; i <= 4; i++) {
    const ty = chartY + chartH - (chartH * i) / 4;
    doc.line(chartX, ty, chartX + chartW, ty);
    setText(doc, COLOR.muted);
    doc.setFontSize(8);
    doc.text(String(Math.round((niceMax * i) / 4)), chartX - 4, ty + 3, { align: "right" });
  }

  // Bars
  const n = dailySeries.length || 1;
  const gap = n > 14 ? 1.5 : 4;
  const barW = (chartW - gap * (n - 1)) / n;
  dailySeries.forEach((d, i) => {
    const bx = chartX + i * (barW + gap);
    const totalH = (d.total / niceMax) * chartH;
    const confirmedH = d.total > 0 ? (d.confirmed / d.total) * totalH : 0;
    setFill(doc, COLOR.primary);
    doc.rect(bx, chartY + chartH - totalH, barW, totalH, "F");
    if (confirmedH > 0) {
      setFill(doc, COLOR.secondary);
      doc.rect(bx, chartY + chartH - confirmedH, barW, confirmedH, "F");
    }
  });

  // X axis labels (sampled if too many)
  const useShortDate = n > 7;
  const stride = n <= 14 ? 1 : Math.ceil(n / 10);
  doc.setFontSize(7);
  setText(doc, COLOR.muted);
  dailySeries.forEach((d, i) => {
    if (i % stride !== 0) return;
    const bx = chartX + i * (barW + gap) + barW / 2;
    doc.text(useShortDate ? d.shortDate : d.label, bx, chartY + chartH + 12, { align: "center" });
  });

  y = chartY + chartH + 32;

  // ─── Outcome Breakdown ─────────────────────────────────────────────────
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  setText(doc, COLOR.text);
  doc.text("Outcome Breakdown", M, y);
  y += 14;

  const total = analytics?.total_calls ?? 0;
  const bookings = analytics?.bookings_created ?? 0;
  const transferred = analytics?.transferred ?? 0;
  const other = Math.max(0, total - bookings - transferred);
  const pct = (v) => (total ? `${Math.round((v / total) * 100)}%` : "—");

  const rows = [
    { label: "Confirmed Bookings",   count: bookings,    pct: pct(bookings),    color: COLOR.primary },
    { label: "FAQ / Other",          count: other,       pct: pct(other),       color: COLOR.secondary },
    { label: "Transferred to Staff", count: transferred, pct: pct(transferred), color: COLOR.tertiary },
  ];

  // Table-style breakdown
  const rowH = 32;
  rows.forEach((r, i) => {
    const ry = y + i * (rowH + 6);
    setFill(doc, COLOR.card);
    setStroke(doc, COLOR.border);
    doc.roundedRect(M, ry, contentW, rowH, 5, 5, "FD");

    // Color dot
    setFill(doc, r.color);
    doc.circle(M + 14, ry + rowH / 2, 4, "F");

    // Label
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    setText(doc, COLOR.text);
    doc.text(r.label, M + 26, ry + rowH / 2 + 4);

    // Count + pct (right-aligned)
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text(`${r.count}`, W - M - 70, ry + rowH / 2 + 4, { align: "right" });
    setText(doc, COLOR.muted);
    doc.setFont("helvetica", "normal");
    doc.text(r.pct, W - M - 14, ry + rowH / 2 + 4, { align: "right" });
  });
  y += rows.length * (rowH + 6) + 12;

  // ─── Footer ─────────────────────────────────────────────────────────────
  setText(doc, COLOR.muted);
  doc.setFontSize(8);
  doc.text(
    "VocoTable · Voice-AI booking platform · vocotable.algorythmos.com.au",
    W / 2,
    doc.internal.pageSize.getHeight() - 24,
    { align: "center" }
  );

  // Save
  const fileDate = new Date().toISOString().slice(0, 10);
  doc.save(`vocotable-analytics-${days}d-${fileDate}.pdf`);
}
