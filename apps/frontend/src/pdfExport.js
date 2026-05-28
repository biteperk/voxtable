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

// ─── Receipt / Tax Invoice export ──────────────────────────────────────────

const STATUS_STYLE = {
  paid:     { label: "PAID",     fill: [0, 167, 110],   stroke: [0, 140, 88]  },
  refunded: { label: "REFUNDED", fill: [255, 184, 77],  stroke: [220, 150, 50] },
  failed:   { label: "FAILED",   fill: [219, 68, 68],   stroke: [180, 50, 50] },
};

function formatLongDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-AU", {
    day: "numeric", month: "long", year: "numeric"
  });
}

function formatMoney(n) { return `$${Number(n).toFixed(2)}`; }

export function exportReceiptPdf({ invoice, customer, plan }) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 48;
  const contentW = W - M * 2;

  const taxRate = 0.10; // Australian GST
  const totalInc = Number(invoice.amount);
  const subtotal = totalInc / (1 + taxRate);
  const gst = totalInc - subtotal;
  const status = STATUS_STYLE[invoice.status] ?? STATUS_STYLE.paid;

  // ─── Letterhead ────────────────────────────────────────────────────────
  setText(doc, COLOR.text);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(22);
  doc.text("VocoTable", M, M + 4);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  setText(doc, COLOR.muted);
  doc.text("Voice-AI booking for restaurants", M, M + 20);
  doc.text("vocotable.algorythmos.com.au", M, M + 32);
  doc.text("ABN 12 345 678 901", M, M + 44);

  // Title (right aligned)
  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  setText(doc, COLOR.text);
  doc.text("TAX INVOICE", W - M, M + 4, { align: "right" });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  setText(doc, COLOR.muted);
  doc.text(`Invoice #${invoice.id}`, W - M, M + 22, { align: "right" });
  doc.text(`Issued ${formatLongDate(invoice.issuedAt)}`, W - M, M + 36, { align: "right" });

  // ─── Status stamp ──────────────────────────────────────────────────────
  const stampW = 110, stampH = 30;
  const stampX = W - M - stampW;
  const stampY = M + 56;
  setFill(doc, status.fill);
  setStroke(doc, status.stroke);
  doc.setLineWidth(1.5);
  doc.roundedRect(stampX, stampY, stampW, stampH, 4, 4, "FD");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  setText(doc, [255, 255, 255]);
  doc.text(status.label, stampX + stampW / 2, stampY + stampH / 2 + 5, { align: "center" });

  let y = M + 110;
  setStroke(doc, COLOR.border);
  doc.setLineWidth(0.6);
  doc.line(M, y, W - M, y);
  y += 22;

  // ─── Bill To + Payment summary ────────────────────────────────────────
  const colW = (contentW - 24) / 2;

  // Left: Bill To
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  setText(doc, COLOR.muted);
  doc.text("BILL TO", M, y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  setText(doc, COLOR.text);
  doc.text(customer.name, M, y + 16);
  doc.setFontSize(10);
  setText(doc, COLOR.muted);
  doc.text(customer.email, M, y + 30);

  // Right: Payment info
  const rx = M + colW + 24;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  setText(doc, COLOR.muted);
  doc.text("PAYMENT", rx, y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  setText(doc, COLOR.text);
  doc.text(`${invoice.card.brand} •••• ${invoice.card.last4}`, rx, y + 16);
  doc.setFontSize(10);
  setText(doc, COLOR.muted);
  const payLabel = invoice.status === "refunded"
    ? `Refunded ${formatLongDate(invoice.refundedAt)}`
    : invoice.status === "paid"
      ? `Charged ${formatLongDate(invoice.paidAt)}`
      : `Attempted ${formatLongDate(invoice.issuedAt)}`;
  doc.text(payLabel, rx, y + 30);

  y += 60;

  // ─── Line items table ─────────────────────────────────────────────────
  const tableY = y;
  setFill(doc, COLOR.card);
  setStroke(doc, COLOR.border);
  doc.setLineWidth(0.4);
  // Header band
  doc.rect(M, tableY, contentW, 24, "F");
  doc.line(M, tableY, W - M, tableY);
  doc.line(M, tableY + 24, W - M, tableY + 24);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  setText(doc, COLOR.muted);
  doc.text("DESCRIPTION", M + 12, tableY + 16);
  doc.text("QTY", M + 280, tableY + 16, { align: "right" });
  doc.text("UNIT PRICE", M + 380, tableY + 16, { align: "right" });
  doc.text("AMOUNT", W - M - 12, tableY + 16, { align: "right" });

  // Single line item — the monthly subscription
  const rowY = tableY + 24;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  setText(doc, COLOR.text);
  doc.text(plan.name, M + 12, rowY + 22);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  setText(doc, COLOR.muted);
  doc.text(plan.description, M + 12, rowY + 36);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  setText(doc, COLOR.text);
  doc.text("1", M + 280, rowY + 22, { align: "right" });
  doc.text(formatMoney(subtotal), M + 380, rowY + 22, { align: "right" });
  doc.text(formatMoney(subtotal), W - M - 12, rowY + 22, { align: "right" });

  const rowH = 60;
  doc.line(M, tableY + 24 + rowH, W - M, tableY + 24 + rowH);

  y = tableY + 24 + rowH + 16;

  // ─── Totals block (right-aligned) ─────────────────────────────────────
  const totalsX = W - M - 200;
  const totalsW = 200;

  const drawTotalRow = (label, value, bold = false) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(bold ? 12 : 10);
    setText(doc, bold ? COLOR.text : COLOR.muted);
    doc.text(label, totalsX, y);
    setText(doc, COLOR.text);
    doc.text(value, totalsX + totalsW, y, { align: "right" });
    y += bold ? 22 : 18;
  };
  drawTotalRow("Subtotal", formatMoney(subtotal));
  drawTotalRow(`GST (${(taxRate * 100).toFixed(0)}%)`, formatMoney(gst));
  // Divider above total
  setStroke(doc, COLOR.border);
  doc.setLineWidth(0.6);
  doc.line(totalsX, y - 6, totalsX + totalsW, y - 6);
  y += 6;
  drawTotalRow("Total (AUD)", formatMoney(totalInc), true);

  // ─── Refund note if applicable ────────────────────────────────────────
  if (invoice.status === "refunded") {
    y += 12;
    setFill(doc, [255, 244, 222]);
    setStroke(doc, [255, 184, 77]);
    doc.setLineWidth(0.6);
    doc.roundedRect(M, y, contentW, 38, 4, 4, "FD");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    setText(doc, [120, 80, 10]);
    doc.text("This charge was refunded", M + 14, y + 16);
    if (invoice.refundReason) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.text(`Reason: ${invoice.refundReason}`, M + 14, y + 30);
    }
    y += 50;
  }

  // ─── Footer ────────────────────────────────────────────────────────────
  setText(doc, COLOR.muted);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.text(
    "Questions about this invoice? Email billing@vocotable.algorythmos.com.au",
    W / 2,
    H - 48,
    { align: "center" }
  );
  doc.text(
    "VocoTable Pty Ltd · ABN 12 345 678 901 · vocotable.algorythmos.com.au",
    W / 2,
    H - 32,
    { align: "center" }
  );

  doc.save(`vocotable-receipt-${invoice.id}.pdf`);
}
