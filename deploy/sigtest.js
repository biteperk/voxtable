// Server-side Retell signature self-test. Runs INSIDE the api container so it
// reads RETELL_WEBHOOK_SECRET from the process env (secret never leaves the box).
// Signs a payload with the SDK's exact scheme (HMAC-SHA256 over body+timestamp,
// format "v=<ms>,d=<hex>") and POSTs it to the local webhook endpoint.
//   GOOD signature  -> must NOT be 401 (verification accepts the webhook secret)
//   BAD  signature  -> must be 401     (verification is actually enforced)
const crypto = require("crypto");

const secret = process.env.RETELL_WEBHOOK_SECRET;
if (!secret) {
  console.log("RESULT NO_SECRET_IN_ENV");
  process.exit(2);
}

const body = JSON.stringify({ event: "__selftest__" });
const ts = Date.now();
const digest = crypto.createHmac("sha256", secret).update(body + ts).digest("hex");
const goodSig = `v=${ts},d=${digest}`;
const badSig = `v=${ts},d=${"0".repeat(64)}`;

(async () => {
  const post = (sig) =>
    fetch("http://localhost:3050/retell/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-retell-signature": sig },
      body
    }).then((r) => r.status);

  const good = await post(goodSig);
  const bad = await post(badSig);
  console.log("GOOD_SIG_STATUS", good);
  console.log("BAD_SIG_STATUS", bad);
  console.log(
    "RESULT",
    good !== 401 && bad === 401 ? "PASS (verify accepts webhook secret, rejects bad)" : "FAIL"
  );
})().catch((e) => {
  console.log("RESULT ERROR", e.message);
  process.exit(1);
});
