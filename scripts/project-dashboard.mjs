#!/usr/bin/env node
/**
 * VoxTable project dashboard generator.
 *
 * Pulls live data from GitHub (issues, project board, milestone, merged PRs)
 * via the `gh` CLI, merges it with the narrative in scripts/dashboard-content.json,
 * and writes a fully self-contained voxtable-dashboard.html at the repo root.
 *
 *   npm run dashboard
 *
 * Requirements: `gh` authenticated with repo access; the `project` scope is
 * needed for board columns (run `gh auth refresh -s project` once if missing).
 * Fails soft: anything unreachable renders as a visible "partial data" notice
 * instead of aborting.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "biteperk/voxtable";
const ORG = "biteperk";
const PROJECT_NUMBER = 1;
const MILESTONE_TITLE = "Production Go Live";
const TZ = "Australia/Sydney";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "voxtable-dashboard.html");
const content = JSON.parse(readFileSync(join(here, "dashboard-content.json"), "utf8"));

const warnings = [];

function gh(args, label) {
  try {
    return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    warnings.push(label);
    return null;
  }
}
function ghJSON(args, label) {
  const out = gh(args, label);
  if (out === null) return null;
  try { return JSON.parse(out); } catch { warnings.push(label); return null; }
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

// All issues (REST; includes type, milestone, org issue fields). PRs share the
// numbering on this endpoint and are filtered out by the pull_request key.
const rawIssues = ghJSON(
  ["api", `repos/${REPO}/issues?state=all&per_page=100`, "--paginate"],
  "issues"
) ?? [];
const issues = rawIssues
  .filter((i) => !i.pull_request)
  .map((i) => ({
    number: i.number,
    title: i.title,
    state: i.state,
    url: i.html_url,
    labels: (i.labels ?? []).map((l) => l.name),
    milestone: i.milestone?.title ?? null,
    assignees: (i.assignees ?? []).map((a) => a.login),
    type: i.type?.name ?? null,
    priority:
      (i.issue_field_values ?? []).find((f) => f.issue_field_name === "Priority")
        ?.single_select_option?.name ?? null,
    createdAt: i.created_at,
    closedAt: i.closed_at,
  }));

// Project board: status + iteration per issue, plus the latest status update.
const boardQuery = `query($org:String!,$num:Int!,$cursor:String){
  organization(login:$org){ projectV2(number:$num){
    statusUpdates(last:1){ nodes { body status startDate targetDate updatedAt } }
    field(name:"Iteration"){ ... on ProjectV2IterationField { configuration { iterations { title startDate duration } } } }
    items(first:100, after:$cursor){
      pageInfo { hasNextPage endCursor }
      nodes {
        content { ... on Issue { number } }
        fieldValues(first:20){ nodes {
          ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } }
          ... on ProjectV2ItemFieldIterationValue { title field { ... on ProjectV2IterationField { name } } }
        } }
      }
    }
  } }
}`;

const board = new Map(); // issue number -> {status, iteration}
let iterations = [];
let statusUpdate = null;
{
  let cursor = null;
  for (;;) {
    const args = ["api", "graphql", "-f", `query=${boardQuery}`, "-f", `org=${ORG}`, "-F", `num=${PROJECT_NUMBER}`];
    if (cursor) args.push("-f", `cursor=${cursor}`);
    const page = ghJSON(args, "project board");
    const proj = page?.data?.organization?.projectV2;
    if (!proj) break;
    iterations = proj.field?.configuration?.iterations ?? iterations;
    statusUpdate = proj.statusUpdates?.nodes?.[0] ?? statusUpdate;
    for (const item of proj.items?.nodes ?? []) {
      const num = item.content?.number;
      if (!num) continue;
      const entry = { status: null, iteration: null };
      for (const fv of item.fieldValues?.nodes ?? []) {
        if (fv?.field?.name === "Status") entry.status = fv.name;
        if (fv?.field?.name === "Iteration") entry.iteration = fv.title;
      }
      board.set(num, entry);
    }
    if (!proj.items?.pageInfo?.hasNextPage) break;
    cursor = proj.items.pageInfo.endCursor;
  }
}

const mergedPRs = ghJSON(
  ["pr", "list", "--repo", REPO, "--state", "merged", "--limit", "300",
    "--json", "number,title,mergedAt,url"],
  "merged PRs"
) ?? [];

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

const now = new Date();
const DAY = 86400000;
const fmtDate = (d, opts = { day: "numeric", month: "short" }) =>
  new Date(d).toLocaleDateString("en-AU", { timeZone: TZ, ...opts });
const daysBetween = (a, b) => Math.round((b - a) / DAY);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const open = issues.filter((i) => i.state === "open");
const milestoneIssues = issues.filter((i) => i.milestone === MILESTONE_TITLE);
const msOpen = milestoneIssues.filter((i) => i.state === "open");
const msClosed = milestoneIssues.filter((i) => i.state === "closed");
const TARGET = new Date("2026-08-23T00:00:00+10:00");
const daysToTarget = daysBetween(now, TARGET);

// Iteration windows
const iterWindows = iterations.map((it) => {
  const start = new Date(`${it.startDate}T00:00:00+10:00`);
  return { title: it.title, start, end: new Date(start.getTime() + it.duration * DAY) };
});
const currentIter = iterWindows.find((w) => now >= w.start && now < w.end) ?? iterWindows[0];
const nextIter = iterWindows[iterWindows.indexOf(currentIter) + 1];

const withBoard = (i) => ({ ...i, ...(board.get(i.number) ?? { status: null, iteration: null }) });
const openB = open.map(withBoard);
const nowCol = openB.filter((i) => i.iteration === currentIter?.title);
const nextCol = openB.filter((i) => i.iteration === nextIter?.title);
const laterCol = openB.filter((i) => !i.iteration);
const doneThisIter = issues.map(withBoard).filter((i) => i.state === "closed" && i.iteration === currentIter?.title);

const wip = openB.filter((i) => i.status === "In progress").length;
const urgentOpen = open.filter((i) => i.priority === "Urgent");
const highOpen = open.filter((i) => i.priority === "High");

// Workstream mapping (content file rules; first match wins by explicit number, then labels/title)
function workstreamOf(issue) {
  for (const ws of content.workstreams) {
    if ((ws.issue_numbers ?? []).includes(issue.number)) return ws.key;
  }
  for (const ws of content.workstreams) {
    const labels = ws.labels ?? [];
    const excl = ws.exclude_labels ?? [];
    if (labels.length && labels.some((l) => issue.labels.includes(l)) && !excl.some((l) => issue.labels.includes(l))) return ws.key;
    if ((ws.match_title ?? []).some((t) => issue.title.toLowerCase().includes(t))) return ws.key;
  }
  return "other";
}
const wsBuckets = new Map(content.workstreams.map((w) => [w.key, []]));
wsBuckets.set("other", []);
for (const i of open) wsBuckets.get(workstreamOf(i)).push(i);

// RAG per workstream: red = open Urgent; amber = open High on the milestone; green otherwise.
const rag = content.workstreams.map((ws) => {
  const items = wsBuckets.get(ws.key) ?? [];
  const urgent = items.filter((i) => i.priority === "Urgent");
  const high = items.filter((i) => i.priority === "High" && i.milestone === MILESTONE_TITLE);
  const level = urgent.length ? "red" : high.length ? "amber" : "green";
  const blocking = [...urgent, ...high].slice(0, 3);
  const reason = urgent.length
    ? `${urgent.length} urgent open`
    : high.length
      ? `${high.length} high-priority item${high.length > 1 ? "s" : ""} before go-live`
      : items.length
        ? `${items.length} open, none urgent`
        : "no open work";
  return { ...ws, level, reason, blocking, count: items.length };
});

// Burn-up (milestone issues): cumulative scope vs done, daily.
const msDates = milestoneIssues.map((i) => new Date(i.createdAt));
const burnStart = msDates.length ? new Date(Math.min(...msDates)) : new Date(now - 30 * DAY);
const burnEnd = new Date(Math.max(TARGET.getTime() + 4 * DAY, now.getTime() + 2 * DAY));
const burnDays = [];
for (let t = burnStart.getTime(); t <= burnEnd.getTime(); t += DAY) burnDays.push(new Date(t));
const scopeSeries = burnDays.map((d) => milestoneIssues.filter((i) => new Date(i.createdAt) <= d).length);
const doneSeries = burnDays.map((d) => (d > now ? null : milestoneIssues.filter((i) => i.closedAt && new Date(i.closedAt) <= d).length));

// Velocity over the trailing 14 days -> projection.
const closed14 = milestoneIssues.filter((i) => i.closedAt && now - new Date(i.closedAt) <= 14 * DAY).length;
const velocity = closed14 / 14; // issues per day
const remaining = msOpen.length;
const projDays = velocity > 0 ? Math.ceil(remaining / velocity) : null;
const projDate = projDays !== null ? new Date(now.getTime() + projDays * DAY) : null;
const burnInsight =
  velocity === 0
    ? `No milestone issues have closed in the last two weeks. At this pace the ${fmtDate(TARGET)} target is not met — the milestone needs resequencing or descoping, or closures need to start this week.`
    : projDate <= TARGET
      ? `At the current pace (${closed14} closed in 14 days), the remaining ${remaining} land around ${fmtDate(projDate)} — ahead of the ${fmtDate(TARGET)} target.`
      : `At the current pace (${closed14} closed in 14 days), the remaining ${remaining} land around ${fmtDate(projDate)} — after the ${fmtDate(TARGET)} target. Descope or resequence to hold the date.`;

// Weekly throughput, last 8 weeks (Mon-anchored).
const weekStart = (d) => { const x = new Date(d); const dow = (x.getDay() + 6) % 7; x.setHours(0, 0, 0, 0); return new Date(x.getTime() - dow * DAY); };
const thisWeek = weekStart(now);
const weeks = Array.from({ length: 8 }, (_, k) => new Date(thisWeek.getTime() - (7 - k) * 7 * DAY));
const weekly = weeks.map((w) => {
  const end = new Date(w.getTime() + 7 * DAY);
  return {
    label: fmtDate(w),
    issuesClosed: issues.filter((i) => i.closedAt && new Date(i.closedAt) >= w && new Date(i.closedAt) < end).length,
    prsMerged: mergedPRs.filter((p) => p.mergedAt && new Date(p.mergedAt) >= w && new Date(p.mergedAt) < end).length,
  };
});

// Cycle time: median open->closed days for issues closed in the last 30 days.
const recentCycle = issues
  .filter((i) => i.closedAt && now - new Date(i.closedAt) <= 30 * DAY)
  .map((i) => (new Date(i.closedAt) - new Date(i.createdAt)) / DAY)
  .sort((a, b) => a - b);
const median = (a) => (a.length ? a[Math.floor(a.length / 2)] : null);
const cycleMedian = median(recentCycle);
const oldestUrgent = urgentOpen.length
  ? Math.max(...urgentOpen.map((i) => daysBetween(new Date(i.createdAt), now)))
  : null;

// Risk register: auto rows (open urgent anywhere + open high compliance/bug) + curated.
const sevRank = { critical: 0, serious: 1, warning: 2 };
const autoRisks = [
  ...urgentOpen.map((i) => ({ severity: "critical", risk: i.title, owner: i.assignees.join(", ") || "unassigned", link: i.url, number: i.number })),
  ...highOpen
    .filter((i) => i.labels.includes("compliance") || i.labels.includes("bug"))
    .map((i) => ({ severity: "serious", risk: i.title, owner: i.assignees.join(", ") || "unassigned", link: i.url, number: i.number })),
];
const risks = [...autoRisks, ...content.curated_risks].sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);

const recentShippedPRs = mergedPRs.slice(0, 10);
const recentClosedIssues = issues
  .filter((i) => i.closedAt)
  .sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt))
  .slice(0, 5);

const overall = rag.some((r) => r.level === "red") ? { label: "At risk — urgent items open", cls: "red" }
  : rag.some((r) => r.level === "amber") ? { label: "On track, watch the ambers", cls: "amber" }
  : { label: "On track", cls: "green" };

const generatedAt = now.toLocaleString("en-AU", { timeZone: TZ, dateStyle: "full", timeStyle: "short" });

// ---------------------------------------------------------------------------
// SVG chart builders (theme-safe: colors come from CSS vars; text uses ink tokens)
// ---------------------------------------------------------------------------

function burnupSVG() {
  const W = 860, H = 300, L = 44, R = 130, T = 18, B = 34;
  const pw = W - L - R, ph = H - T - B;
  const yMax = Math.max(...scopeSeries, 1) * 1.15;
  const x = (idx) => L + (idx / (burnDays.length - 1)) * pw;
  const y = (v) => T + ph - (v / yMax) * ph;
  const xDate = (d) => L + ((d - burnStart) / (burnEnd - burnStart)) * pw;

  const line = (series) => {
    let dstr = "";
    series.forEach((v, i) => { if (v === null) return; dstr += `${dstr ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; });
    return dstr;
  };
  const doneIdx = doneSeries.reduce((acc, v, i) => (v === null ? acc : i), 0);
  const doneNow = doneSeries[doneIdx] ?? 0;
  const scopeNow = scopeSeries[scopeSeries.length - 1];

  let projection = "";
  if (projDate && projDate <= burnEnd) {
    projection = `<path d="M${x(doneIdx).toFixed(1)},${y(doneNow).toFixed(1)} L${xDate(projDate).toFixed(1)},${y(scopeNow).toFixed(1)}" fill="none" stroke="var(--chart-1)" stroke-width="2" stroke-dasharray="6 5" opacity="0.85"/>
      <text x="${xDate(projDate).toFixed(1)}" y="${(y(scopeNow) - 8).toFixed(1)}" class="c-lbl" text-anchor="middle">projected ${esc(fmtDate(projDate))}</text>`;
  } else if (projDate) {
    projection = `<path d="M${x(doneIdx).toFixed(1)},${y(doneNow).toFixed(1)} L${(W - R + 4).toFixed(1)},${y(doneNow + velocity * ((burnEnd - now) / DAY)).toFixed(1)}" fill="none" stroke="var(--chart-1)" stroke-width="2" stroke-dasharray="6 5" opacity="0.85"/>
      <text x="${(W - R + 6).toFixed(1)}" y="${y(doneNow + velocity * ((burnEnd - now) / DAY)).toFixed(1)}" class="c-lbl">→ ${esc(fmtDate(projDate))}</text>`;
  }

  const gridVals = [0, Math.round(yMax / 2), Math.round(yMax / 1.15)];
  const grid = gridVals.map((v) => `<line x1="${L}" y1="${y(v)}" x2="${W - R}" y2="${y(v)}" class="c-grid"/><text x="${L - 8}" y="${y(v) + 4}" class="c-lbl" text-anchor="end">${v}</text>`).join("");
  const ticks = [burnStart, TARGET, burnEnd].map((d) => `<text x="${xDate(d).toFixed(1)}" y="${H - 10}" class="c-lbl" text-anchor="middle">${esc(fmtDate(d))}</text>`).join("");

  const hover = burnDays.map((d, i) => {
    const dv = doneSeries[i]; const sv = scopeSeries[i];
    if (i % 2 !== 0) return "";
    return `<rect x="${(x(i) - pw / burnDays.length).toFixed(1)}" y="${T}" width="${(2 * pw / burnDays.length).toFixed(1)}" height="${ph}" fill="transparent" data-tip="${esc(fmtDate(d))} — scope ${sv}, done ${dv ?? doneNow}"/>`;
  }).join("");

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Burn-up of Production Go Live milestone: scope versus completed issues over time with a projection line">
    ${grid}
    <line x1="${xDate(TARGET).toFixed(1)}" y1="${T}" x2="${xDate(TARGET).toFixed(1)}" y2="${T + ph}" stroke="var(--danger)" stroke-width="1.5" stroke-dasharray="3 4"/>
    <text x="${xDate(TARGET).toFixed(1)}" y="${T - 4}" class="c-lbl" text-anchor="middle">${esc(fmtDate(TARGET))} target</text>
    <path d="${line(scopeSeries)}" fill="none" stroke="var(--chart-2)" stroke-width="2"/>
    <path d="${line(doneSeries)}" fill="none" stroke="var(--chart-1)" stroke-width="2.5"/>
    ${projection}
    <circle cx="${x(doneIdx).toFixed(1)}" cy="${y(doneNow).toFixed(1)}" r="4" fill="var(--chart-1)" stroke="var(--ink-1)" stroke-width="2"/>
    <text x="${(W - R + 6)}" y="${y(scopeNow) + 4}" class="c-lbl c-lbl-strong">Scope ${scopeNow}</text>
    <text x="${(x(doneIdx) + 8).toFixed(1)}" y="${(y(doneNow) + 14).toFixed(1)}" class="c-lbl c-lbl-strong">Done ${doneNow}</text>
    ${ticks}${hover}
  </svg>`;
}

function weeklyBarsSVG(key, label) {
  const W = 420, H = 170, L = 8, T = 26, B = 26;
  const pw = W - 2 * L, ph = H - T - B;
  const max = Math.max(...weekly.map((w) => w[key]), 1);
  const bw = Math.min(34, pw / weekly.length - 8);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)} per week, last 8 weeks">
    ${weekly.map((w, i) => {
      const h = Math.max((w[key] / max) * ph, w[key] ? 3 : 0);
      const cx = L + (i + 0.5) * (pw / weekly.length);
      return `<rect x="${(cx - bw / 2).toFixed(1)}" y="${(T + ph - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="var(--chart-1)" data-tip="wk ${esc(w.label)}: ${w[key]} ${esc(label.toLowerCase())}"/>
      <text x="${cx.toFixed(1)}" y="${(T + ph - h - 6).toFixed(1)}" class="c-lbl" text-anchor="middle">${w[key] || ""}</text>
      <text x="${cx.toFixed(1)}" y="${H - 8}" class="c-lbl" text-anchor="middle">${esc(w.label)}</text>`;
    }).join("")}
    <line x1="${L}" y1="${T + ph}" x2="${W - L}" y2="${T + ph}" class="c-grid"/>
  </svg>`;
}

function hBarsSVG(rows, ariaLabel) {
  const W = 420, rowH = 30, L = 128, R = 40;
  const H = rows.length * rowH + 8;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(ariaLabel)}">
    ${rows.map((r, i) => {
      const w = ((r.value / max) * (W - L - R));
      const yy = i * rowH + 6;
      return `<text x="${L - 10}" y="${yy + 14}" class="c-lbl" text-anchor="end">${esc(r.label)}</text>
      <rect x="${L}" y="${yy}" width="${Math.max(w, r.value ? 3 : 0).toFixed(1)}" height="18" rx="4" fill="var(--chart-1)" data-tip="${esc(r.label)}: ${r.value} open"/>
      <text x="${(L + Math.max(w, 3) + 8).toFixed(1)}" y="${yy + 14}" class="c-lbl c-lbl-strong">${r.value}</text>`;
    }).join("")}
  </svg>`;
}

// ---------------------------------------------------------------------------
// HTML fragments
// ---------------------------------------------------------------------------

const priClass = { Urgent: "p-urgent", High: "p-high", Medium: "p-medium", Low: "p-low" };
const card = (i) => {
  const age = daysBetween(new Date(i.createdAt), now);
  return `<a class="card" href="${esc(i.url)}" target="_blank" rel="noopener">
    <span class="card-top"><span class="num">#${i.number}</span>
      ${i.type ? `<span class="type">${esc(i.type)}</span>` : ""}
      ${i.priority ? `<span class="pri ${priClass[i.priority] ?? ""}">${esc(i.priority)}</span>` : ""}
      ${i.status && i.status !== "Backlog" ? `<span class="st">${esc(i.status)}</span>` : ""}</span>
    <span class="card-title">${esc(i.title)}</span>
    <span class="card-meta">${i.assignees.length ? esc(i.assignees.join(", ")) : "unassigned"} · ${age}d old</span>
  </a>`;
};
const doneCard = (i) => `<a class="card done" href="${esc(i.url)}" target="_blank" rel="noopener">
  <span class="card-top"><span class="num">#${i.number}</span><span class="st st-done">Done ✓</span></span>
  <span class="card-title">${esc(i.title)}</span></a>`;

const ragCard = (r) => `<div class="rag rag-${r.level}">
  <div class="rag-head"><span class="rag-dot" aria-hidden="true"></span><strong>${esc(r.name)}</strong>
    <span class="rag-word">${r.level === "green" ? "On track" : r.level === "amber" ? "At risk" : "Blocked / urgent"}</span></div>
  <div class="rag-reason">${esc(r.reason)}</div>
  ${r.blocking.length ? `<div class="rag-links">${r.blocking.map((b) => `<a href="${esc(b.url)}" target="_blank" rel="noopener">#${b.number}</a>`).join(" ")}</div>` : ""}
</div>`;

const kpi = (value, label, sub = "", cls = "") => `<div class="kpi ${cls}"><div class="kpi-v">${esc(value)}</div><div class="kpi-l">${esc(label)}</div>${sub ? `<div class="kpi-s">${esc(sub)}</div>` : ""}</div>`;

const wsRows = [...content.workstreams.map((w) => ({ label: w.name, value: (wsBuckets.get(w.key) ?? []).length })),
  { label: "Other", value: wsBuckets.get("other").length }].filter((r) => r.value > 0);
const priRows = ["Urgent", "High", "Medium", "Low"].map((p) => ({ label: p, value: open.filter((i) => i.priority === p).length }));

const dataTable = (headers, rows) =>
  `<details class="dtbl"><summary>View the data</summary><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></details>`;

const sevBadge = { critical: ["Critical", "sev-critical"], serious: ["Serious", "sev-serious"], warning: ["Watch", "sev-warning"] };

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const html = `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VoxTable Mission Control</title>
<style>
:root{
  color-scheme:light;
  --ink-0:#faf9f6; --ink-1:#ffffff; --ink-2:#f2f0e9; --ink-3:#e9e6dc;
  --white:#14161a; --text:#333a44; --mist:#5f6774; --mist-2:#4a515c;
  --gold:#7d6104; --gold-dark:#644e03;
  --gold-fill:#f5c418; --gold-fill-text:#1a0f04;
  --line:rgba(20,22,26,.10); --line-strong:rgba(20,22,26,.22);
  --line-gold:rgba(125,97,4,.30);
  --danger:#b3261e; --success:#1a7a4a; --amber:#8a5a00;
  --fill-subtle:rgba(20,22,26,.04);
  --chart-1:#96700a; --chart-2:#0e7a5c;
  --rag-green:#e7f2ea; --rag-amber:#f6ecd9; --rag-red:#f8e4e2;
  --font-sans:"Inter Variable","Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  --font-mono:ui-monospace,"JetBrains Mono","SF Mono",Menlo,monospace;
  --r-sm:8px; --r-md:14px; --r-lg:24px; --r-pill:999px;
  --shadow-card:0 18px 50px -28px rgba(20,22,26,.25);
}
@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){
  color-scheme:dark;
  --ink-0:#0a0b0d; --ink-1:#111317; --ink-2:#161a20; --ink-3:#1d222a;
  --white:#f7f8fa; --text:#d5d9e0; --mist:#9aa1ad; --mist-2:#b8bec8;
  --gold:#f5c418; --gold-dark:#d9aa0e;
  --line:rgba(255,255,255,.08); --line-strong:rgba(255,255,255,.18);
  --line-gold:rgba(245,196,24,.18);
  --danger:#ff6b6b; --success:#6ee7a8; --amber:#ffb840;
  --fill-subtle:rgba(255,255,255,.04);
  --chart-1:#b58a09; --chart-2:#2b9d7a;
  --rag-green:rgba(110,231,168,.09); --rag-amber:rgba(255,184,64,.10); --rag-red:rgba(255,107,107,.10);
  --shadow-card:0 30px 80px -30px rgba(0,0,0,.7);
}}
:root[data-theme="dark"]{
  color-scheme:dark;
  --ink-0:#0a0b0d; --ink-1:#111317; --ink-2:#161a20; --ink-3:#1d222a;
  --white:#f7f8fa; --text:#d5d9e0; --mist:#9aa1ad; --mist-2:#b8bec8;
  --gold:#f5c418; --gold-dark:#d9aa0e;
  --line:rgba(255,255,255,.08); --line-strong:rgba(255,255,255,.18);
  --line-gold:rgba(245,196,24,.18);
  --danger:#ff6b6b; --success:#6ee7a8; --amber:#ffb840;
  --fill-subtle:rgba(255,255,255,.04);
  --chart-1:#b58a09; --chart-2:#2b9d7a;
  --rag-green:rgba(110,231,168,.09); --rag-amber:rgba(255,184,64,.10); --rag-red:rgba(255,107,107,.10);
  --shadow-card:0 30px 80px -30px rgba(0,0,0,.7);
}
*{box-sizing:border-box;margin:0}
body{background:var(--ink-0);color:var(--text);font-family:var(--font-sans);line-height:1.55;-webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto;padding:32px 20px 60px}
a{color:var(--gold);text-decoration:none} a:hover{text-decoration:underline}
h1{color:var(--white);font-size:clamp(26px,4vw,38px);letter-spacing:-.02em;line-height:1.1}
h2{color:var(--white);font-size:20px;margin:0 0 4px}
.sec{margin-top:44px}
.sec-sub{color:var(--mist);font-size:14px;margin-bottom:16px;max-width:70ch}
.panel{background:var(--ink-1);border:1px solid var(--line);border-radius:var(--r-md);padding:20px;box-shadow:var(--shadow-card)}
.hero{display:flex;flex-wrap:wrap;gap:18px;align-items:flex-end;justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:22px}
.brand{color:var(--mist);font-size:13px;letter-spacing:.14em;text-transform:uppercase;margin-bottom:6px}
.hero-right{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.pill{border-radius:var(--r-pill);padding:6px 14px;font-size:13px;font-weight:600;border:1px solid var(--line-strong)}
.pill.green{color:var(--success);border-color:var(--success)}
.pill.amber{color:var(--amber);border-color:var(--amber)}
.pill.red{color:var(--danger);border-color:var(--danger)}
.count{font-size:13px;color:var(--mist)}
.count strong{color:var(--white);font-size:16px}
.stamp{color:var(--mist);font-size:12px;margin-top:8px}
.theme-btn{background:var(--fill-subtle);border:1px solid var(--line);border-radius:var(--r-pill);color:var(--text);padding:5px 12px;font-size:12px;cursor:pointer}
.notice{margin-top:14px;border:1px solid var(--amber);color:var(--amber);border-radius:var(--r-sm);padding:8px 12px;font-size:13px}
.exec{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin-top:20px}
.exec .panel{border-left:3px solid var(--gold)}
.exec h3{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--mist);margin-bottom:6px}
.exec p{font-size:14px;color:var(--text)}
.rag-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.rag{border:1px solid var(--line);border-radius:var(--r-md);padding:14px 16px}
.rag-green_{}
.rag.rag-green{background:var(--rag-green)} .rag.rag-amber{background:var(--rag-amber)} .rag.rag-red{background:var(--rag-red)}
.rag-head{display:flex;gap:8px;align-items:center;color:var(--white)}
.rag-dot{width:10px;height:10px;border-radius:50%}
.rag-green .rag-dot{background:var(--success)} .rag-amber .rag-dot{background:var(--amber)} .rag-red .rag-dot{background:var(--danger)}
.rag-word{margin-left:auto;font-size:12px;font-weight:600}
.rag-green .rag-word{color:var(--success)} .rag-amber .rag-word{color:var(--amber)} .rag-red .rag-word{color:var(--danger)}
.rag-reason{font-size:13px;color:var(--mist-2);margin-top:6px}
.rag-links{margin-top:6px;font-size:13px}
.rag-links a{margin-right:8px;font-family:var(--font-mono)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.kpi{background:var(--ink-1);border:1px solid var(--line);border-radius:var(--r-md);padding:16px}
.kpi-v{color:var(--white);font-size:28px;font-weight:700;letter-spacing:-.02em}
.kpi-l{color:var(--mist);font-size:13px;margin-top:2px}
.kpi-s{color:var(--mist);font-size:12px;margin-top:4px}
.kpi.warn .kpi-v{color:var(--amber)}
.kpi.bad .kpi-v{color:var(--danger)}
.bar{height:6px;background:var(--fill-subtle);border-radius:var(--r-pill);margin-top:8px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--gold-fill);border-radius:var(--r-pill)}
.insight{font-size:14px;color:var(--text);border-left:3px solid var(--gold);padding-left:12px;margin:10px 0 14px}
.charts2{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
svg{width:100%;height:auto;display:block}
.c-grid{stroke:var(--line);stroke-width:1}
.c-lbl{fill:var(--mist);font-size:11px;font-family:var(--font-sans)}
.c-lbl-strong{fill:var(--text);font-weight:600}
.legend{display:flex;gap:16px;font-size:13px;color:var(--mist);margin-top:6px;flex-wrap:wrap}
.legend span{display:inline-flex;align-items:center;gap:6px}
.sw{width:14px;height:4px;border-radius:2px;display:inline-block}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}
.col h3{color:var(--white);font-size:15px;margin-bottom:2px}
.col .col-sub{color:var(--mist);font-size:12px;margin-bottom:10px}
.card{display:block;background:var(--ink-1);border:1px solid var(--line);border-radius:var(--r-sm);padding:10px 12px;margin-bottom:8px;color:var(--text)}
.card:hover{border-color:var(--line-gold);text-decoration:none}
.card-top{display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:11px}
.num{font-family:var(--font-mono);color:var(--mist)}
.type{border:1px solid var(--line-strong);border-radius:var(--r-pill);padding:1px 8px;color:var(--mist-2)}
.pri{border-radius:var(--r-pill);padding:1px 8px;font-weight:600}
.p-urgent{background:rgba(214,54,138,.15);color:#d6368a}
.p-high{background:rgba(207,58,49,.15);color:var(--danger)}
.p-medium{background:rgba(154,113,9,.18);color:var(--gold)}
.p-low{background:rgba(26,122,74,.15);color:var(--success)}
.st{color:var(--mist);border:1px dashed var(--line-strong);border-radius:var(--r-pill);padding:1px 8px}
.st-done{color:var(--success);border-color:var(--success)}
.card-title{display:block;font-size:13.5px;color:var(--white);margin-top:4px}
.card.done .card-title{color:var(--mist);text-decoration:line-through}
.card-meta{display:block;font-size:11.5px;color:var(--mist);margin-top:3px}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{color:var(--mist);text-align:left;font-weight:600;padding:8px 10px;border-bottom:1px solid var(--line-strong)}
td{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
.sev{border-radius:var(--r-pill);padding:2px 10px;font-size:12px;font-weight:600;white-space:nowrap}
.sev-critical{background:rgba(214,54,60,.15);color:var(--danger)}
.sev-serious{background:rgba(200,130,0,.15);color:var(--amber)}
.sev-warning{background:var(--fill-subtle);color:var(--mist-2)}
.tl{list-style:none;position:relative;padding-left:22px}
.tl::before{content:"";position:absolute;left:6px;top:6px;bottom:6px;width:2px;background:var(--line-strong)}
.tl li{position:relative;padding:0 0 18px 12px}
.tl li::before{content:"";position:absolute;left:-21px;top:6px;width:12px;height:12px;border-radius:50%;background:var(--gold-fill);border:2px solid var(--ink-0)}
.tl li.up::before{background:var(--ink-2);border:2px solid var(--gold)}
.tl .tld{font-size:12px;color:var(--mist);font-family:var(--font-mono)}
.tl .tlt{color:var(--white);font-weight:600}
.tl .tlx{font-size:13.5px;color:var(--mist-2)}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
.list{list-style:none}
.list li{padding:8px 0;border-bottom:1px solid var(--line);font-size:13.5px}
.list .d{color:var(--mist);font-family:var(--font-mono);font-size:12px;margin-right:8px}
.dec{border-left:3px solid var(--line-gold);padding:6px 0 6px 14px;margin-bottom:12px}
.dec .tlt{color:var(--white);font-weight:600;font-size:14px}
.dec .why{font-size:13.5px;color:var(--mist-2)}
.dtbl{margin-top:8px}
.dtbl summary{font-size:12px;color:var(--mist);cursor:pointer}
.footer{margin-top:48px;border-top:1px solid var(--line);padding-top:20px;font-size:13px;color:var(--mist)}
.footer code{font-family:var(--font-mono);background:var(--fill-subtle);padding:1px 6px;border-radius:4px}
.gloss dt{color:var(--text);font-weight:600;display:inline}
.gloss dd{display:inline;margin:0 0 0 4px}
.gloss div{margin-top:4px}
#tip{position:fixed;pointer-events:none;background:var(--ink-3);color:var(--white);border:1px solid var(--line-strong);border-radius:var(--r-sm);padding:5px 10px;font-size:12.5px;opacity:0;transition:opacity .12s;z-index:10;max-width:280px}
@media (max-width:640px){ .hero{align-items:flex-start;flex-direction:column} }
</style>
</head>
<body>
<div class="wrap">

<header class="hero">
  <div>
    <div class="brand">BitePerk · VoxTable</div>
    <h1>Mission Control</h1>
    <div class="stamp">Generated ${esc(generatedAt)} (Sydney) · data pulled live from GitHub at generation time</div>
  </div>
  <div class="hero-right">
    <span class="pill ${overall.cls}">${esc(overall.label)}</span>
    <span class="count"><strong>${daysToTarget >= 0 ? daysToTarget : 0}</strong> days to go-live target (${esc(fmtDate(TARGET))})</span>
    <button class="theme-btn" id="themeBtn" type="button">Theme</button>
  </div>
</header>

${warnings.length ? `<div class="notice">Partial data: could not fetch ${esc([...new Set(warnings)].join(", "))} — the affected sections render from what was available.</div>` : ""}

<section class="sec" aria-label="Executive summary">
  <h2>If you read nothing else</h2>
  <div class="exec">
    <div class="panel"><h3>Biggest win</h3><p>${esc(content.executive_summary_curated.win)}</p></div>
    <div class="panel"><h3>Biggest risk</h3><p>${esc(content.executive_summary_curated.risk)} <span class="count">(${urgentOpen.length} urgent, ${highOpen.length} high open right now)</span></p></div>
    <div class="panel"><h3>Decision needed</h3><p>${esc(content.executive_summary_curated.decision_needed)}</p></div>
  </div>
</section>

<section class="sec" aria-label="Launch readiness">
  <h2>Launch readiness — ${esc(MILESTONE_TITLE)}</h2>
  <p class="sec-sub">Each workstream's light is derived from the open issues mapped to it (red = an urgent item is open, amber = high-priority work remains before go-live, green = nothing urgent). It cannot quietly disagree with the tracker.</p>
  <div class="rag-grid">${rag.map(ragCard).join("")}</div>
</section>

<section class="sec" aria-label="Key numbers">
  <h2>The numbers</h2>
  <div class="kpis">
    <div class="kpi"><div class="kpi-v">${msClosed.length}/${milestoneIssues.length}</div><div class="kpi-l">milestone issues done</div><div class="bar"><i style="width:${milestoneIssues.length ? Math.round((msClosed.length / milestoneIssues.length) * 100) : 0}%"></i></div></div>
    ${kpi(`${doneThisIter.length + nowCol.filter((i) => i.status === "Done").length ? doneThisIter.length : doneThisIter.length}/${nowCol.length + doneThisIter.length}`, `done this iteration`, currentIter ? `${currentIter.title} · ends ${fmtDate(currentIter.end)}` : "")}
    ${kpi(urgentOpen.length, "urgent issues open", oldestUrgent !== null ? `oldest is ${oldestUrgent}d old` : "", urgentOpen.length ? "bad" : "")}
    ${kpi(wip, "in progress (WIP)", wip > 3 ? "over the limit of 3 — finish before starting" : "healthy: finish before starting", wip > 3 ? "warn" : "")}
    ${kpi(mergedPRs.length, "PRs merged all-time", "every merge auto-deploys staging")}
    ${kpi("2", "venues", "Natalia's Bistro live · Cuban Corner staging")}
  </div>
</section>

<section class="sec" aria-label="Burn-up and projection">
  <h2>Where we're heading</h2>
  <p class="insight">${esc(burnInsight)}</p>
  <div class="panel">
    ${burnupSVG()}
    <div class="legend">
      <span><span class="sw" style="background:var(--chart-2)"></span>Scope (issues on the milestone)</span>
      <span><span class="sw" style="background:var(--chart-1)"></span>Done</span>
      <span><span class="sw" style="background:var(--chart-1);height:0;border-top:2px dashed var(--chart-1)"></span>Projection at current pace</span>
    </div>
    <p class="sec-sub" style="margin-top:8px">Scope counts an issue from its creation date — a rising green line means scope was added, not lost progress. Weekend dips are normal.</p>
    ${dataTable(["Date", "Scope", "Done"], burnDays.filter((_, i) => i % 3 === 0).map((d, k) => [fmtDate(d), scopeSeries[k * 3], doneSeries[k * 3] ?? "—"]))}
  </div>
</section>

<section class="sec" aria-label="Delivery flow">
  <h2>Delivery flow</h2>
  <p class="insight">${weekly[7].issuesClosed + weekly[7].prsMerged === 0 ? "Nothing has landed yet this week." : `This week so far: ${weekly[7].issuesClosed} issues closed, ${weekly[7].prsMerged} PRs merged.`} Median time from opening an issue to closing it (last 30 days): ${cycleMedian !== null ? `${cycleMedian < 1 ? "under a day" : Math.round(cycleMedian) + " days"}` : "no closures in the window"}.</p>
  <div class="charts2">
    <div class="panel"><h3 style="color:var(--white);font-size:14px">Issues closed / week</h3>${weeklyBarsSVG("issuesClosed", "Issues closed")}</div>
    <div class="panel"><h3 style="color:var(--white);font-size:14px">PRs merged / week <span class="count">(= staging deploys)</span></h3>${weeklyBarsSVG("prsMerged", "PRs merged")}</div>
    <div class="panel"><h3 style="color:var(--white);font-size:14px">Open work by workstream</h3>${hBarsSVG(wsRows, "Open issues by workstream")}</div>
    <div class="panel"><h3 style="color:var(--white);font-size:14px">Open work by priority</h3>${hBarsSVG(priRows, "Open issues by priority")}</div>
  </div>
</section>

<section class="sec" aria-label="Now, next, later">
  <h2>Now / Next / Later</h2>
  <p class="sec-sub">Live from the <a href="${esc(content.links.board)}" target="_blank" rel="noopener">Voxtable board</a>. Cards link to the issue.</p>
  <div class="cols">
    <div class="col">
      <h3>Now — ${esc(currentIter?.title ?? "current")}</h3>
      <div class="col-sub">${currentIter ? `${fmtDate(currentIter.start)} – ${fmtDate(currentIter.end)}` : ""} · ${nowCol.length} open, ${doneThisIter.length} done</div>
      ${nowCol.map(card).join("")}${doneThisIter.map(doneCard).join("")}
    </div>
    <div class="col">
      <h3>Next — ${esc(nextIter?.title ?? "next")}</h3>
      <div class="col-sub">${nextIter ? `${fmtDate(nextIter.start)} – ${fmtDate(nextIter.end)} · includes the go-live date` : ""} · ${nextCol.length} queued</div>
      ${nextCol.map(card).join("")}
    </div>
    <div class="col">
      <h3>Later — prioritized backlog</h3>
      <div class="col-sub">${laterCol.length} items, highest priority first</div>
      ${laterCol
        .sort((a, b) => (["Urgent", "High", "Medium", "Low", null].indexOf(a.priority)) - (["Urgent", "High", "Medium", "Low", null].indexOf(b.priority)))
        .slice(0, 12).map(card).join("")}
      ${laterCol.length > 12 ? `<div class="col-sub"><a href="${esc(content.links.board)}" target="_blank" rel="noopener">+ ${laterCol.length - 12} more on the board →</a></div>` : ""}
    </div>
  </div>
</section>

<section class="sec" aria-label="Risk register">
  <h2>Risk register</h2>
  <p class="sec-sub">Worst first. Rows marked with an issue number are pulled automatically from open urgent/high items — they disappear from here the moment the issue closes.</p>
  <div class="panel" style="padding:6px 16px;overflow-x:auto">
  <table>
    <thead><tr><th>Severity</th><th>Risk</th><th>Owner</th><th>Mitigation</th></tr></thead>
    <tbody>
    ${risks.map((r) => `<tr>
      <td><span class="sev ${sevBadge[r.severity][1]}">${sevBadge[r.severity][0]}</span></td>
      <td>${esc(r.risk)}</td>
      <td>${esc(r.owner)}</td>
      <td>${r.link ? `<a href="${esc(r.link)}" target="_blank" rel="noopener">${r.number ? `#${r.number}` : "view"}</a>` : "—"}</td>
    </tr>`).join("")}
    </tbody>
  </table>
  </div>
</section>

<section class="sec" aria-label="Decision log">
  <h2>Decision log</h2>
  <p class="sec-sub">Why things are the way they are — recorded so nobody re-litigates them by accident. Full history lives in PR reviews and CLAUDE.md.</p>
  ${content.decisions.map((d) => `<div class="dec"><span class="tld">${esc(d.date)}</span> <span class="tlt">${esc(d.title)}</span><div class="why">${esc(d.rationale)}</div></div>`).join("")}
</section>

<section class="sec" aria-label="Names and environments">
  <h2>Names &amp; environments</h2>
  <p class="sec-sub">What everything is called — new names vs the legacy ones still serving. The registry of record is <a href="${esc(content.links.repo)}/blob/integration/NAMES.md" target="_blank" rel="noopener">NAMES.md</a>; when this section and NAMES.md disagree, NAMES.md wins.</p>
  <div class="panel" style="padding:6px 16px;overflow-x:auto;margin-bottom:14px">
  <table>
    <thead><tr><th>Surface</th><th>New name</th><th>Old name(s) — still serving</th><th>Status</th></tr></thead>
    <tbody>
    ${(content.naming?.hostnames ?? []).map((h) => `<tr>
      <td>${esc(h.surface)}</td>
      <td><code>${esc(h.new)}</code></td>
      <td>${esc(h.old)}</td>
      <td>${esc(h.status)}</td>
    </tr>`).join("")}
    </tbody>
  </table>
  </div>
  <div class="panel" style="padding:6px 16px;overflow-x:auto;margin-bottom:14px">
  <table>
    <thead><tr><th>Infrastructure</th><th>Name</th></tr></thead>
    <tbody>
    ${(content.naming?.infrastructure ?? []).map((i) => `<tr>
      <td>${esc(i.thing)}</td>
      <td><code>${esc(i.name)}</code></td>
    </tr>`).join("")}
    </tbody>
  </table>
  </div>
  <p class="sec-sub" style="margin-bottom:4px"><strong style="color:var(--text)">Deliberately NOT changing — do not "fix" these:</strong></p>
  <ul class="list">
    ${(content.naming?.never_rename ?? []).map((n) => `<li>${esc(n)}</li>`).join("")}
  </ul>
</section>

<section class="sec" aria-label="Journey">
  <h2>The journey</h2>
  <ul class="tl">
    ${content.journey.map((j) => `<li${j.upcoming ? ' class="up"' : ""}><div class="tld">${esc(j.date)}${j.upcoming ? " · upcoming" : ""}</div><div class="tlt">${esc(j.title)}</div><div class="tlx">${esc(j.detail)}</div></li>`).join("")}
  </ul>
</section>

<section class="sec" aria-label="Recently shipped and ideas">
  <div class="two">
    <div>
      <h2>Recently shipped</h2>
      <ul class="list">
        ${recentShippedPRs.map((p) => `<li><span class="d">${esc(fmtDate(p.mergedAt))}</span><a href="${esc(p.url)}" target="_blank" rel="noopener">#${p.number}</a> ${esc(p.title)}</li>`).join("")}
        ${recentClosedIssues.map((i) => `<li><span class="d">${esc(fmtDate(i.closedAt))}</span><a href="${esc(i.url)}" target="_blank" rel="noopener">#${i.number}</a> ${esc(i.title)} <span class="count">closed</span></li>`).join("")}
      </ul>
    </div>
    <div>
      <h2>Ideas parking lot</h2>
      <p class="sec-sub">Ideas live here until they graduate into issues — only then do they show up in the metrics above.</p>
      <ul class="list">
        ${content.ideas.map((i) => `<li>${esc(i.idea)} <span class="count">· ${esc(i.status)}</span></li>`).join("")}
      </ul>
    </div>
  </div>
</section>

<footer class="footer">
  <p><strong style="color:var(--text)">Updating this dashboard:</strong> run <code>npm run dashboard</code> — every number is re-pulled from GitHub. The narrative (journey, decisions, ideas, risk notes) lives in <code>scripts/dashboard-content.json</code>; edit and re-run.</p>
  <dl class="gloss">
    <div><dt>RAG</dt><dd>— red / amber / green status lights.</dd></div>
    <div><dt>WIP</dt><dd>— work in progress; keeping it low means things finish instead of piling up half-done.</dd></div>
    <div><dt>Cycle time</dt><dd>— how long an issue stays open; shorter means faster feedback.</dd></div>
    <div><dt>Burn-up</dt><dd>— done-work climbing toward total scope; where the lines meet is the finish.</dd></div>
  </dl>
  <p style="margin-top:10px"><a href="${esc(content.links.board)}" target="_blank" rel="noopener">Project board</a> · <a href="${esc(content.links.milestone)}" target="_blank" rel="noopener">Go-live milestone</a> · <a href="${esc(content.links.repo)}" target="_blank" rel="noopener">Repository</a></p>
</footer>

</div>
<div id="tip" role="status"></div>
<script>
(function(){
  var btn=document.getElementById("themeBtn"),root=document.documentElement;
  btn.addEventListener("click",function(){
    var dark=matchMedia("(prefers-color-scheme: dark)").matches;
    var cur=root.getAttribute("data-theme")||(dark?"dark":"light");
    root.setAttribute("data-theme",cur==="dark"?"light":"dark");
  });
  var tip=document.getElementById("tip");
  document.addEventListener("mousemove",function(e){
    var t=e.target.closest("[data-tip]");
    if(t){tip.textContent=t.getAttribute("data-tip");tip.style.opacity=1;
      tip.style.left=Math.min(e.clientX+14,innerWidth-300)+"px";tip.style.top=(e.clientY+16)+"px";}
    else tip.style.opacity=0;
  });
})();
</script>
</body>
</html>
`;

writeFileSync(OUT, html);
console.log(`Wrote ${OUT}`);
console.log(`  issues: ${issues.length} (${open.length} open) · milestone: ${msClosed.length}/${milestoneIssues.length} done · board items: ${board.size}`);
if (warnings.length) console.log(`  PARTIAL DATA — failed: ${[...new Set(warnings)].join(", ")}`);
