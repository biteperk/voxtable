# Phase 6: Growth + Scope Control

## Goal
Use a successful Natalia launch to win the next Sydney restaurant pilots while protecting the product from premature complexity.

## Timeline
Starts after Natalia is live.

Milestones:
- Week 6: two more Sydney pilots signed at $80/month each.
- Week 10: five paying customers and $400 MRR.
- Month 4: twenty customers and $1,600 MRR.

## Growth Strategy
- Turn Natalia into the first reference customer.
- Ask for introductions to 3-5 nearby restaurant owners or chefs after the first stable week.
- Lead with the pain point: missed calls and bad booking-tool experience.
- Keep pricing simple: $80/month flat, no per-cover fees.
- Demonstrate the live phone-call booking flow, not a slide deck.

## Scope Guardrails
Explicitly out of v1:
- multilingual inbound calls.
- outbound calling.
- loyalty programs.
- mobile app.
- Now Book It, ResDiary, OpenTable, SevenRooms, or Google booking integrations.
- floor-plan visualization.
- full multi-tenant self-service onboarding.
- custom restaurant marketing sites.
- advanced personalization beyond phone-number lookup.
- large automated test suite before first launch.

Capture requests, but do not build them until a paying customer repeats the need or the issue blocks retention.

## Multilingual Architecture Notes
Do not ship multilingual in v1, but avoid decisions that block it.

Prepare by:
- keeping prompts/configuration per restaurant.
- storing customer language preference when known.
- keeping FAQ content in structured settings.
- isolating voice/model provider configuration.
- using restaurant timezone and locale fields.

Future priority languages for Sydney suburbs may include Mandarin, Cantonese, Vietnamese, Arabic, Greek, and Italian.

## Packaging
VocoTable Core Plan:
- $80/month.
- inbound AI booking calls.
- booking dashboard.
- live call feed and transcripts where enabled.
- booking management.
- basic analytics.
- staff transfer fallback.

Avoid custom pricing until there are enough customers to justify segmentation.

## Reassessment Rules
Stop and reassess if:
- Natalia is not live by the end of Week 4.
- average call latency causes repeated caller hangups.
- booking data is unreliable.
- more than 20 percent of normal booking calls require staff intervention.
- the next two warm prospects do not see enough value at $80/month.

## Next Engineering Priorities After Launch
Prioritize based on live usage:
- reliability and latency improvements.
- cleaner dashboard operations.
- better FAQ management.
- duplicate booking prevention.
- owner notifications.
- onboarding checklist for the next pilot.

Defer:
- generalized multi-tenant billing.
- advanced analytics.
- complex table optimization.
- deep integrations.
- multilingual voice until English flow is stable.

## Done When
- Natalia is a reference customer.
- Two more Sydney pilot conversations are booked.
- The product can be demoed from a phone call through dashboard confirmation.
- The team has a written list of repeated customer requests and launch issues.
- No v1-excluded feature has entered the active sprint without an explicit decision.

