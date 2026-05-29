import { Retell } from "retell-sdk";

import { env } from "../config/env";
import { AppError } from "../domain/errors";

/**
 * Retell agent provisioning for auto-provisioning (Phase 4b). Clones a template
 * agent per restaurant and imports the Twilio number into Retell, bound to that
 * agent + our /retell/inbound webhook (which injects per-restaurant dynamic
 * variables). All behind PROVISIONING_AUTO_ENABLED; uncoverable by static tests,
 * so the SDK calls are written to the installed retell-sdk types and must be
 * validated live before the flag is turned on.
 */

function client(): Retell {
  if (!env.RETELL_API_KEY) {
    throw new AppError(503, "RETELL_NOT_CONFIGURED", "Retell API key is not configured.");
  }
  return new Retell({ apiKey: env.RETELL_API_KEY });
}

/** Clone the template agent for a restaurant; returns the new agent_id. */
export async function createAgentForRestaurant(name: string): Promise<string> {
  if (!env.RETELL_TEMPLATE_AGENT_ID) {
    throw new AppError(503, "NO_TEMPLATE_AGENT", "RETELL_TEMPLATE_AGENT_ID is not configured.");
  }
  const c = client();
  const template = await c.agent.retrieve(env.RETELL_TEMPLATE_AGENT_ID);
  // Reuse the template's response engine + voice; the AgentResponse and
  // AgentCreateParams engine unions are structurally the same but nominally
  // distinct, so cast through unknown (we're cloning a known-valid engine).
  const created = await c.agent.create({
    response_engine: template.response_engine,
    voice_id: template.voice_id,
    agent_name: `${name} (VocoTable)`
  } as unknown as Parameters<typeof c.agent.create>[0]);
  return created.agent_id;
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
    inbound_webhook_url: `${env.PUBLIC_API_BASE_URL.replace(/\/$/, "")}/retell/inbound`
  });
}
