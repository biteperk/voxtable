export type BookingSource = "voice" | "dashboard" | "web";
export type ReservationStatus = "pending" | "confirmed" | "cancelled" | "no_show" | "completed";
export type CallStatus = "started" | "in_progress" | "completed" | "failed" | "transferred";

export interface OpeningWindow {
  open: string;
  close: string;
}

export type OpeningHours = Record<string, OpeningWindow[]>;

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
}

export interface AvailabilityInput {
  restaurantId: string;
  date: string;
  time: string;
  partySize: number;
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
  source: BookingSource;
  notes?: string;
  callLogId?: string;
  provider?: string;
  providerCallId?: string;
}

export interface BookingResult {
  bookingId: string;
  status: ReservationStatus;
  confirmationMessage: string;
}
