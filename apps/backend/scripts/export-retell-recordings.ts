// Export every call recording out of the vendor's storage and into a
// self-contained archive BitePerk controls.
//
//   APP_ENV=migration DATABASE_URL=postgres://… \
//     tsx scripts/export-retell-recordings.ts --out ./recordings-export [--dry-run]
//
// Why this exists: the audio for historical calls is the ONLY part of a call
// that does not live in our database. `call_logs` already holds the transcript
// and the analysis; `recording_url` is a pointer into the Retell workspace that
// created the call. That workspace is owned by a different legal entity and is
// being handed back, so anything not exported before then is gone — and the
// dashboard plays these recordings back as a sold plan feature.
//
// The archive is deliberately self-contained: audio, transcript, analysis and
// call metadata travel together, so a restore does not depend on this database
// still existing or on the vendor still being reachable.
//
// Idempotent. A file already present with a matching SHA-256 is left alone, so
// an interrupted run is resumed by re-running it. Verifying by hash rather than
// by size matters here: a truncated download is the failure mode that looks
// like success.
//
// --dry-run probes every URL and reports what WOULD be fetched, without writing
// anything. Run it first — it is how you learn a recording has already expired
// while the vendor still lists the call.
//
// ⚠️ The output contains recordings of real customers' phone calls. Write it to
// controlled storage (a private bucket with access logging), not to a laptop
// that syncs to a consumer cloud drive. The manifest deliberately records the
// original URL so an auditor can see where each file came from.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { pool } from "../src/db/pool";
import { logger } from "../src/utils/logger";

interface CallRow {
  id: string;
  provider: string | null;
  provider_call_id: string | null;
  restaurant_id: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  duration_seconds: number | null;
  caller_phone: string | null;
  caller_name: string | null;
  status: string | null;
  summary: string | null;
  intent: string | null;
  booking_outcome: string | null;
  reservation_id: string | null;
  recording_url: string;
  transcript: string | null;
  analysis_json: unknown;
}

interface ManifestEntry {
  call_log_id: string;
  provider: string | null;
  provider_call_id: string | null;
  restaurant_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  audio_file: string | null;
  bytes: number | null;
  sha256: string | null;
  source_url: string;
  status: "exported" | "already-present" | "unreachable" | "would-export";
  http_status?: number;
  note?: string;
}

const FETCH_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const DRY_RUN = process.argv.includes("--dry-run");

/** Filesystem-safe stem. Prefer the provider's call id — it is the identifier
 *  that ties the file back to the vendor's own records during an audit. */
function stemFor(row: CallRow): string {
  const raw = row.provider_call_id?.trim() || row.id;
  return raw.replace(/[^A-Za-z0-9._-]/g, "_");
}

function extensionFor(contentType: string | null): string {
  if (!contentType) return "bin";
  if (contentType.includes("wav") || contentType.includes("x-wav")) return "wav";
  if (contentType.includes("mpeg") || contentType.includes("mp3")) return "mp3";
  if (contentType.includes("ogg")) return "ogg";
  // application/octet-stream is what the CDN actually returns; the bytes have
  // been observed to be RIFF/WAVE. Sniffed below rather than assumed.
  return "bin";
}

/** RIFF....WAVE — cheap magic-number check so a mislabelled octet-stream still
 *  lands with the right extension instead of an opaque .bin. */
function sniffIsWav(buf: Buffer): boolean {
  return buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE";
}

/** Probe without transferring the audio. A dry run exists to answer "is it
 *  still there and how big", and pulling megabytes of customers' phone calls
 *  across the network to answer that is the wrong trade. */
async function probe(url: string): Promise<{ bytes: number | null } | { httpStatus: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "HEAD", signal: controller.signal });
    if (!res.ok) return { httpStatus: res.status };
    const len = res.headers.get("content-length");
    return { bytes: len ? Number(len) : null };
  } catch {
    return { httpStatus: 0 };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url: string): Promise<{ buf: Buffer; contentType: string | null } | { httpStatus: number }> {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      lastStatus = res.status;
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        return { buf, contentType: res.headers.get("content-type") };
      }
      // 404/410 mean the vendor has already expired it — retrying cannot help.
      if (res.status === 404 || res.status === 410) return { httpStatus: res.status };
    } catch {
      lastStatus = 0; // network/abort
    } finally {
      clearTimeout(timer);
    }
    if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  return { httpStatus: lastStatus };
}

async function main(): Promise<void> {
  const outDir = arg("out");
  if (!outDir) {
    console.error("--out <dir> is required (the directory to write the archive into)");
    process.exit(2);
  }

  const { rows } = await pool.query<CallRow>(
    `SELECT id, provider, provider_call_id, restaurant_id, started_at, ended_at,
            duration_seconds, caller_phone, caller_name, status, summary,
            intent, booking_outcome, reservation_id,
            recording_url, transcript, analysis_json
       FROM call_logs
      WHERE recording_url IS NOT NULL AND recording_url <> ''
      ORDER BY started_at NULLS LAST`
  );

  console.log(`${rows.length} call_logs row(s) reference a recording.`);
  if (DRY_RUN) console.log("DRY RUN — probing only, nothing will be written.\n");

  const audioDir = join(outDir, "audio");
  if (!DRY_RUN) await mkdir(audioDir, { recursive: true });

  const manifest: ManifestEntry[] = [];
  let exported = 0;
  let skipped = 0;
  let unreachable = 0;
  let bytesTotal = 0;

  for (const row of rows) {
    const stem = stemFor(row);
    const base: ManifestEntry = {
      call_log_id: row.id,
      provider: row.provider,
      provider_call_id: row.provider_call_id,
      restaurant_id: row.restaurant_id,
      started_at: row.started_at ? row.started_at.toISOString() : null,
      ended_at: row.ended_at ? row.ended_at.toISOString() : null,
      duration_seconds: row.duration_seconds,
      audio_file: null,
      bytes: null,
      sha256: null,
      source_url: row.recording_url,
      status: "would-export"
    };

    if (DRY_RUN) {
      const res = await probe(row.recording_url);
      if ("httpStatus" in res) {
        base.status = "unreachable";
        base.http_status = res.httpStatus;
        unreachable += 1;
        console.log(`  UNREACHABLE  ${stem}  HTTP ${res.httpStatus || "network error"}`);
      } else {
        base.bytes = res.bytes;
        bytesTotal += res.bytes ?? 0;
        console.log(`  would export  ${stem}  ${res.bytes ?? "size unknown"} bytes`);
      }
      manifest.push(base);
      continue;
    }

    // Resume: an existing file whose hash still matches is left untouched.
    const existingWav = join(audioDir, `${stem}.wav`);
    if (existsSync(existingWav)) {
      const existing = await readFile(existingWav);
      const sha = createHash("sha256").update(existing).digest("hex");
      base.status = "already-present";
      base.audio_file = `audio/${stem}.wav`;
      base.bytes = existing.length;
      base.sha256 = sha;
      manifest.push(base);
      skipped += 1;
      bytesTotal += existing.length;
      console.log(`  present      ${stem}  ${existing.length} bytes`);
      continue;
    }

    const res = await fetchWithRetry(row.recording_url);
    if ("httpStatus" in res) {
      base.status = "unreachable";
      base.http_status = res.httpStatus;
      base.note = "Recording no longer retrievable from the vendor; transcript and analysis are still archived.";
      manifest.push(base);
      unreachable += 1;
      logger.warn({
        evt: "recording_export_unreachable",
        call_log_id: row.id,
        provider_call_id: row.provider_call_id,
        http_status: res.httpStatus
      });
      console.log(`  UNREACHABLE  ${stem}  HTTP ${res.httpStatus}`);
      continue;
    }

    const ext = sniffIsWav(res.buf) ? "wav" : extensionFor(res.contentType);
    const file = join(audioDir, `${stem}.${ext}`);
    await writeFile(file, res.buf);

    base.status = "exported";
    base.audio_file = `audio/${stem}.${ext}`;
    base.bytes = res.buf.length;
    base.sha256 = createHash("sha256").update(res.buf).digest("hex");
    manifest.push(base);
    exported += 1;
    bytesTotal += res.buf.length;
    console.log(`  exported     ${stem}  ${res.buf.length} bytes`);
  }

  if (!DRY_RUN) {
    // Transcript + analysis travel with the audio so the archive stands alone
    // if this database is ever unavailable.
    const calls = rows.map((r) => ({
      call_log_id: r.id,
      provider: r.provider,
      provider_call_id: r.provider_call_id,
      restaurant_id: r.restaurant_id,
      started_at: r.started_at ? r.started_at.toISOString() : null,
      ended_at: r.ended_at ? r.ended_at.toISOString() : null,
      duration_seconds: r.duration_seconds,
      caller_phone: r.caller_phone,
      caller_name: r.caller_name,
      status: r.status,
      summary: r.summary,
      intent: r.intent,
      booking_outcome: r.booking_outcome,
      reservation_id: r.reservation_id,
      transcript: r.transcript,
      analysis: r.analysis_json
    }));
    await writeFile(join(outDir, "calls.json"), JSON.stringify(calls, null, 2));
    await writeFile(
      join(outDir, "manifest.json"),
      JSON.stringify(
        {
          exported_at: new Date().toISOString(),
          source: "Retell (legacy workspace) — audio only; transcript and analysis come from call_logs",
          counts: { referenced: rows.length, exported, already_present: skipped, unreachable },
          total_bytes: bytesTotal,
          entries: manifest
        },
        null,
        2
      )
    );
  }

  console.log(
    `\n${DRY_RUN ? "would export" : "exported"} ${DRY_RUN ? rows.length - unreachable : exported}` +
      `${skipped ? `, ${skipped} already present` : ""}` +
      `${unreachable ? `, ${unreachable} UNREACHABLE` : ""}` +
      `  (${(bytesTotal / 1024 / 1024).toFixed(1)} MB)`
  );
  if (unreachable > 0) {
    console.log(
      "\n⚠️  Unreachable recordings are permanently gone from the vendor. Their transcript\n" +
        "    and analysis are still archived; the audio is not recoverable."
    );
  }
  if (!DRY_RUN) console.log(`\nArchive written to ${outDir} (audio/, calls.json, manifest.json)`);

  await pool.end();
  // A partial export must not look like a success to a calling script.
  process.exit(unreachable > 0 ? 1 : 0);
}

main().catch(async (err) => {
  logger.error({ evt: "recording_export_failed", error: err });
  console.error(err?.message ?? err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
