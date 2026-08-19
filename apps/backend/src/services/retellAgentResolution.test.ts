/**
 * Which agent answers an inbound call.
 *
 * The 18 Aug 2026 incident was a venue answering in another venue's voice. One
 * route to that is a venue with no agent of its own silently borrowing the
 * deployment-wide RETELL_AGENT_ID — a single-tenant relic that, in a multi-venue
 * environment, is simply some other venue's agent.
 *
 * `env` is parsed once at import and the suite runs as APP_ENV=test, so the
 * production branch is unreachable through handleRetellInbound; that is why the
 * decision is a pure function.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { resolveOverrideAgentId } from "./retellService";

test("a provisioned venue always answers with its own agent", () => {
  for (const appEnv of ["development", "test", "production"]) {
    assert.deepEqual(resolveOverrideAgentId("agent_venue", appEnv, "agent_env"), {
      agentId: "agent_venue",
      source: "venue"
    });
  }
});

test("production posture never falls back to the deployment-wide agent", () => {
  assert.deepEqual(resolveOverrideAgentId(null, "production", "agent_env"), {
    agentId: undefined,
    source: "none"
  });
});

test("local dev may still use the env agent, and it is reported as such", () => {
  // `source: "env"` is what makes the caller log a warning — this fallback must
  // never fire silently, even where it is allowed.
  assert.deepEqual(resolveOverrideAgentId(null, "development", "agent_env"), {
    agentId: "agent_env",
    source: "env"
  });
});

test("no venue agent and no env agent emits no override at all", () => {
  assert.deepEqual(resolveOverrideAgentId(null, "development", undefined), {
    agentId: undefined,
    source: "none"
  });
});
