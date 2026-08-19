# Mazcina staging LLM — before the open/closed answer fix, 19 Aug 2026

`llm_c1d40dbe180e737dd2ce1309ed3f` as it was when a 13:09 test call answered
"are you open today?" (a Wednesday — closed) with "Yeah, we're open today —
…actually, Mazcina is closed on Tuesdays and Wednesdays". The venue_faq data was
correct on that call; the prompt caused the wrong lead-in two ways:

1. The Edge cases section said to answer hours questions "based on common
   restaurant knowledge" — a leftover from before the venue_faq section existed,
   directly contradicting it.
2. Nothing told the agent to check the day against the Hours entry BEFORE
   speaking, so it opened with a reflexive "yes" and corrected itself mid-turn.

The agent (`agent_7b67073710604d306443cc569c`) was not changed — LLM prompt only.
Post state: sibling `20260819-hours-answer-post/`.
