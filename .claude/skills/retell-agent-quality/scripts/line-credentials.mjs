// line-credentials.mjs — resolve a voice line's Retell credentials from its DECLARATION,
// not from whatever happens to be in the shell.
//
// This module exists because of a two-hour production outage on 20 Aug 2026. The repo's local
// .env holds a Retell key for the LEGACY workspace, not production. Every check that evening
// inherited it, so the production number read as "missing", the correct agent id read as
// "does not exist", and the resulting "repair" pointed the live venue row at an agent from the
// wrong workspace. The line had been answering; afterwards it did not.
//
// Nothing about that was detectable, because a key is just a string and a wrong one returns
// clean, confident 404s. So the source of the key is now part of the declaration, and the
// scripts fetch it rather than trust the environment.
import { execFileSync } from "node:child_process";

const run = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * @returns {{apiKey: string, webhookSecret: string, source: string}}
 */
export function resolveCredentials(declared) {
  const c = declared.retell_credentials;
  if (!c) {
    throw new Error(
      "This line declares no retell_credentials. Add them to deploy/voice-lines.json — " +
      "an ambient RETELL_API_KEY is exactly how the wrong workspace gets read."
    );
  }

  if (c.via === "secret-manager") {
    const apiKey = run("gcloud", [
      "secrets", "versions", "access", "latest",
      `--secret=${c.api_key_secret}`, `--project=${c.gcp_project}`
    ]);
    return {
      apiKey,
      // Whether the API key is also the webhook secret is declared per line rather than
      // inferred from the environment.
      webhookSecret: c.webhook_secret_is_api_key ? apiKey : run("gcloud", [
        "secrets", "versions", "access", "latest",
        `--secret=${c.webhook_secret_secret}`, `--project=${c.gcp_project}`
      ]),
      source: `Secret Manager (${c.gcp_project}/${c.api_key_secret})`
    };
  }

  if (c.via === "vm-ssh") {
    // One SSH round trip for both values; they never touch local disk.
    const raw = run("gcloud", [
      "compute", "ssh", c.instance, "--zone", c.zone, "--project", c.gcp_project,
      "--command", `grep -E '^(${c.api_key_var}|${c.webhook_secret_var})=' ${c.env_file}`
    ]);
    const pick = (name) => {
      const line = raw.split("\n").find((l) => l.startsWith(`${name}=`));
      return line ? line.slice(name.length + 1).trim() : "";
    };
    const apiKey = pick(c.api_key_var);
    const webhookSecret = pick(c.webhook_secret_var);
    if (!apiKey || !webhookSecret) {
      throw new Error(`Could not read ${c.api_key_var}/${c.webhook_secret_var} from ${c.instance}:${c.env_file}`);
    }
    return { apiKey, webhookSecret, source: `${c.instance}:${c.env_file}` };
  }

  throw new Error(`Unknown retell_credentials.via: ${c.via}`);
}

/**
 * Resolve one named secret from Secret Manager. Used for the Twilio pair a router line declares
 * under routing.twilio_auth — the same rule as above: the source of the credential is part of the
 * declaration, so a shell holding the wrong account's token cannot be read by accident.
 */
export function resolveSecret(name, gcpProject) {
  if (!name || !gcpProject) throw new Error("resolveSecret needs a secret name and a GCP project");
  return run("gcloud", ["secrets", "versions", "access", "latest", `--secret=${name}`, `--project=${gcpProject}`]);
}
