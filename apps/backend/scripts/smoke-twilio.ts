/**
 * Twilio webhook smoke — now able to run against a server with
 * TWILIO_VALIDATE_SIGNATURE=true (staging, production posture).
 *
 * The server validates X-Twilio-Signature over
 * `${PUBLIC_API_BASE_URL}${originalUrl}` + the sorted form params
 * (routes/twilio.ts → twilioService.assertTwilioSignature), so the smoke must
 * sign the EXACT same string: set PUBLIC_API_BASE_URL here to the same value
 * the server runs with — for staging that is the public run.app URL.
 *
 * With TWILIO_AUTH_TOKEN set (the target account's auth token), requests are
 * signed and a tampered-signature negative control asserts a 401 first, so the
 * smoke can't false-pass against a server with validation off. Without it,
 * requests go unsigned — the local-dev mode where validation is off.
 *
 * The To number decides which venue the call logs against — for staging use
 * TWILIO_PHONE_NUMBER=+61468203234 (the staging venue's bound number).
 */
import crypto from "node:crypto";

const baseUrl = process.env.PUBLIC_API_BASE_URL ?? "http://localhost:3050";
const authToken = process.env.TWILIO_AUTH_TOKEN;
const toNumber = process.env.TWILIO_PHONE_NUMBER ?? "+61200000000";

/** Twilio's request-signing scheme: HMAC-SHA1(url + sorted key+value pairs). */
function twilioSign(url: string, params: URLSearchParams, key: string): string {
  const entries = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const data = url + entries.map(([k, v]) => k + v).join("");
  // SHA-1 is not a choice here: it is the algorithm Twilio's X-Twilio-Signature
  // scheme mandates, and the server verifies with the same primitive.
  return crypto.createHmac("sha1", key).update(Buffer.from(data, "utf8")).digest("base64"); // NOSONAR

}

async function request(
  path: string,
  body: URLSearchParams,
  options: { tamper?: boolean } = {}
): Promise<{ status: number; text: string }> {
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded"
  };
  if (authToken) {
    const signature = twilioSign(url, body, authToken);
    headers["x-twilio-signature"] = options.tamper
      ? signature.replace(/.{6}$/, "AAAAAA")
      : signature;
  }
  const response = await fetch(url, { method: "POST", headers, body });
  return { status: response.status, text: await response.text() };
}

async function main(): Promise<void> {
  console.log(`Smoking ${baseUrl} (${authToken ? "signed" : "UNSIGNED — local mode"})`);
  const callSid = `CA${Date.now()}`;
  const params = () =>
    new URLSearchParams({
      CallSid: callSid,
      From: "+61400000002",
      To: toNumber,
      CallStatus: "ringing"
    });

  if (authToken) {
    // Negative control FIRST: a tampered signature must be rejected, proving
    // validation is actually on — otherwise this smoke would false-pass.
    const rejected = await request("/twilio/voice", params(), { tamper: true });
    if (rejected.status !== 401) {
      throw new Error(
        `negative control expected 401 for a tampered signature, got ${rejected.status} — ` +
          `is TWILIO_VALIDATE_SIGNATURE on, and does PUBLIC_API_BASE_URL here match the server's exactly?`
      );
    }
    console.log("negative-control /twilio/voice → 401 (tampered signature rejected) ✓");
  }

  const voice = await request("/twilio/voice", params());
  if (voice.status !== 200 || !voice.text.includes("<Response>") || !voice.text.includes("<Sip")) {
    throw new Error(`Expected TwiML with SIP dial (200), got ${voice.status}: ${voice.text}`);
  }
  console.log("twilio voice twiml ✓", voice.text.slice(0, 120));

  const status = await request(
    "/twilio/status",
    new URLSearchParams({
      CallSid: callSid,
      From: "+61400000002",
      To: toNumber,
      CallStatus: "completed"
    })
  );
  if (status.status >= 400) {
    throw new Error(`status callback failed: ${status.status} ${status.text}`);
  }
  console.log("twilio status callback ✓", callSid);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
