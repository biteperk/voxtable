/**
 * The payload builders behind auto-provisioning.
 *
 * This file is referenced by retellProvisioning.ts's own doc comment as the
 * thing that covers these builders — and until now it did not exist. That gap
 * is why `buildVenueAgentPayload` silently shipped carrying two voice-relevant
 * fields out of ~25: every auto-provisioned venue would have taken Retell's
 * defaults for how its phone line actually sounds.
 *
 * The SDK calls themselves cannot be covered statically; the payloads can.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildVenueAgentPayload,
  buildVenueLlmPayload,
  templateLlmId
} from "./retellProvisioning";

/** A template shaped like a real Retell agent read-back, with tuned audio. */
function templateAgent(overrides: Record<string, unknown> = {}): never {
  return {
    agent_id: "agent_template",
    agent_name: "Template (VoxTable)",
    response_engine: { type: "retell-llm", llm_id: "llm_template" },
    voice_id: "11labs-Anna",
    language: "en-AU",
    voice_model: "eleven_multilingual_v2",
    fallback_voice_ids: ["11labs-Noah"],
    responsiveness: 1,
    interruption_sensitivity: 0.7,
    enable_backchannel: true,
    reminder_trigger_ms: 18000,
    max_call_duration_ms: 600000,
    data_storage_setting: "everything",
    data_storage_retention_days: 30,
    pii_config: { mode: "post_call" },
    post_call_analysis_model: "gpt-4o-mini",
    post_call_analysis_data: [{ name: "intent" }],
    ...overrides
  } as never;
}

test("the agent points at the venue's OWN llm, never the template's", () => {
  const payload = buildVenueAgentPayload(templateAgent(), "llm_venue", "Mazcina", "https://api.example");
  assert.deepEqual(payload.response_engine, { type: "retell-llm", llm_id: "llm_venue" });
});

test("agent_name and webhook_url are set per venue", () => {
  const payload = buildVenueAgentPayload(templateAgent(), "llm_venue", "Mazcina", "https://api.example/");
  assert.equal(payload.agent_name, "Mazcina (VoxTable)");
  // Trailing slash on the base URL must not produce a double slash.
  assert.equal(payload.webhook_url, "https://api.example/retell/webhook");
});

test("the audio and conversational settings are inherited, not left to defaults", () => {
  // The regression this file exists for. A venue that does not carry these
  // sounds different from every venue provisioned before it.
  const payload = buildVenueAgentPayload(templateAgent(), "llm_venue", "Mazcina", "https://api.example");
  for (const [field, expected] of [
    ["voice_id", "11labs-Anna"],
    ["language", "en-AU"],
    ["voice_model", "eleven_multilingual_v2"],
    ["responsiveness", 1],
    ["interruption_sensitivity", 0.7],
    ["enable_backchannel", true],
    ["reminder_trigger_ms", 18000],
    ["max_call_duration_ms", 600000]
  ] as Array<[string, unknown]>) {
    assert.deepEqual(payload[field], expected, `${field} was not carried to the venue agent`);
  }
  assert.deepEqual(payload.fallback_voice_ids, ["11labs-Noah"]);
});

test("the data-handling posture is inherited", () => {
  const payload = buildVenueAgentPayload(templateAgent(), "llm_venue", "Mazcina", "https://api.example");
  assert.equal(payload.data_storage_setting, "everything");
  assert.equal(payload.data_storage_retention_days, 30);
  assert.deepEqual(payload.pii_config, { mode: "post_call" });
});

test("fields the template does not carry are omitted, not sent as undefined", () => {
  const payload = buildVenueAgentPayload(
    templateAgent({ voice_model: undefined, fallback_voice_ids: undefined }),
    "llm_venue",
    "Mazcina",
    "https://api.example"
  );
  assert.ok(!("voice_model" in payload), "absent template fields must not be sent");
  assert.ok(!("fallback_voice_ids" in payload), "absent template fields must not be sent");
});

test("the venue LLM starts with EMPTY default_dynamic_variables", () => {
  // Frozen variables only surface when /retell/inbound fails — i.e. they greet
  // the caller with a stale venue name at the worst possible moment.
  const payload = buildVenueLlmPayload({
    general_prompt: "You are {{restaurant_name}}.",
    begin_message: "{{restaurant_name}}, how can I help?",
    model: "gpt-4.1",
    default_dynamic_variables: { restaurant_name: "Someone Else's Bistro" }
  } as never);
  assert.deepEqual(payload.default_dynamic_variables, {});
});

test("the venue LLM copies the prompt verbatim", () => {
  // Identity comes from dynamic variables at call time, so the prompt must NOT
  // be rewritten per venue — baking a name in here freezes it forever.
  const prompt = "You are {{restaurant_name}}. Ask for {{owner_name}}.";
  const payload = buildVenueLlmPayload({ general_prompt: prompt, model: "gpt-4.1" } as never);
  assert.equal(payload.general_prompt, prompt);
});

test("templateLlmId reads a retell-llm engine and rejects anything else", () => {
  assert.equal(templateLlmId({ response_engine: { type: "retell-llm", llm_id: "llm_x" } } as never), "llm_x");
  // A conversation-flow template has no LLM to give the venue; returning null
  // is what makes the caller fail loudly instead of provisioning onto shared config.
  assert.equal(templateLlmId({ response_engine: { type: "conversation-flow" } } as never), null);
  assert.equal(templateLlmId({ response_engine: null } as never), null);
});
