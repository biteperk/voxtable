// What Bella says once a booking tool succeeds.
//
// These sentences are deliberately detail-free. Until September 2026 the
// create_booking result read "Confirmed. Megan has a table for 2 on 2026-09-05
// at 4:30 PM." and the prompt told the agent to read it back — so every caller
// heard the booking a fourth and fifth time, seconds after agreeing to it. The
// one full recap belongs BEFORE the commit ("shall I lock it in?"); afterwards
// the caller wants the next step, not the same sentence again. The structured
// fields the agent may need (date, time, party size) travel alongside as data.

export function spokenBookingConfirmation(customerName: string): string {
  const name = customerName.trim();
  return name ? `All set, ${name}.` : "All set.";
}

export interface BookingChange {
  /** New booking name, only when it changed. */
  name?: string;
  /** New spoken time (e.g. "7:30 PM"), only when it changed. */
  time?: string;
  /** New short date (e.g. "Fri 5 Sep"), only when it changed. */
  date?: string;
  /** New party size, only when it changed. */
  partySize?: number;
}

// Confirms ONLY what changed, in one short sentence. A correction is not a
// reason to restate the whole booking.
export function spokenBookingChange(change: BookingChange): string {
  const parts: string[] = [];
  if (change.date && change.time) parts.push(`moved to ${change.date} at ${change.time}`);
  else if (change.time) parts.push(`moved to ${change.time}`);
  else if (change.date) parts.push(`moved to ${change.date}`);
  if (change.partySize !== undefined) parts.push(`now for ${change.partySize}`);
  if (change.name?.trim()) parts.push(`under ${change.name.trim()} now`);
  if (parts.length === 0) return "Done, that's updated.";
  return `Done, ${parts.join(", ")}.`;
}
