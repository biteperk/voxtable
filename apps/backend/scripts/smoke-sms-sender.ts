/**
 * SMS sender preflight — reads the Twilio Messaging Service config BACK from the
 * API, then optionally proves one real delivery.
 *
 * Two project rules make this script necessary rather than nice to have:
 * "read config back from the API after writing it, never trust the write
 * response", and "'enabled' is not 'works'". Both platform numbers have
 * reported SMS enabled since 13 Aug 2026 and neither has ever sent a message.
 *
 * DEFAULT MODE IS READ-ONLY and sends nothing, so it is safe against production.
 *
 *   TWILIO_ACCOUNT_SID=AC… TWILIO_AUTH_TOKEN=… \
 *   NOTIFICATIONS_MESSAGING_SERVICE_SID=MG… \
 *   npm run smoke:sms-sender --workspace=@voxtable/backend
 *
 * Send mode costs money and texts a real handset, so it is behind an explicit
 * flag rather than a bare argument:
 *
 *   SMS_SEND_TEST=true SMS_TEST_TO=+61… npm run smoke:sms-sender …
 *
 * Send mode does NOT stop at `messages.create` resolving — that returns
 * `queued`/`accepted`, which is proof that Twilio accepted the request and
 * nothing more. It polls the Message resource until a terminal status and
 * asserts `delivered`.
 */
import twilio from "twilio";

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const serviceSid = process.env.NOTIFICATIONS_MESSAGING_SERVICE_SID;
const expectedAlphaSender = process.env.EXPECTED_ALPHA_SENDER ?? "BitePerk";
const sendTest = process.env.SMS_SEND_TEST === "true";
const testTo = process.env.SMS_TEST_TO;
const STAGING_ACCOUNT_SID = "AC8116857da2064ef3251533f3ade56f32";

const DELIVERY_POLL_TIMEOUT_MS = 60_000;
const DELIVERY_POLL_INTERVAL_MS = 2_000;
/** Statuses Twilio will not move off on its own. */
const TERMINAL_STATUSES = new Set(["delivered", "undelivered", "failed", "canceled"]);

let failures = 0;

function pass(message: string): void {
  console.log(`  ok    ${message}`);
}

function fail(message: string): void {
  failures += 1;
  console.error(`  FAIL  ${message}`);
}

function info(message: string): void {
  console.log(`  ..    ${message}`);
}

function requireEnv(): void {
  const missing = [
    ["TWILIO_ACCOUNT_SID", accountSid],
    ["TWILIO_AUTH_TOKEN", authToken],
    ["NOTIFICATIONS_MESSAGING_SERVICE_SID", serviceSid]
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    console.error(`Missing required env: ${missing.join(", ")}`);
    process.exit(2);
  }
  if (sendTest && !testTo) {
    console.error("SMS_SEND_TEST=true requires SMS_TEST_TO (E.164, e.g. +61400000000)");
    process.exit(2);
  }
  if (sendTest && accountSid !== STAGING_ACCOUNT_SID) {
    console.error("SMS send mode is staging-only; production permits read-back mode only.");
    process.exit(2);
  }
}

async function main(): Promise<void> {
  requireEnv();
  const client = twilio(accountSid as string, authToken as string);

  console.log(`\nMessaging Service ${serviceSid} on account ${accountSid}\n`);

  // 1. The service exists, and belongs to the account we think we are on.
  const service = await client.messaging.v1.services(serviceSid as string).fetch();
  info(`friendly name: ${service.friendlyName}`);
  if (service.accountSid === accountSid) {
    pass(`service belongs to ${accountSid}`);
  } else {
    // The cross-environment guard. Staging and production each have their own
    // Messaging Service, and the SIDs differ only in the middle — a copy-paste
    // between Terraform env maps would otherwise route real customer messages
    // out of the wrong account, silently and correctly-looking.
    fail(
      `service belongs to ${service.accountSid}, NOT the configured ${accountSid} — ` +
        `wrong environment's Messaging Service SID`
    );
  }

  // 2. Sender pool: alphanumeric senders.
  const alphaSenders = await client.messaging.v1
    .services(serviceSid as string)
    .alphaSenders.list({ limit: 50 });
  const alphaNames = alphaSenders.map((s) => s.alphaSender);
  info(`alphanumeric senders: ${alphaNames.length > 0 ? alphaNames.join(", ") : "(none)"}`);
  // Case-sensitive on purpose: Twilio treats a case-mismatched sender as
  // UNREGISTERED (error 30041), not as a near-miss worth correcting.
  const brandedPresent = alphaNames.includes(expectedAlphaSender);
  if (brandedPresent) {
    pass(`"${expectedAlphaSender}" is in the sender pool — messages will be branded`);
  } else {
    const caseInsensitiveHit = alphaNames.find(
      (n) => n.toLowerCase() === expectedAlphaSender.toLowerCase()
    );
    if (caseInsensitiveHit) {
      fail(
        `sender pool has "${caseInsensitiveHit}" but expected exactly "${expectedAlphaSender}" — ` +
          `matching is case-sensitive, this sends as unregistered (error 30041)`
      );
    } else {
      info(
        `"${expectedAlphaSender}" not in the pool — messages send from the number. ` +
          `Expected before the console step; a finding after it.`
      );
    }
  }

  // 3. Sender pool: phone numbers, which are the fallback.
  const phoneNumbers = await client.messaging.v1
    .services(serviceSid as string)
    .phoneNumbers.list({ limit: 50 });
  const numbers = phoneNumbers.map((n) => n.phoneNumber);
  info(`phone numbers: ${numbers.length > 0 ? numbers.join(", ") : "(none)"}`);
  if (numbers.length > 0) {
    pass(`${numbers.length} number(s) in the pool as fallback`);
  } else if (brandedPresent) {
    // The whole reason we chose a Messaging Service over a bare alphanumeric
    // `from` was the automatic fallback. An alpha-only pool throws that away and
    // fails outright wherever alphanumeric senders are unsupported.
    fail(
      "pool has an alphanumeric sender but NO phone number — there is no fallback, " +
        "so sends to destinations without alphanumeric support will fail outright"
    );
  } else {
    fail("pool is empty — this service cannot send anything");
  }

  // 4. Send mode: prove delivery, not acceptance.
  if (!sendTest) {
    console.log("\nRead-only mode. Set SMS_SEND_TEST=true SMS_TEST_TO=+61… to prove delivery.");
  } else {
    console.log(`\nSending one test message to ${testTo} …`);
    const created = await client.messages.create({
      to: testTo as string,
      body: `VoxTable sender preflight ${new Date().toISOString()}. Do not reply to this message.`,
      messagingServiceSid: serviceSid as string
    });
    info(`message ${created.sid} created with status "${created.status}"`);

    const deadline = Date.now() + DELIVERY_POLL_TIMEOUT_MS;
    let message = created;
    while (!TERMINAL_STATUSES.has(message.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, DELIVERY_POLL_INTERVAL_MS));
      message = await client.messages(created.sid).fetch();
      info(`status: ${message.status}`);
    }

    info(`final sender shown to Twilio: ${message.from ?? "(alphanumeric)"}`);
    if (message.errorCode) {
      fail(`error ${message.errorCode}: ${message.errorMessage ?? "no message"}`);
    }
    if (message.status === "delivered") {
      pass("delivered — carrier confirmed receipt");
    } else if (message.status === "sent") {
      // Not a pass: "sent" means the carrier accepted it and no delivery receipt
      // came back inside the window. Common, but it is not proof of arrival.
      fail(`stopped at "sent" — no delivery receipt within ${DELIVERY_POLL_TIMEOUT_MS / 1000}s`);
    } else {
      fail(`final status "${message.status}" is not "delivered"`);
    }
    console.log("\nCheck the handset: the sender should read as the brand, with no Unverified stamp.");
  }

  console.log("");
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("All checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
