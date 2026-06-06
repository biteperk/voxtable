// Shared display constants used across multiple dashboard pages and by the
// formatting helpers in ./format. Page-specific constants live with their page.

export const INTENT_LABEL = {
  book: "New booking",
  modify: "Modify booking",
  cancel: "Cancellation",
  info: "Info / FAQ",
  other: "Other"
};

export const OUTCOME_LABEL = {
  confirmed: "Confirmed",
  no_availability: "No availability",
  declined: "Caller declined",
  transferred: "Transferred to staff",
  none: "No booking attempted"
};

// Calls without an ended_at older than this are treated as stale (Retell
// end-of-call webhook never landed) rather than "live forever".
export const LIVE_THRESHOLD_MS = 10 * 60 * 1000;

// Fallback avatar/background image (Google-hosted) used where a user has no photo.
export const restaurantImage =
  "https://lh3.googleusercontent.com/aida-public/AB6AXuAgvs7qA0qHOd2Nob8Vl9D-gIFHp0BmQY1DOKvAMXDTT6bBAyL8U1lrq-MJV9hWv6MzfT7aNcQk6xL_pujBCXaCuo4ExjvEYGkRayK6-gLpd0Y8DC1Ob8QfyIyg9MMSyRAklEVHlsUdVxYc92Bl2bdKwZNbozxITISxFGSTMm1GFjFgG4jhDIby6jRZKnR_RslKyO96YbopcDOm2xoUgLx4eSTSXZli5KtJYcV_HcCcUo9FGjv2Bxy7pOCxyMYwTdf_kEv41JzNcmE";
