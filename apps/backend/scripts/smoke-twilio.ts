const baseUrl = process.env.PUBLIC_API_BASE_URL ?? "http://localhost:3050";

async function request(path: string, body: URLSearchParams): Promise<string> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`POST ${path} failed: ${text}`);
  }

  return text;
}

async function main(): Promise<void> {
  const callSid = `CA${Date.now()}`;

  const twiml = await request(
    "/twilio/voice",
    new URLSearchParams({
      CallSid: callSid,
      From: "+61400000002",
      To: process.env.TWILIO_PHONE_NUMBER ?? "+61200000000",
      CallStatus: "ringing"
    })
  );

  if (!twiml.includes("<Response>") || !twiml.includes("<Sip>")) {
    throw new Error(`Expected TwiML with SIP dial, received: ${twiml}`);
  }

  console.log("twilio voice twiml", twiml);

  await request(
    "/twilio/status",
    new URLSearchParams({
      CallSid: callSid,
      From: "+61400000002",
      To: process.env.TWILIO_PHONE_NUMBER ?? "+61200000000",
      CallStatus: "completed"
    })
  );

  console.log("twilio status callback", callSid);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
