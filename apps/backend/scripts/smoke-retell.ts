import { assertSafeSmokeTarget } from "./lib/smokeTarget";

const baseUrl = process.env.PUBLIC_API_BASE_URL ?? "http://localhost:3050";
assertSafeSmokeTarget(baseUrl);
const restaurantId =
  process.env.DEFAULT_RESTAURANT_ID ?? "11111111-1111-4111-8111-111111111111";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  const text = await response.text();
  const body = text ? (JSON.parse(text) as T) : ({} as T);

  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} failed: ${JSON.stringify(body)}`);
  }

  return body;
}

function getSmokeDate(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 31);
  return date.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const date = getSmokeDate();
  const callId = `retell-smoke-${Date.now()}`;

  const inbound = await request<unknown>("/retell/inbound", {
    method: "POST",
    body: JSON.stringify({
      event: "call_inbound",
      call_inbound: {
        from_number: "+61400000001",
        to_number: process.env.RETELL_PHONE_NUMBER ?? "+61200000000"
      }
    })
  });
  console.log("retell inbound", inbound);

  await request<unknown>("/retell/webhook", {
    method: "POST",
    body: JSON.stringify({
      event: "call_started",
      call: {
        call_id: callId,
        call_type: "phone_call",
        direction: "inbound",
        from_number: "+61400000001",
        to_number: process.env.RETELL_PHONE_NUMBER ?? "+61200000000",
        metadata: { restaurant_id: restaurantId },
        start_timestamp: Date.now()
      }
    })
  });
  console.log("retell call_started", callId);

  const availability = await request<unknown>("/retell/tools/check-availability", {
    method: "POST",
    body: JSON.stringify({
      name: "check_availability",
      call: {
        call_id: callId,
        metadata: { restaurant_id: restaurantId }
      },
      args: {
        restaurant_id: restaurantId,
        date,
        time: "19:00",
        party_size: 2
      }
    })
  });
  console.log("retell availability", availability);

  const booking = await request<unknown>("/retell/tools/create-booking", {
    method: "POST",
    body: JSON.stringify({
      name: "create_booking",
      call: {
        call_id: callId,
        from_number: "+61400000001",
        metadata: { restaurant_id: restaurantId }
      },
      args: {
        restaurant_id: restaurantId,
        customer_name: "Retell Smoke Test",
        customer_phone: "+61400000001",
        date,
        time: "19:00",
        party_size: 2,
        notes: "Created by npm run smoke:retell"
      }
    })
  });
  console.log("retell booking", booking);

  await request<unknown>("/retell/webhook", {
    method: "POST",
    body: JSON.stringify({
      event: "call_ended",
      call: {
        call_id: callId,
        from_number: "+61400000001",
        metadata: { restaurant_id: restaurantId },
        end_timestamp: Date.now(),
        disconnection_reason: "user_hangup",
        transcript: "Agent: Confirmed your booking. User: Thanks.",
        recording_url: "https://example.com/retell-smoke-recording.wav",
        latency: { e2e: { p50: 800 } }
      }
    })
  });
  console.log("retell call_ended", callId);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
