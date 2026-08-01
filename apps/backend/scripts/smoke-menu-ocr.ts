/**
 * Menu OCR accuracy against a corpus of real menus.
 *
 * Unit tests prove the plumbing: that a missed page is DETECTED and reported.
 * They cannot prove the model actually reads the page — only real calls against
 * real menus can. This is that check.
 *
 * It exists because of one import: 59 of 65 items, page 3 silently empty, and
 * the owner told "everything looked clear". That menu is now fixture #1, and
 * this script fails if it ever happens again.
 *
 *   npm run smoke:menu-ocr                       # whole corpus
 *   npm run smoke:menu-ocr -- --menu=<slug>      # one menu
 *   npm run smoke:menu-ocr -- --json             # machine-readable
 *
 * NOT part of `npm run check`: it costs money and needs a provider key.
 * Requires MENU_OCR_API_KEY (+ PROVIDER/BASE_URL/MODEL) in your .env — copy the
 * MENU_OCR_* lines from the production env if you don't have your own key.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { parseMenuPages, type FetchedFile } from "../src/services/menuOcrClient";
import { env } from "../src/config/env";
import type { PageResult } from "../src/services/menuPageAccounting";

const FIXTURE_ROOT = path.resolve(__dirname, "../fixtures/menus");

interface ExpectedPage {
  page: number;
  kind: string;
  min_items: number | null;
  note?: string;
}
interface ExpectedDish {
  name: string;
  price_cents: number;
  page?: number;
}
interface Expected {
  slug: string;
  source: string;
  source_kind: "image" | "pdf";
  pages: ExpectedPage[];
  must_include: ExpectedDish[];
  totals: { min_items: number | null; max_items: number | null; min_categories?: number };
}

/** Loose on wording, exact on money. A price is what Bella reads aloud. */
function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function namesMatch(expected: string, actual: string): boolean {
  const a = normaliseName(expected);
  const b = normaliseName(actual);
  return a === b || a.includes(b) || b.includes(a);
}

function mediaTypeFor(file: string): string {
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".webp")) return "image/webp";
  if (file.endsWith(".pdf")) return "application/pdf";
  return "image/jpeg";
}

function loadFixture(slug: string): { expected: Expected; pageFiles: string[] } {
  const dir = path.join(FIXTURE_ROOT, slug);
  const expected = JSON.parse(readFileSync(path.join(dir, "expected.json"), "utf8")) as Expected;
  const pagesDir = path.join(dir, "pages");
  const pageFiles = readdirSync(pagesDir)
    .filter((f) => !f.startsWith("."))
    .sort()
    .map((f) => path.join(pagesDir, f));

  // A fixture whose expectations were never filled in would certify whatever
  // the model happens to do today — which is how a corpus becomes a machine for
  // blessing the bug it was built to catch.
  const unfilled = expected.pages.some((p) => p.min_items === null) || expected.totals.min_items === null;
  if (unfilled) {
    throw new Error(
      `${slug}: expected.json still has null expectations. Fill them in by reading the printed menu — not by copying parser output.`
    );
  }
  if (pageFiles.length !== expected.pages.length) {
    throw new Error(`${slug}: ${pageFiles.length} page images but ${expected.pages.length} pages in expected.json`);
  }
  return { expected, pageFiles };
}

interface Failure {
  kind: string;
  detail: string;
}

interface MenuReport {
  slug: string;
  ok: boolean;
  items: number;
  categories: number;
  pageResults: PageResult[];
  accounted: string;
  dishesFound: number;
  dishesTotal: number;
  pricesExact: number;
  confidences: number[];
  failures: Failure[];
  elapsedMs: number;
}

async function runMenu(slug: string): Promise<MenuReport> {
  const { expected, pageFiles } = loadFixture(slug);
  const failures: Failure[] = [];
  const startedAt = Date.now();

  const loadPage = async (page: number): Promise<FetchedFile> => {
    const file = pageFiles[page - 1]!;
    return { base64: readFileSync(file).toString("base64"), mediaType: mediaTypeFor(file) };
  };

  const result = await parseMenuPages({
    totalPages: pageFiles.length,
    loadPage,
    sourceKind: expected.source_kind
  });

  const allItems = result.draft.categories.flatMap((c) => c.items.map((i) => ({ category: c.name, ...i })));
  const itemCount = allItems.length;

  // 1. No page that should have items came back empty. THE assertion.
  for (const page of expected.pages) {
    const actual = result.pageResults.find((p) => p.page === page.page);
    const min = page.min_items ?? 0;
    if (min > 0 && (actual?.items ?? 0) === 0) {
      failures.push({
        kind: "empty_page",
        detail: `page ${page.page} produced 0 items, expected at least ${min}${page.note ? ` — ${page.note}` : ""}`
      });
    } else if ((actual?.items ?? 0) < min) {
      failures.push({
        kind: "short_page",
        detail: `page ${page.page} produced ${actual?.items ?? 0} items, expected at least ${min}`
      });
    }
  }

  // 2. Named dishes present, at exactly the printed price.
  let dishesFound = 0;
  let pricesExact = 0;
  for (const dish of expected.must_include) {
    const matches = allItems.filter((i) => namesMatch(dish.name, i.name));
    if (matches.length === 0) {
      failures.push({ kind: "missing_dish", detail: `"${dish.name}" not found (page ${dish.page ?? "?"})` });
      continue;
    }
    dishesFound += 1;
    if (matches.some((m) => m.price_cents === dish.price_cents)) {
      pricesExact += 1;
    } else {
      failures.push({
        kind: "wrong_price",
        detail: `"${dish.name}" expected ${dish.price_cents}c, got ${matches.map((m) => m.price_cents).join("/")}c`
      });
    }
  }

  // 3. Totals — a floor AND a ceiling. Over-extraction is also a wrong menu.
  const { min_items: minItems, max_items: maxItems, min_categories: minCategories } = expected.totals;
  if (minItems !== null && itemCount < minItems) {
    failures.push({ kind: "too_few", detail: `${itemCount} items, floor is ${minItems}` });
  }
  if (maxItems !== null && itemCount > maxItems) {
    failures.push({ kind: "too_many", detail: `${itemCount} items, ceiling is ${maxItems} — invented rows?` });
  }
  if (minCategories && result.draft.categories.length < minCategories) {
    failures.push({
      kind: "too_few_categories",
      detail: `${result.draft.categories.length} categories, floor is ${minCategories}`
    });
  }

  // 4. Page accounting is complete and internally consistent.
  if (result.pageResults.length !== pageFiles.length) {
    failures.push({
      kind: "incomplete_report",
      detail: `${result.pageResults.length} page results for ${pageFiles.length} pages`
    });
  }
  const unaccounted = result.pageResults.filter((p) => p.status === "unread" || p.status === "unverified");
  if (unaccounted.length > 0) {
    failures.push({
      kind: "unaccounted",
      detail: `pages ${unaccounted.map((p) => p.page).join(", ")} could not be accounted for`
    });
  }

  // 5. A $0 dish is worse than a missing one — Bella says it's free.
  const freeDishes = allItems.filter((i) => i.price_cents === 0);
  if (freeDishes.length > 0) {
    failures.push({
      kind: "zero_price",
      detail: `${freeDishes.length} item(s) priced at $0: ${freeDishes.map((i) => i.name).slice(0, 3).join(", ")}`
    });
  }

  const accountedCount = result.pageResults.filter((p) => p.status !== "unread" && p.status !== "unverified").length;

  return {
    slug,
    ok: failures.length === 0,
    items: itemCount,
    categories: result.draft.categories.length,
    pageResults: result.pageResults,
    accounted: `${accountedCount}/${pageFiles.length}`,
    dishesFound,
    dishesTotal: expected.must_include.length,
    pricesExact,
    confidences: allItems.map((i) => i.confidence).filter((c): c is number => typeof c === "number"),
    failures,
    elapsedMs: Date.now() - startedAt
  };
}

function fmt(report: MenuReport): string {
  const conf = report.confidences.length
    ? `${Math.min(...report.confidences).toFixed(2)}–${Math.max(...report.confidences).toFixed(2)}`
    : "none";
  const head =
    `${report.ok ? "PASS" : "FAIL"}  ${report.slug.padEnd(26)} ` +
    `pages ${report.accounted.padEnd(6)} items ${String(report.items).padEnd(5)} ` +
    `dishes ${report.dishesFound}/${report.dishesTotal}  prices ${report.pricesExact}/${report.dishesTotal}  ` +
    `conf ${conf}  ${(report.elapsedMs / 1000).toFixed(1)}s`;
  const detail = report.pageResults
    .map((p) => `      page ${p.page}: ${p.status}, ${p.items} items${p.note ? ` (${p.note})` : ""}`)
    .join("\n");
  const fails = report.failures.map((f) => `  ✗ ${f.kind}: ${f.detail}`).join("\n");
  return [head, detail, fails].filter(Boolean).join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const only = args.find((a) => a.startsWith("--menu="))?.split("=")[1];
  const asJson = args.includes("--json");

  if (!env.MENU_OCR_API_KEY) {
    console.error(
      "MENU_OCR_API_KEY is not set. This script makes real vision calls.\n" +
        "Copy the MENU_OCR_* lines from the production env into your .env, or use your own key."
    );
    process.exit(2);
  }

  const slugs = (only ? [only] : readdirSync(FIXTURE_ROOT))
    .filter((s) => !s.startsWith(".") && statSync(path.join(FIXTURE_ROOT, s)).isDirectory())
    .sort();

  if (slugs.length === 0) {
    console.error(`No fixtures under ${FIXTURE_ROOT}`);
    process.exit(2);
  }

  console.error(`Reading ${slugs.length} menu(s) with ${env.MENU_OCR_MODEL} (verify: ${env.MENU_OCR_VERIFY_MODEL || env.MENU_OCR_MODEL})\n`);

  const reports: MenuReport[] = [];
  for (const slug of slugs) {
    try {
      const report = await runMenu(slug);
      reports.push(report);
      if (!asJson) console.log(fmt(report), "\n");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      reports.push({
        slug,
        ok: false,
        items: 0,
        categories: 0,
        pageResults: [],
        accounted: "0/0",
        dishesFound: 0,
        dishesTotal: 0,
        pricesExact: 0,
        confidences: [],
        failures: [{ kind: "threw", detail }],
        elapsedMs: 0
      });
      if (!asJson) console.log(`FAIL  ${slug}\n  ✗ threw: ${detail}\n`);
    }
  }

  if (asJson) {
    console.log(JSON.stringify(reports, null, 2));
  } else {
    const passed = reports.filter((r) => r.ok).length;
    const dishes = reports.reduce((n, r) => n + r.dishesFound, 0);
    const dishesTotal = reports.reduce((n, r) => n + r.dishesTotal, 0);
    const prices = reports.reduce((n, r) => n + r.pricesExact, 0);
    console.log("─".repeat(78));
    console.log(`corpus  ${passed}/${reports.length} menus · ${dishes}/${dishesTotal} dishes · ${prices}/${dishesTotal} prices exact`);

    // The check that costs nothing and would have caught "every row reported
    // 1.0" — a constant confidence means the low-confidence flag is decoration.
    const all = reports.flatMap((r) => r.confidences);
    if (all.length > 0 && new Set(all).size === 1) {
      console.log(`⚠ every item in the corpus reported confidence ${all[0]} — that signal is inert`);
    }
  }

  process.exit(reports.every((r) => r.ok) ? 0 : 1);
}

void main();
