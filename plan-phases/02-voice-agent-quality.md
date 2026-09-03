# Phase 2: Voice Agent Quality

## Goal
Make the voice agent sound credible enough for Natalia to trust it with real callers. The agent should handle normal English booking calls, common modifications, simple cancellations, and top FAQs while transferring edge cases to staff cleanly.

## Timeline
Week 2, Days 1-5.

Target milestone by Day 5: Natalia hears the assistant, gives feedback, and signs off on the direction.

## Scope
- Configure ElevenLabs with an Aussie English voice.
- Compare Claude Sonnet 4.6 and GPT-4o for tool-calling, latency, and reliability.
- Write production-oriented RetellAI prompts for the booking flow.
- Add top restaurant FAQs.
- Define staff-transfer behavior.
- Run at least 20 internal calls on the staging number before Natalia's demo.

## Conversation Design
The assistant should be concise, warm, and operational. It must not over-explain that it is an AI unless legally or commercially required by the call script.

Core states:
- Greeting and intent detection.
- New booking.
- Availability check.
- Booking confirmation.
- Modify existing booking.
- Cancel booking.
- FAQ answer.
- Staff transfer.
- Graceful failure when tools or providers fail.

Required booking fields:
- customer name.
- phone number, preferably caller ID when reliable.
- reservation date.
- reservation time.
- party size.
- special notes, only when caller offers them or the restaurant requires them.

## Prompt Requirements
The system prompt should include:
- Restaurant identity and tone.
- Current date/time and restaurant timezone.
- Booking rules and opening hours.
- Required fields before calling booking tools.
- Tool-calling order: check availability before creating or modifying bookings.
- Explicit fallback rules for uncertainty.
- Transfer rules for cases outside v1.

The assistant should:
- Confirm ambiguous dates and times.
- Repeat the final booking details once before completion.
- Avoid promising specific tables unless table assignment is intentionally implemented.
- Keep responses short enough for natural voice pacing.
- Never expose internal tool names, API details, provider names, or raw errors.

## Human Transfer Rules
Transfer to staff when:
- party size is above the configured maximum.
- caller asks for a private event, catering, or function.
- caller is upset or asks for a human.
- caller requests an unsupported language.
- availability is ambiguous and the caller rejects suggested alternatives.
- backend tools fail twice in the same call.

The transfer message should be short and reassuring.

## FAQ Scope
Include only the top 10 FAQs Natalia confirms during daily check-ins:
- address.
- opening hours.
- parking.
- dietary accommodations.
- BYO or alcohol policy.
- outdoor seating.
- high chairs or accessibility.
- deposit or cancellation policy.
- group booking threshold.
- how to change or cancel a reservation.

FAQ answers should live in `restaurant_settings.faq_json`, not only inside the prompt.

## Latency Budget
Target:
- perceived response time below 1 second where possible.
- no long silent gaps after caller intent is clear.

Measure:
- RetellAI call logs.
- backend request duration.
- LLM response timing.
- tool-call failure rate.

Optimization order:
- shorten prompt.
- reduce unnecessary confirmation turns.
- simplify tool payloads.
- pick the model with the most reliable low-latency tool-calling.
- tune ElevenLabs streaming settings.

## Provider Selection
Compare Claude Sonnet 4.6 and GPT-4o with the same call scripts.

Choose based on:
- correct tool-call sequencing.
- ability to recover from missing fields.
- latency.
- naturalness in voice handoff.
- failure behavior when availability is unavailable.

Record the chosen model and reasoning in the phase notes during implementation.

## Staging Test Call Checklist
Run at least these scenarios:
- normal booking for two tonight.
- normal booking for four this weekend.
- unavailable time with accepted suggested alternative.
- unavailable time with rejected alternative.
- caller changes party size before confirmation.
- caller modifies an existing booking.
- caller cancels an existing booking.
- caller asks each top FAQ.
- large group transfer.
- angry caller transfer.
- backend timeout or simulated API error.
- unsupported language transfer.

## Done When
- ElevenLabs voice is configured and sounds acceptable for Natalia's market.
- The selected LLM completes booking tool calls reliably.
- The assistant handles the happy path in repeated real calls.
- The assistant transfers unsupported cases cleanly.
- Natalia has heard the agent and provided feedback.
- Prompt changes from Natalia's feedback are applied before Week 3 integration work.

## Risks
- Overly friendly prompts can increase call duration; prefer clear and brief turns.
- Tool-calling failures are more damaging than imperfect voice tone.
- FAQ expansion can become scope creep; only Natalia's confirmed top 10 belong in v1.
