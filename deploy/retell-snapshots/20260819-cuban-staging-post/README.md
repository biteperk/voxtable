# Cuban Corner Parramatta (STAGING) — after the golden polish, 19 Aug 2026

First real application of the `retell-agent-quality` skill. Read back from the API:

- Prompt replaced with the golden (Mazcina-proven) prompt — de-venued, so reusable
  verbatim — with two adaptations: the licensed-drinks refusal section KEPT (Cuban
  Corner serves alcohol; wording made venue-agnostic, aligned with the backend
  `is_restricted`/`create_order` contract), and the party-size edge GENERALIZED to
  rely on `check_availability`'s `party_too_large` reason instead of Mazcina's
  hard-coded "seats six" (a golden-prompt improvement worth backporting).
- Golden greeting; `default_dynamic_variables` {}; every functional tool
  speak_during/after true; golden menu_lookup three-mode description; all tool URLs
  asserted staging-host.
- Agent: `stt_mode fast`, `interruption 0.6`, `enable_expressive_mode false`
  (explicit), `fallback_voice_ids ["cartesia-Maren"]` (custom-voice requirement),
  `boosted_keywords` rewritten to 30 real Cuban Corner terms (empanadas, Cubano,
  mojito, fajita, churros…). Voice kept: the venue's custom AU ElevenLabs voice.
- `assert-agent.mjs` ALL CHECKS PASSED (VENUE_NAMES=cuban,parramatta,havana).

⚠️ This agent has NO phone number (staging's one DID belongs to Mazcina — THE ONE
RULE), so /retell/inbound never fires for it: dashboard/web tests must supply test
dynamic variables, and {{venue_faq}}/{{today_status}} only resolve for real once the
venue is seeded and bound in an environment with its own number.

Rollback: re-apply the sibling `-pre/` snapshots (one PATCH per object).
