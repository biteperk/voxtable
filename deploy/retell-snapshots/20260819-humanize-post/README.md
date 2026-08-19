# Mazcina staging — after the humanize pass, 19 Aug 2026

Read back from the API after the change. Three moves, per Sam's explicit decisions:

1. **Greeting cut from ~16s to one line**: "Thanks for calling {{restaurant_name}} —
   this is Bella. How can I help?"
   ⚠️ **The AI + recording disclosure was deliberately REMOVED from the greeting**, at
   Sam's direction, for the internal staging test line only. An open legal brief
   (`deploy/runbooks/legal-brief-call-recording.md`, NSW Surveillance Devices Act 2007)
   concerns exactly this disclosure — **this greeting must NOT be promoted to production
   or any line real callers reach without legal sign-off or the disclosure restored.**
   The prompt answers honestly in one sentence if a caller asks whether they're talking
   to an AI or being recorded.
2. **Prompt rewritten** 12,723 → 9,027 chars: "Sound human" promoted to the top as the
   frame; fixture-menu examples (Fish & Chips sizes, Coke/Lemonade/Fanta) genericized;
   the "unmistakably Australian voice" accent claim dropped (the voice is American Cimo;
   Aussie phrasing stays); AI/recording-honesty and speak-to-a-person rules added to
   replace the dropped greeting content. All functional contracts kept: time anchor,
   open/closed-check-first, booking steps, seating, pre-order-once + error handling,
   menu three modes + never-recite rule, modify-after-create, never-fake-it honesty,
   party≥7 callback, Aria correction, end_call discipline, venue_faq boundary,
   de-venued prose (verified: no venue name anywhere).
3. **Expressive Mode ON** (`enable_expressive_mode: true`, tags: empathetic, excited,
   happy, curious, surprised, pause, emphasis). Everything else untouched — voice
   retell-Cimo, temperature 1.1, speed 1, interruption 0.6, backchannel — one lever at
   a time so the next test call attributes cleanly.

⚠️ The Retell **dashboard draft is stale** — it predates the same-day open/closed and
menu-mode fixes. Publishing it would erase them; discard the draft and treat the API
(and these snapshots) as the truth.

Rollback: re-apply `20260819-humanize-pre/` (one PATCH each for LLM and agent).
