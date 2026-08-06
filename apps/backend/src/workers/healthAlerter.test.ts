/**
 * The pure halves of the business-outcome alerts.
 *
 * serviceProgressNow feeds the "zero calls during trading hours" alert; a
 * wrong answer either pages a closed restaurant at 7am or stays silent while
 * the phone line is dead through Saturday dinner service. The overnight
 * cases matter most — a venue open 18:00–02:00 is mid-service at half past
 * midnight, and the naive "is now between open and close" comparison says
 * it's closed.
 *
 * pingHeartbeat is the dead-man's switch; the test proves a real GET lands.
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { pingHeartbeat, serviceProgressNow } from "./healthAlerter";

const SYDNEY = "Australia/Sydney";

// 2026-08-06 is a Thursday. 09:00 UTC = 19:00 AEST (winter, UTC+10).
const THURSDAY_1900_LOCAL = new Date("2026-08-06T09:00:00Z");
const THURSDAY_0030_LOCAL = new Date("2026-08-05T14:30:00Z"); // Thu 00:30 AEST

const DAY_HOURS = { thursday: [{ open: "10:00", close: "23:00" }] };
const OVERNIGHT = {
  wednesday: [{ open: "18:00", close: "02:00" }],
  thursday: [{ open: "18:00", close: "02:00" }]
};

test("mid-service returns hours since open", () => {
  const progress = serviceProgressNow(DAY_HOURS, SYDNEY, THURSDAY_1900_LOCAL);
  assert.ok(progress);
  assert.equal(progress.hoursIntoService, 9);
  assert.equal(progress.serviceOpenDate, "2026-08-06");
  assert.equal(progress.serviceOpenTime, "10:00");
});

test("before open and after close return null", () => {
  const beforeOpen = new Date("2026-08-05T22:00:00Z"); // Thu 08:00 AEST
  assert.equal(serviceProgressNow(DAY_HOURS, SYDNEY, beforeOpen), null);
  const afterClose = new Date("2026-08-06T13:30:00Z"); // Thu 23:30 AEST
  assert.equal(serviceProgressNow(DAY_HOURS, SYDNEY, afterClose), null);
});

test("no configured hours (the {} column default) never counts as in service", () => {
  assert.equal(serviceProgressNow({}, SYDNEY, THURSDAY_1900_LOCAL), null);
  assert.equal(
    serviceProgressNow({ friday: [{ open: "10:00", close: "23:00" }] }, SYDNEY, THURSDAY_1900_LOCAL),
    null
  );
});

test("the evening leg of an overnight window counts from today's open", () => {
  const progress = serviceProgressNow(OVERNIGHT, SYDNEY, THURSDAY_1900_LOCAL);
  assert.ok(progress);
  assert.equal(progress.hoursIntoService, 1);
  assert.equal(progress.serviceOpenDate, "2026-08-06");
});

test("half past midnight belongs to YESTERDAY'S overnight service", () => {
  const progress = serviceProgressNow(OVERNIGHT, SYDNEY, THURSDAY_0030_LOCAL);
  assert.ok(progress);
  assert.equal(progress.hoursIntoService, 6.5);
  assert.equal(progress.serviceOpenDate, "2026-08-05");
  assert.equal(progress.serviceOpenTime, "18:00");
});

test("a degenerate open==close window is closed, not 24h open", () => {
  assert.equal(
    serviceProgressNow({ thursday: [{ open: "10:00", close: "10:00" }] }, SYDNEY, THURSDAY_1900_LOCAL),
    null
  );
});

test("pingHeartbeat performs a real GET against the configured URL", async () => {
  let hits = 0;
  const server = http.createServer((_request, response) => {
    hits += 1;
    response.writeHead(200);
    response.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await pingHeartbeat(`http://127.0.0.1:${address.port}/ping`);
    assert.equal(hits, 1);
  } finally {
    server.close();
  }
});

test("pingHeartbeat with no URL is a no-op, and a dead endpoint never throws", async () => {
  await pingHeartbeat(undefined);
  // Port 1 refuses connections — the alerter tick must survive that.
  await pingHeartbeat("http://127.0.0.1:1/ping");
});
