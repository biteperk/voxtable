# Staging Retell workspace, before the Mazcina conversion

Read back from the live **Staging** workspace on 19 Aug 2026, immediately before the
conversion in `deploy/runbooks/mazcina-staging-conversion.md` begins. **These four files are
the rollback** for anything that section does.

| Agent | id | LLM | Voice |
|---|---|---|---|
| Natalia's Bistro (STAGING) | `agent_b9087333b7030f0cee06a19ffc` | `llm_7c0a5c84498b81a5c723521038ef` | `custom_voice_e86a46d4b039b222fb6b31a0ad` |
| Cuban Corner Parramatta (STAGING) | `agent_a9c17694d805908f4b9a7bd4b9` | `llm_472328dafafd697a3c8e67230457` | `custom_voice_1623a38a0d701d49273800cfa8` |

Both webhooks point at `voxtable-stg-api-…run.app`; no production identifier appears in any
file here, and neither does the API key.

## What these prove, and why the runbook changed

The voice work is **already done** — and the runbook said otherwise, because it was written
from snapshots rather than from the workspace:

| Field | Live value | What the runbook used to claim |
|---|---|---|
| `voice_id` | `custom_voice_…` — "Australian female early 30s" | `11labs-Anna` ("unchanged") |
| `voice_model` | `eleven_multilingual_v2` | "unset on every agent in the repo's history" |
| `reminder_trigger_ms` | `18000` | "absent from every snapshot since 13 Aug" |
| `default_dynamic_variables` | empty | empty ✅ |

Applying that block literally would have swapped an Australian voice for an American one on
a venue whose whole point is sounding local — a change that breaks nothing and is therefore
easy to ship without noticing.

Build Mazcina's agent by copying these values from the live agent, not from this file or any
other snapshot. This directory exists to restore a known-good state, not to be a template.
