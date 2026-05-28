const baseUrl = process.env.PUBLIC_API_BASE_URL ?? "http://localhost:3050";
const restaurantId =
  process.env.DEFAULT_RESTAURANT_ID ?? "11111111-1111-4111-8111-111111111111";

// NOTE: this script does not send a Firebase Bearer token. It assumes the
// target backend has DASHBOARD_VERIFY_AUTH=false (the local default), which
// makes requireFirebaseAuth a no-op. Production always has it true and will
// 401 every request — only run smoke against local / disabled-auth envs.

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  const body = (await response.json()) as T;

  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} failed: ${JSON.stringify(body)}`);
  }

  return body;
}

function getSmokeDate(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 30);
  return date.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const date = getSmokeDate();

  const health = await request<{ status: string; database: string; version: string }>("/health");
  console.log("health", health);

  const availability = await request<{
    available: boolean;
    suggested_time: string | null;
    table_ids: string[];
    message: string;
  }>("/availability/check", {
    method: "POST",
    body: JSON.stringify({
      restaurant_id: restaurantId,
      date,
      time: "18:00",
      party_size: 2
    })
  });
  console.log("availability", availability);

  if (!availability.available) {
    throw new Error(`Expected smoke-test slot to be available: ${availability.message}`);
  }

  const booking = await request<{
    booking_id: string;
    status: string;
    confirmation_message: string;
  }>("/bookings", {
    method: "POST",
    body: JSON.stringify({
      restaurant_id: restaurantId,
      customer_name: "Phase One Smoke Test",
      customer_phone: "+61400000000",
      date,
      time: "18:00",
      party_size: 2,
      source: "dashboard",
      notes: "Created by npm run smoke:backend"
    })
  });
  console.log("booking", booking);

  const updated = await request<{
    booking_id: string;
    status: string;
    confirmation_message: string;
  }>(`/bookings/${booking.booking_id}`, {
    method: "PATCH",
    body: JSON.stringify({
      notes: "Updated by smoke test"
    })
  });
  console.log("updated", updated);

  const cancelled = await request<{
    booking_id: string;
    status: string;
    confirmation_message: string;
  }>(`/bookings/${booking.booking_id}/cancel`, {
    method: "POST",
    body: JSON.stringify({
      reason: "Smoke test cleanup",
      source: "dashboard"
    })
  });
  console.log("cancelled", cancelled);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
