// assert-seed-identities.mjs --project <firebase-project> [--sibling <other-project>] <seed.sql...>
//
// Asserts that every Firebase UID hardcoded in a seed file belongs to the Firebase project
// the seed is applied to, and exits non-zero if any does not.
//
// It exists because of 26 Aug 2026. deploy/seeds/staging-venue.sql granted ownership of the
// staging venue to fBufe7XgkBYDDoQGXZj4aQ50c4T2 — Sam's PRODUCTION Firebase UID, pasted into
// a staging seed. It had been there since 18 Aug and nothing noticed, because:
//
//   - a UID is an opaque, environment-scoped string with no visible environment marker.
//     fBufe7XgkBYDDoQGXZj4aQ50c4T2 and Uzpcoc8JGkUFWIHP1Tg3jQBFnpg2 are indistinguishable
//     to a reviewer, and sit next to identifiers (a UUID, a +61 number) that DO look checkable.
//   - the seed's other UID — the machine smoke user — happened to be right, because
//     smoke:staging exercises it and would have gone red. The human row was exercised by
//     nothing until a human tried to log in.
//   - re-applying the seed reports "0 rows inserted", which proves idempotency, not
//     correctness: ON CONFLICT DO NOTHING is just as quiet about a wrong UID as a right one.
//
// This is CLAUDE.md §D rule 2 ("after copying config between environments, assert the other
// environment's identifiers appear nowhere in the result") enforced instead of remembered.
//
// The long-term fix is for seeds to stop writing UIDs down at all — resolve email→uid inside
// the target environment, the way apps/backend/src/db/seed.ts already does. This check should
// keep running afterwards: it costs one API call and it is what stops the pattern being
// reintroduced by the next person who copies a seed between environments.
//
// Auth: a GCP access token with firebaseauth.users.get on the project(s). Taken from
// GCP_ACCESS_TOKEN if set, else `gcloud auth print-access-token`. No dependencies.
//
//   node deploy/scripts/assert-seed-identities.mjs \
//     --project bp-voxtable-stg --sibling vocotable deploy/seeds/staging-venue.sql

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const project = flagValue("--project");
const sibling = flagValue("--sibling");
const files = args.filter((a) => a.endsWith(".sql"));

if (!project || files.length === 0) {
  console.error("usage: node assert-seed-identities.mjs --project <firebase-project> [--sibling <other>] <seed.sql...>");
  process.exit(2);
}

const results = [];
const check = (id, ok, label, detail) => {
  results.push({ id, state: ok ? "pass" : "fail", label, detail });
  if (!asJson) console.log(`${ok ? "✓" : "✗"} [${id}] ${label}${detail && !ok ? `\n     ${detail}` : ""}`);
  return ok;
};

function accessToken() {
  if (process.env.GCP_ACCESS_TOKEN) return process.env.GCP_ACCESS_TOKEN;
  try {
    return execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" }).trim();
  } catch {
    console.error("No GCP credential. Set GCP_ACCESS_TOKEN or authenticate gcloud.");
    process.exit(2);
  }
}

/**
 * Extract the Firebase UIDs a seed binds identities to.
 *
 * Parsed by COLUMN POSITION, not by scanning the file for UID-shaped strings: seeds are full
 * of other opaque literals (restaurant UUIDs, Retell agent ids, Twilio SIDs) and a greedy
 * regex would report those as missing Firebase users forever, which is how a check becomes
 * something people mute.
 *
 * Handles the two shapes our seeds use:
 *   INSERT INTO users (id, email, ...) VALUES ('<uid>', '<email>', ...)
 *   INSERT INTO restaurant_members (user_id, restaurant_id, role) VALUES ('<uid>', ...)
 */
export function extractSeedIdentities(sql, fileLabel = "<sql>") {
  const found = new Map(); // uid -> { uid, email, sites: [] }
  const lines = sql.split("\n");

  const record = (uid, email, lineNo, column) => {
    const entry = found.get(uid) ?? { uid, email: null, sites: [] };
    if (email && !entry.email) entry.email = email;
    entry.sites.push(`${fileLabel}:${lineNo} ${column}`);
    found.set(uid, entry);
  };

  // Statements can wrap across lines, so walk statement-by-statement but keep a line number.
  const statements = [];
  let buffer = "";
  let startLine = 1;
  lines.forEach((line, i) => {
    if (buffer === "") startLine = i + 1;
    buffer += line + "\n";
    if (line.includes(";")) {
      statements.push({ text: buffer, line: startLine });
      buffer = "";
    }
  });
  if (buffer.trim()) statements.push({ text: buffer, line: startLine });

  for (const { text, line } of statements) {
    const usersMatch = /INSERT\s+INTO\s+users\s*\(([^)]*)\)\s*VALUES\s*(.+)/is.exec(text);
    if (usersMatch) {
      const cols = usersMatch[1].split(",").map((c) => c.trim().toLowerCase());
      const idIdx = cols.indexOf("id");
      const emailIdx = cols.indexOf("email");
      for (const tuple of usersMatch[2].matchAll(/\(([^()]*)\)/g)) {
        const vals = splitTuple(tuple[1]);
        const uid = unquote(vals[idIdx]);
        const email = emailIdx >= 0 ? unquote(vals[emailIdx]) : null;
        if (uid) record(uid, email, line, "users.id");
      }
      continue;
    }

    const memberMatch = /INSERT\s+INTO\s+restaurant_members\s*\(([^)]*)\)\s*VALUES\s*(.+)/is.exec(text);
    if (memberMatch) {
      const cols = memberMatch[1].split(",").map((c) => c.trim().toLowerCase());
      const uidIdx = cols.indexOf("user_id");
      for (const tuple of memberMatch[2].matchAll(/\(([^()]*)\)/g)) {
        const vals = splitTuple(tuple[1]);
        const uid = unquote(vals[uidIdx]);
        if (uid) record(uid, null, line, "restaurant_members.user_id");
      }
    }
  }

  // A Firebase UID is 20-36 chars of [A-Za-z0-9]; a UUID (with dashes) is not one, and that
  // is the discriminator that keeps restaurant ids out of this list.
  return [...found.values()].filter((e) => /^[A-Za-z0-9]{20,36}$/.test(e.uid));
}

function splitTuple(inner) {
  const out = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === "'" && inner[i - 1] !== "\\") inQuote = !inQuote;
    if (ch === "," && !inQuote) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function unquote(v) {
  if (!v) return null;
  const m = /^'(.*)'$/s.exec(v.trim());
  return m ? m[1] : null;
}

async function lookupUids(proj, uids, token) {
  if (uids.length === 0) return new Map();
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/projects/${proj}/accounts:lookup`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-goog-user-project": proj
      },
      body: JSON.stringify({ localId: uids })
    }
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`accounts:lookup on ${proj} returned ${response.status}: ${body.slice(0, 200)}`);
  }
  const data = await response.json();
  return new Map((data.users ?? []).map((u) => [u.localId, u]));
}

async function main() {
  const token = accessToken();
  const identities = [];
  for (const file of files) {
    identities.push(...extractSeedIdentities(readFileSync(file, "utf8"), file));
  }

  if (!asJson) {
    console.log(`Firebase project ${project}`);
    console.log(`${identities.length} hardcoded identit(ies) across ${files.length} seed file(s)\n`);
  }

  if (identities.length === 0) {
    console.log("✓ [0] no Firebase UID is hardcoded in these seeds");
    console.log("\nNothing to verify — which is the target state: identity belongs to the environment,");
    console.log("not to a file. See apps/backend/src/db/seed.ts for the email→uid pattern.");
    process.exit(0);
  }

  let live;
  try {
    live = await lookupUids(project, identities.map((i) => i.uid), token);
  } catch (error) {
    console.error(`✗ could not query ${project}: ${error.message}`);
    console.error("  Stopping: every UID below would be reported missing, which is how a working");
    console.error("  environment gets 'repaired' into a broken one.");
    process.exit(2);
  }

  const orphans = [];
  let id = 0;
  for (const identity of identities) {
    id += 1;
    const user = live.get(identity.uid);
    if (!user) {
      orphans.push(identity);
      check(
        id,
        false,
        `${identity.uid} exists in ${project}`,
        `declared at ${identity.sites.join(", ")}` +
          (identity.email ? ` for ${identity.email}` : "") +
          `\n     No such user in ${project}. Any row this UID owns can never be signed into.`
      );
      continue;
    }
    check(id, true, `${identity.uid} exists in ${project}${user.email ? ` (${user.email})` : ""}`);

    // The failure [n] above cannot see: the UID is real, but it is somebody else.
    if (identity.email && user.email && identity.email.toLowerCase() !== user.email.toLowerCase()) {
      id += 1;
      check(
        id,
        false,
        `${identity.uid}'s email in ${project} matches the seed`,
        `seed says ${identity.email}, ${project} says ${user.email}. The seed grants access to a` +
          "\n     different person than it appears to."
      );
    }
  }

  // Diagnose rather than merely report. A UID that is missing here and present in the sibling
  // project is not an unknown user — it is a cross-environment paste, and saying so is the
  // difference between a five-minute fix and an afternoon of hunting.
  if (orphans.length && sibling) {
    let siblingHits = new Map();
    try {
      siblingHits = await lookupUids(sibling, orphans.map((o) => o.uid), token);
    } catch {
      /* the diagnostic is best-effort; its absence must never change the verdict */
    }
    const leaked = orphans.filter((o) => siblingHits.has(o.uid));
    if (leaked.length && !asJson) {
      console.log("");
      console.log("⚠️  CROSS-ENVIRONMENT IDENTITY LEAK");
      for (const l of leaked) {
        const u = siblingHits.get(l.uid);
        console.log(`   ${l.uid} does not exist in ${project}, but DOES exist in ${sibling}` +
          (u.email ? ` as ${u.email}` : ""));
        console.log(`   → declared at ${l.sites.join(", ")}`);
      }
      console.log("");
      console.log(`   A ${sibling} Firebase UID has been pasted into a ${project} seed. CLAUDE.md §D`);
      console.log("   rule 2: after copying config between environments, assert the other environment's");
      console.log("   identifiers appear nowhere in the result.");
      console.log("   Fix: resolve the email in the TARGET project and use that uid — or better, stop");
      console.log("   writing uids into seeds (apps/backend/src/db/seed.ts already resolves email→uid).");
    }
  }

  const failed = results.filter((r) => r.state === "fail");
  if (asJson) {
    console.log(JSON.stringify({ project, files, results, failed: failed.length }, null, 2));
  } else {
    console.log("");
    if (failed.length) console.log(`FAILED: ${failed.length} seeded identit(ies) are wrong for ${project}.`);
    else console.log(`All seeded identities belong to ${project}.`);
  }
  process.exit(failed.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
