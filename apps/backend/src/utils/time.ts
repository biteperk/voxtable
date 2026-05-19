import { OpeningHours, OpeningWindow } from "../domain/types";

const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function toMinutes(time: string): number {
  const [hoursPart, minutesPart] = time.split(":");
  const hours = Number(hoursPart);
  const minutes = Number(minutesPart);
  return hours * 60 + minutes;
}

export function fromMinutes(totalMinutes: number): string {
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}

export function getDayName(date: string): string {
  const parts = date.split("-").map(Number);
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];

  if (!year || !month || !day) {
    return "sunday";
  }

  const utcDate = new Date(Date.UTC(year, month - 1, day));
  return dayNames[utcDate.getUTCDay()] ?? "sunday";
}

export function isWithinOpeningHours(
  date: string,
  time: string,
  durationMinutes: number,
  openingHours: OpeningHours
): boolean {
  const windows = getOpeningWindowsForDate(date, openingHours);
  const start = toMinutes(time);
  const end = start + durationMinutes;

  return windows.some((window) => {
    const open = toMinutes(window.open);
    const close = toMinutes(window.close);
    return start >= open && end <= close;
  });
}

export function getOpeningWindowsForDate(date: string, openingHours: OpeningHours): OpeningWindow[] {
  const day = getDayName(date);
  return openingHours[day] ?? [];
}

export function formatVoiceTime(time: string): string {
  const [hourPart, minutePart] = time.split(":");
  const hour = Number(hourPart);
  const minute = Number(minutePart);
  const suffix = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 || 12;

  if (minute === 0) {
    return `${hour12} ${suffix}`;
  }

  return `${hour12}:${minute.toString().padStart(2, "0")} ${suffix}`;
}
