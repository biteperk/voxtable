export type BookingSource = "voice" | "dashboard" | "web";
export type ReservationStatus = "pending" | "confirmed" | "cancelled" | "no_show" | "completed";
export type CallStatus = "started" | "in_progress" | "completed" | "failed" | "transferred";

export interface OpeningWindow {
  open: string;
  close: string;
}

export type OpeningHours = Record<string, OpeningWindow[]>;

export const DEFAULT_OPENING_HOURS: OpeningHours = {
  monday: [{ open: "17:00", close: "22:00" }],
  tuesday: [{ open: "17:00", close: "22:00" }],
  wednesday: [{ open: "17:00", close: "22:00" }],
  thursday: [{ open: "17:00", close: "22:00" }],
  friday: [{ open: "17:00", close: "23:00" }],
  saturday: [{ open: "12:00", close: "23:00" }],
  sunday: [{ open: "12:00", close: "21:00" }]
};

export interface RestaurantSettings {
  restaurantId: string;
  bookingDurationMinutes: number;
  openingHours: OpeningHours;
  faq: Record<string, unknown>;
  voiceConfig: Record<string, unknown>;
}

export interface AvailableTable {
  id: string;
  label: string;
  minCapacity: number;
  maxCapacity: number;
  zone?: string | null;
  description?: string | null;
  attributes?: string[];
}

export interface AvailabilityInput {
  restaurantId: string;
  date: string;
  time: string;
  partySize: number;
  seatingPreference?: string;
  excludeReservationId?: string;
}

export interface AvailabilityResult {
  available: boolean;
  requestedTime: string;
  suggestedTime: string | null;
  suggestedTimes: string[];
  tableIds: string[];
  tableLabel: string | null;
  message: string;
  naturalAlternativesMessage: string | null;
}

export interface CreateBookingInput {
  restaurantId: string;
  customerName: string;
  customerPhone: string;
  date: string;
  time: string;
  partySize: number;
  tableId?: string;
  source: BookingSource;
  notes?: string;
  seatingPreference?: string;
  // Web-channel (Cal.com) bookings may arrive without a parseable phone. The
  // guest already holds a confirmation email, so instead of rejecting we let
  // the caller pass a sentinel (e.g. "web:<uid>") stored verbatim. Voice-path
  // callers must never set this — Bella re-prompts on CUSTOMER_PHONE_INVALID.
  allowUnparseablePhone?: boolean;
  callLogId?: string;
  provider?: string;
  providerCallId?: string;
}

export interface BookingResult {
  bookingId: string;
  status: ReservationStatus;
  confirmationMessage: string;
}
