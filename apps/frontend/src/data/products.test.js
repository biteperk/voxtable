/**
 * The registry is display-only. These assertions are the thing standing between
 * a UI list and the contract layer.
 *
 * AGREEMENT_SERVICES (apps/backend/src/http/schemas.ts) is the ONLY enforcement
 * that VoxDrive can never be sold — there is no DB CHECK on
 * restaurants.services. If someone ever wires this registry into the agreement
 * step, or adds `sellable: true` to a concept product, that guarantee is gone
 * silently. These tests make it loud.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { PRODUCTS, ownedProducts, unownedProducts } from "./products.js";

const here = dirname(fileURLToPath(import.meta.url));
const schemasPath = resolve(here, "../../../backend/src/http/schemas.ts");

/** Read the backend's enum from source rather than importing TS into a JS test. */
function agreementServices() {
  const src = readFileSync(schemasPath, "utf8");
  const m = src.match(/AGREEMENT_SERVICES\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, "AGREEMENT_SERVICES not found — did schemas.ts move?");
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

test("every sellable product exists in the backend's contract enum", () => {
  const sellable = agreementServices();
  for (const p of PRODUCTS.filter((x) => x.sellable)) {
    assert.ok(
      sellable.includes(p.id),
      `${p.id} is marked sellable in the registry but is not in AGREEMENT_SERVICES. ` +
        `Either it is not actually contractable, or the enum needs a deliberate change.`
    );
  }
});

test("VoxDrive and VoxStay are never contractable", () => {
  const sellable = agreementServices();
  // VoxDrive: NAMES.md says concept only, never in a services enum.
  // VoxStay: shown for the hotel segment, but there is nothing to contract yet.
  assert.equal(sellable.includes("voxdrive"), false);
  assert.equal(sellable.includes("voxstay"), false);
  assert.equal(PRODUCTS.find((p) => p.id === "voxdrive").sellable, false);
  assert.equal(PRODUCTS.find((p) => p.id === "voxstay").sellable, false);
});

test("a concept product can never be marked sellable", () => {
  for (const p of PRODUCTS.filter((x) => x.status === "concept")) {
    assert.equal(p.sellable, false, `${p.id} is a concept and must not be sellable`);
  }
});

test("owned and unowned partition the registry exactly", () => {
  const services = ["voxtable", "voxorder"];
  const owned = ownedProducts(services);
  const unowned = unownedProducts(services);
  assert.equal(owned.length + unowned.length, PRODUCTS.length);
  assert.deepEqual(owned.map((p) => p.id), ["voxtable", "voxorder"]);
  // A venue with nothing contracted still sees the whole family.
  assert.equal(ownedProducts([]).length, 0);
  assert.equal(unownedProducts([]).length, PRODUCTS.length);
});

test("product names match NAMES.md exactly", () => {
  const canonical = {
    voxtable: "VoxTable",
    voxorder: "VoxOrder",
    voxconcierge: "VoxConcierge",
    voxstay: "VoxStay",
    voxdrive: "VoxDrive"
  };
  for (const p of PRODUCTS) {
    assert.equal(p.name, canonical[p.id], `${p.id} name drifted from NAMES.md`);
  }
});
