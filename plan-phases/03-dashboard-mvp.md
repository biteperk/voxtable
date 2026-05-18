# Phase 3: Dashboard MVP

## Goal
Build the owner dashboard that Natalia can use during soft launch: live call visibility, booking management, analytics, AI configuration, and subscription/settings screens based on the provided dark UI designs.

## Timeline
Week 2 dashboard kickoff, continuing into Week 3.

## Scope
- React and Tailwind application scaffold.
- Single shared owner login for v1.
- Dark dashboard layout with sidebar navigation.
- Core screens:
  - Live Feed.
  - Booking Log.
  - Analytics.
  - AI Configuration.
  - Settings/Billing.
- API client for backend reservation and call-log data.
- Responsive desktop-first layout with basic mobile usability.

## Design Direction
Use the provided mockups as the design baseline:
- dark background.
- left sidebar.
- blue/cyan accent for active navigation and primary actions.
- compact operational cards.
- monospace-like operational typography where appropriate.
- analytics cards for calls, booking success rate, estimated revenue saved, and AI response time.
- billing screen showing the $80/month core plan.

Avoid making this a marketing page. The first screen should be the working dashboard.

## Navigation
Sidebar entries:
- Live Feed.
- Booking Log.
- Analytics.
- AI Configuration.
- Settings.

Primary footer action:
- View Live Analytics.

Restaurant identity:
- Show restaurant name and AI online/offline state.
- Use data from backend/settings, not hard-coded Natalia strings except seeded v1 defaults.

## Screens
### Live Feed
Shows:
- current active call when one exists.
- recent calls.
- caller phone.
- detected intent.
- transcript excerpt.
- booking outcome.
- transfer status.

### Booking Log
Shows:
- date/time.
- customer name.
- phone.
- party size.
- booking status.
- source.
- notes.

Actions:
- edit booking.
- cancel booking.
- mark no-show.

### Analytics
Shows:
- total calls handled.
- booking success rate.
- estimated revenue saved.
- average AI response time.
- call volume and confirmed bookings by day.
- outcome breakdown: confirmed, FAQ answered, transferred to staff.

v1 analytics can be derived from call logs and reservations. Perfect financial modeling is not required.

### AI Configuration
Shows editable or read-only v1 controls for:
- AI status.
- transfer phone number.
- opening hours summary.
- booking duration.
- top FAQ answers.
- voice/model configuration summary.

In v1, editing can be limited to the safest fields if backend support is not ready.

### Settings/Billing
Shows:
- VocoTable Core Plan.
- $80/month.
- active subscription state.
- payment method placeholder.
- billing history placeholder.

Do not build real payment processing in v1 unless explicitly added later.

## Auth
Use one shared owner login for v1.

Minimum requirements:
- protect dashboard routes.
- keep credentials in environment variables or a simple backend-backed auth mechanism.
- do not implement roles, invitations, or multi-user management.

## Data Freshness
Use polling first:
- Live Feed: 3-5 second interval during soft launch.
- Booking Log: refresh on mutation and periodic background polling.
- Analytics: refresh on page load and manual refresh/export action.

Introduce WebSockets only if polling is visibly insufficient for Natalia's workflow.

## Acceptance Criteria
- Dashboard can load deployed backend data.
- Natalia can see new bookings without touching the database.
- Natalia can edit, cancel, and mark no-show for reservations.
- The UI visually follows the provided dark designs.
- No major layout overlap occurs at common desktop and mobile widths.
- Empty, loading, and error states exist for every screen.

## Done When
- Dashboard is deployed to Vercel.
- Auth protects the dashboard.
- Navigation and core screens exist.
- Live Feed and Booking Log are connected to backend data.
- Analytics uses real backend data or clearly marked seeded demo data until live data exists.
- Settings/Billing is present with v1-safe placeholders.

## Risks
- Building polished analytics before operational flows can waste time; prioritize Live Feed and Booking Log.
- Billing UI should not imply payment processing is complete if it is only a placeholder.
- Hard-coded Natalia strings will slow future pilots; keep them as seed data.

