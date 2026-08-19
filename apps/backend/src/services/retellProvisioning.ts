import { Retell } from "retell-sdk";

import { env } from "../config/env";
import { AppError, PermanentProvisioningError } from "../domain/errors";
import { logger } from "../utils/logger";

/**
 * Retell agent provisioning for auto-provisioning (Phase 4b).
 *
 * Gives every venue its OWN LLM. The previous version created the agent with
 * `response_engine: template.response_engine`, which copies the LLM **by
 * reference** — every provisioned venue then shared the template's LLM, and
 * editing one venue's prompt rewrote every other venue's live agent.
 * `deploy/runbooks/venue-onboarding.md` §1 trap 1 forbids exactly that.
 *
 * The per-venue LLM exists for EDIT ISOLATION, not for content differences:
 * the prompt is parameterised on {{restaurant_name}} and
 * `handleRetellInbound` injects the real value fresh on every call. So the new
 * LLM is a verbatim copy — anything venue-specific baked in here would be
 * frozen at provisioning time, which is the bug we are avoiding, not a feature.
 *
 * The SDK calls cannot be covered by static tests; the payload BUILDERS can,
 * and are (retellProvisioning.test.ts). Rehearse the calls themselves with an
 * adopt-number provisioning job against an existing number before enabling the
 * flag — see apps/backend/docs/provisioning-runbook.md.
 */

/** Placeholder the template prompt must carry so the venue name is per-call. */
const VENUE_NAME_PLACEHOLDER = "{{restaurant_name}}";

function client(): Retell {
  if (!env.RETELL_API_KEY) {
    throw new AppError(503, "RETELL_NOT_CONFIGURED", "Retell API key is not configured.");
  }
  return new Retell({ apiKey: env.RETELL_API_KEY });
}

function apiBase(): string {
  return env.PUBLIC_API_BASE_URL.replace(/\/$/, "");
}

type TemplateAgent = Awaited<ReturnType<Retell["agent"]["retrieve"]>>;
type TemplateLlm = Awaited<ReturnType<Retell["llm"]["retrieve"]>>;

/**
 * The template's llm_id, or null when the response engine is not a Retell LLM
 * (a conversation-flow or custom-LLM template has none).
 */
export function templateLlmId(agent: Pick<TemplateAgent, "response_engine">): string | null {
  const engine = agent.response_engine as { type?: string; llm_id?: string } | null | undefined;
  if (!engine || engine.type !== "retell-llm") return null;
  return engine.llm_id ?? null;
}

/**
 * Copy the template LLM verbatim, minus anything that must not be inherited.
 *
 * `default_dynamic_variables` is deliberately emptied: nothing in production
 * refreshes them, and a phone number carrying both `inbound_agents` and
 * `inbound_webhook_url` falls back to the static agent when the webhook fails —
 * greeting the caller with a stale venue name and months-old dates at exactly
 * the worst moment. Empty means the fallback says nothing rather than something
 * wrong. See NUMBERS.md §6 and venue-onboarding.md §1 trap 4.
 */
export function buildVenueLlmPayload(template: TemplateLlm): Record<string, unknown> {
  return {
    general_prompt: template.general_prompt,
    general_tools: template.general_tools,
    begin_message: template.begin_message,
    start_speaker: template.start_speaker,
    model: template.model,
    model_temperature: template.model_temperature,
    model_high_priority: template.model_high_priority,
    tool_call_strict_mode: template.tool_call_strict_mode,
    knowledge_base_ids: template.knowledge_base_ids,
    kb_config: template.kb_config,
    states: template.states,
    starting_state: template.starting_state,
    default_dynamic_variables: {}
  };
}

/**
 * Every field the venue's agent must carry over from the template, beyond the
 * ones set per venue. Anything NOT listed here silently becomes a Retell
 * default on the new agent.
 *
 * The audio/conversational block is the half that was missing and matters most:
 * a venue provisioned without it gets Retell's defaults for how the line
 * actually SOUNDS — an unpinned `voice_model` (the flat, low-latency default,
 * and one Retell may change under us), a 10s rather than 18s reminder so the
 * agent interrupts its own tool calls with "are you still there?", possibly no
 * backchannel, different barge-in, and a 1-hour call cap instead of 10 minutes.
 * Those are exactly the settings tuned by hand on the existing venues, so
 * without this list every new venue would sound worse than the ones before it
 * and nobody would know why.
 *
 * `undefined` entries are dropped before the call so we never send a key the
 * template itself does not carry.
 */
const INHERITED_AGENT_FIELDS = [
  // Identity / plumbing
  "voice_id",
  "language",
  // How the line sounds
  "voice_model",
  "fallback_voice_ids",
  "voice_speed",
  "voice_temperature",
  "volume",
  "pronunciation_dictionary",
  // How the conversation feels
  "responsiveness",
  "interruption_sensitivity",
  "enable_backchannel",
  "backchannel_frequency",
  "backchannel_words",
  "reminder_trigger_ms",
  "reminder_max_count",
  "ambient_sound",
  "ambient_sound_volume",
  "stt_mode",
  "vocab_specialization",
  "boosted_keywords",
  "denoising_mode",
  "max_call_duration_ms",
  "begin_message_delay_ms",
  "end_call_after_silence_ms",
  "allow_user_dtmf",
  // Data-handling posture — deliberate, not defaults to inherit
  "data_storage_setting",
  "data_storage_retention_days",
  "pii_config",
  "post_call_analysis_model",
  "post_call_analysis_data"
] as const;

/**
 * Build the venue's agent, pointed at ITS OWN llm, and carry across the fields
 * an API-created agent does not inherit.
 *
 * `webhook_url` is the one most easily missed: agents created through the API
 * come back with it unset, so lifecycle events (and therefore every call_logs
 * row) would silently never arrive.
 */
export function buildVenueAgentPayload(
  template: TemplateAgent,
  llmId: string,
  venueName: string,
  apiBaseUrl: string
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    response_engine: { type: "retell-llm", llm_id: llmId },
    agent_name: `${venueName} (VoxTable)`,
    webhook_url: `${apiBaseUrl.replace(/\/$/, "")}/retell/webhook`
  };

  const source = template as unknown as Record<string, unknown>;
  for (const field of INHERITED_AGENT_FIELDS) {
    const value = source[field];
    if (value !== undefined) payload[field] = value;
  }

  return payload;
}

/** Retrieve the template agent, failing permanently if it is unusable. */
async function loadTemplateAgent(c: Retell): Promise<TemplateAgent> {
  if (!env.RETELL_TEMPLATE_AGENT_ID) {
    throw new AppError(503, "NO_TEMPLATE_AGENT", "RETELL_TEMPLATE_AGENT_ID is not configured.");
  }
  return c.agent.retrieve(env.RETELL_TEMPLATE_AGENT_ID);
}

/**
 * Create this venue's LLM and return its id.
 *
 * Split from agent creation so the caller can record the new llm_id on the job
 * payload BEFORE the agent call runs. Without that, a failure between the two
 * leaks an orphan LLM in the Retell workspace on every retry.
 */
export async function createVenueLlm(): Promise<string> {
  const c = client();
  const templateAgent = await loadTemplateAgent(c);

  const llmId = templateLlmId(templateAgent);
  if (!llmId) {
    throw new PermanentProvisioningError(
      `Retell template agent ${env.RETELL_TEMPLATE_AGENT_ID} does not use a Retell LLM response ` +
        `engine, so there is no LLM to give this venue. Point RETELL_TEMPLATE_AGENT_ID at a ` +
        `single-prompt agent.`
    );
  }

  const templateLlm = await c.llm.retrieve(llmId);

  // The template must be de-venued. A prompt with no {{restaurant_name}} is one
  // that names a specific restaurant (and often its owner) in prose — cloning
  // it would greet every future venue's callers with someone else's name. This
  // is a misconfiguration, so fail permanently rather than retry six times.
  if (!templateLlm.general_prompt?.includes(VENUE_NAME_PLACEHOLDER)) {
    throw new PermanentProvisioningError(
      `Retell template LLM ${llmId} has no ${VENUE_NAME_PLACEHOLDER} placeholder in its prompt, so ` +
        `it is not a safe template — it likely names a specific venue. Point ` +
        `RETELL_TEMPLATE_AGENT_ID at a de-venued agent.`
    );
  }

  const created = await c.llm.create(
    buildVenueLlmPayload(templateLlm) as unknown as Parameters<typeof c.llm.create>[0]
  );
  return created.llm_id;
}

/**
 * Create this venue's agent against an already-created LLM; returns the agent id.
 *
 * Reads the agent back and asserts the isolation actually holds. The whole
 * point of this module is that editing one venue's prompt cannot touch another
 * venue's live agent, and an unverified fix is exactly what the previous
 * version was.
 */
export async function createVenueAgent(llmId: string, venueName: string): Promise<string> {
  const c = client();
  const templateAgent = await loadTemplateAgent(c);

  const created = await c.agent.create(
    buildVenueAgentPayload(templateAgent, llmId, venueName, apiBase()) as unknown as Parameters<
      typeof c.agent.create
    >[0]
  );

  const readBack = await c.agent.retrieve(created.agent_id);
  const boundLlmId = templateLlmId(readBack);
  if (!boundLlmId || boundLlmId !== llmId) {
    throw new PermanentProvisioningError(
      `Retell agent ${created.agent_id} came back bound to LLM ${boundLlmId ?? "none"} instead of ` +
        `${llmId}. Refusing to continue: a venue sharing another venue's LLM means editing one ` +
        `prompt rewrites both.`
    );
  }
  if (boundLlmId === templateLlmId(templateAgent)) {
    throw new PermanentProvisioningError(
      `Retell agent ${created.agent_id} is bound to the TEMPLATE's LLM. Editing this venue's prompt ` +
        `would rewrite every other venue's live agent.`
    );
  }
  if (!readBack.webhook_url) {
    throw new PermanentProvisioningError(
      `Retell agent ${created.agent_id} has no webhook_url, so call lifecycle events would never ` +
        `reach us and no call would ever be logged.`
    );
  }

  return created.agent_id;
}

/**
 * Normalize a venue or agent name for comparison: case-folded, punctuation and
 * whitespace stripped. "Natalia's Bistro (STAGING)" -> "nataliasbistrostaging".
 * Deliberately loose — the job is to catch ANOTHER venue's name, not to police
 * a naming convention.
 */
function comparableName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface AgentVerification {
  agentId: string;
  agentName: string | null;
  /** False when the agent's name does not appear to belong to this venue. */
  matchesVenue: boolean;
}

/**
 * Prove a Retell agent exists and plausibly belongs to this venue BEFORE it is
 * written to `restaurants.retell_agent_id` by the admin bind.
 *
 * This exists because of a real incident (18 Aug 2026): the staging venue was
 * bound to `agent_b9087333…`, which is "Natalia's Bistro (STAGING)". Number ->
 * venue resolved correctly and the webhook returned the right restaurant_name,
 * but the call was handed to another venue's agent, whose prompt hard-coded
 * that venue's name and owner. The caller heard a confident, wrong venue while
 * the booking landed against the right one. Nothing objected: the column is
 * untyped TEXT, the bind did no vendor round-trip, and go-live only checks the
 * field is non-null.
 *
 * Auto-provisioning does not need this — createVenueAgent builds the agent it
 * then binds. It is the hand-bind path that can name anything at all.
 *
 * Throws when the agent cannot be proven to exist. Returns the verdict for a
 * name mismatch so the caller can decide: an agent named for a brand rather
 * than the venue is a real case, and should be an audited exception rather than
 * a silent one.
 */
export async function verifyAgentForVenue(
  agentId: string,
  venueName: string
): Promise<AgentVerification> {
  const c = client();
  let agent: TemplateAgent;
  try {
    agent = await c.agent.retrieve(agentId);
  } catch (error) {
    // A 404 and a network failure are both "we could not prove this agent
    // exists". Neither may be stored: an unverifiable binding is exactly the
    // state this function exists to prevent. The underlying error goes to the
    // log (redacted there), never into the HTTP response.
    logger.error({ evt: "retell_agent_verify_failed", agent_id: agentId, error });
    throw new AppError(
      409,
      "RETELL_AGENT_NOT_FOUND",
      `Retell has no agent ${agentId}, or it could not be reached. The binding was not saved.`
    );
  }

  const agentName = agent.agent_name ?? null;
  // No name at all means we cannot prove ownership either way. Treat that as a
  // mismatch so it takes the same deliberate override, rather than sailing
  // through on an absence of evidence.
  const matchesVenue =
    agentName !== null && comparableName(agentName).includes(comparableName(venueName));

  return { agentId, agentName, matchesVenue };
}

/** Import the Twilio number into Retell, bound to the agent + inbound webhook. */
export async function importNumberToRetell(phoneNumber: string, agentId: string): Promise<void> {
  if (!env.TWILIO_TERMINATION_URI) {
    throw new AppError(503, "NO_TERMINATION_URI", "TWILIO_TERMINATION_URI is not configured.");
  }
  const c = client();
  await c.phoneNumber.import({
    phone_number: phoneNumber,
    termination_uri: env.TWILIO_TERMINATION_URI,
    inbound_agents: [{ agent_id: agentId, weight: 1 }],
    inbound_webhook_url: `${apiBase()}/retell/inbound`
  });
}
