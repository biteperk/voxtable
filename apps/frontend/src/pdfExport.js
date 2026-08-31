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

export function exportAnalyticsPdf({ periodLabel, fileSlug, metrics, dailySeries, analytics }) {
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
  doc.text("VoxTable AI activity report", M, y + 22);

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
    { label: "Total Calls",        value: String(metrics.totalCalls),  hint: periodLabel },
    { label: "Booking Conversion", value: metrics.bookingRate,         hint: `${metrics.bookingsCount} bookings` },
    { label: "Est. Revenue",       value: metrics.monthlyRevenue,      hint: "$80 / booking" },
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
    "VoxTable · Voice-AI booking platform · biteperk.com.au",
    W / 2,
    doc.internal.pageSize.getHeight() - 24,
    { align: "center" }
  );

  // Save
  const fileDate = new Date().toISOString().slice(0, 10);
  doc.save(`voxtable-analytics-${fileSlug ?? "report"}-${fileDate}.pdf`);
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

// Australian tax-invoice issuer identity, used in both the letterhead and the
// footer (single source of truth). These name the LEGAL ENTITY that supplies
// the service, which is BitePerk Pty Ltd — not VoxTable, which is a product
// brand and not a legal person. A tax invoice has to identify the supplier and
// carry that supplier's ABN, so neither value is a branding choice. The ABN is
// the registered one for BITEPERK PTY LTD (see NUMBERS.md and the ACMA sender-ID
// runbook, which both use it for regulatory filings).
const RECEIPT_ENTITY = "BitePerk Pty Ltd";
const RECEIPT_ABN = "36 700 831 303";

export function exportReceiptPdf({ invoice, customer, plan }) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 48;
  const contentW = W - M * 2;

  // Money comes straight from Stripe via the backend mirror — integer cents
  // formatted into `*_display` strings at the edge. We render those verbatim so
  // the PDF can never diverge from the dashboard or Stripe. GST is Stripe's real
  // tax line (invoice.tax_cents), never total ÷ 1.1.
  const currencyLabel = (invoice.currency ?? "aud").toUpperCase();
  const subtotalDisplay = invoice.subtotal_display ?? "—";
  const gstDisplay = invoice.tax_display ?? "—";
  const totalDisplay = invoice.total_display ?? "—";
  const isRefunded = invoice.status === "refunded";
  const isPartialRefund = isRefunded && invoice.refund_type === "partial";
  const status = STATUS_STYLE[invoice.status] ?? STATUS_STYLE.paid;

  // ─── Letterhead ────────────────────────────────────────────────────────
  setText(doc, COLOR.text);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(22);
  doc.text("VoxTable", M, M + 4);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  setText(doc, COLOR.muted);
  // The supplier's legal name sits with its own ABN. "VoxTable" above is the
  // product wordmark; leaving the ABN under it alone read as though VoxTable
  // were the entity holding it, which it is not.
  doc.text(`${RECEIPT_ENTITY} · ABN ${RECEIPT_ABN}`, M, M + 20);
  doc.text("Voice-AI booking for restaurants", M, M + 32);
  doc.text("biteperk.com.au", M, M + 44);

  // Title (right aligned)
  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  setText(doc, COLOR.text);
  doc.text("TAX INVOICE", W - M, M + 4, { align: "right" });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  setText(doc, COLOR.muted);
  doc.text(`Invoice #${invoice.number ?? invoice.id}`, W - M, M + 22, { align: "right" });
  doc.text(`Issued ${formatLongDate(invoice.issued_at)}`, W - M, M + 36, { align: "right" });

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
  const cardLabel = invoice.card
    ? `${invoice.card.brand} •••• ${invoice.card.last4}`
    : "Card on file";
  doc.text(cardLabel, rx, y + 16);
  doc.setFontSize(10);
  setText(doc, COLOR.muted);
  const payLabel = isRefunded
    ? `Refunded ${formatLongDate(invoice.refunded_at)}`
    : invoice.status === "paid"
      ? `Charged ${formatLongDate(invoice.paid_at)}`
      : `Attempted ${formatLongDate(invoice.issued_at)}`;
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
  doc.text(subtotalDisplay, M + 380, rowY + 22, { align: "right" });
  doc.text(subtotalDisplay, W - M - 12, rowY + 22, { align: "right" });

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
  drawTotalRow("Subtotal", subtotalDisplay);
  drawTotalRow(invoice.tax_behavior === "inclusive" ? "GST (incl.)" : "GST", gstDisplay);
  // Divider above total
  setStroke(doc, COLOR.border);
  doc.setLineWidth(0.6);
  doc.line(totalsX, y - 6, totalsX + totalsW, y - 6);
  y += 6;
  drawTotalRow(`Total (${currencyLabel})`, totalDisplay, true);

  // ─── Refund note if applicable ────────────────────────────────────────
  if (isRefunded) {
    const noteLines = [];
    if (invoice.refunded_at) noteLines.push(`Refunded ${formatLongDate(invoice.refunded_at)}`);
    if (invoice.refund_reason) noteLines.push(`Reason: ${invoice.refund_reason}`);
    const boxH = 24 + (noteLines.length ? noteLines.length * 14 + 2 : 6);

    y += 12;
    setFill(doc, [255, 244, 222]);
    setStroke(doc, [255, 184, 77]);
    doc.setLineWidth(0.6);
    doc.roundedRect(M, y, contentW, boxH, 4, 4, "FD");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    setText(doc, [120, 80, 10]);
    const headline = isPartialRefund
      ? `Partially refunded — ${invoice.amount_refunded_display ?? ""} of ${totalDisplay}`.trim()
      : "This charge was fully refunded";
    doc.text(headline, M + 14, y + 16);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    let noteY = y + 30;
    for (const line of noteLines) {
      doc.text(line, M + 14, noteY);
      noteY += 14;
    }
    y += boxH + 12;
  }

  // ─── Footer ────────────────────────────────────────────────────────────
  setText(doc, COLOR.muted);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.text(
    "Questions about this invoice? Email hello@biteperk.com.au",
    W / 2,
    H - 48,
    { align: "center" }
  );
  doc.text(
    `${RECEIPT_ENTITY} · ABN ${RECEIPT_ABN} · biteperk.com.au`,
    W / 2,
    H - 32,
    { align: "center" }
  );

  doc.save(`voxtable-receipt-${invoice.id}.pdf`);
}
