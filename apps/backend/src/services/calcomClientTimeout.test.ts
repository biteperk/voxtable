/**
 * The Cal.com request deadline must cover the RESPONSE BODY, not just the
 * headers.
 *
 * fetch() resolves as soon as headers arrive. When clearTimeout ran before the
 * body was read, a peer that sent "200 OK" and then stalled left the read
 * hanging forever — no signal, no socket deadline, and no statement_timeout,
 * because no query was in flight. The outbox executor runs inside an open
 * transaction, so that hang wedged the worker permanently while /workerz still
 * answered 200.
 *
 * DB-free: a local HTTP server plays the stalling peer.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test, { after, before } from "node:test";
import type { AddressInfo } from "node:net";

const TIMEOUT_MS = 400;

process.env.APP_ENV ??= "test";
process.env.CALCOM_REQUEST_TIMEOUT_MS = String(TIMEOUT_MS);
process.env.CALCOM_API_KEY ??= "cal_test_key";
process.env.CALCOM_WEBHOOK_SECRET ??= "test-calcom-webhook-secret";

let server: Server;
const openSockets = new Set<import("node:net").Socket>();

before(async () => {
  server = createServer((req, res) => {
    // Headers out immediately, body never finished — the exact shape that used
    // to wedge the worker.
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"partial":');
    // deliberately no res.end()
  });
  server.on("connection", (socket) => {
    openSockets.add(socket);
    socket.on("close", () => openSockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  process.env.CALCOM_BASE_URL = `http://127.0.0.1:${port}`;
});

after(async () => {
  for (const socket of openSockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// The node:test timeout is the real assertion: on the unfixed client this
// case does not fail, it HANGS, and a hanging test is exactly the symptom
// the production bug had. Bound it so CI reports a failure instead.
test("a stalled response body aborts on the deadline instead of hanging forever", { timeout: TIMEOUT_MS * 10 }, async () => {
  const { calcomRequest, CalcomTransientError, resetBreakerForTests } = await import("./calcomClient");
  resetBreakerForTests();

  const startedAt = Date.now();
  await assert.rejects(
    () => calcomRequest({ method: "GET", path: "/stall" }),
    (error: unknown) => {
      assert.ok(
        error instanceof CalcomTransientError,
        `expected a transient error so the outbox retries, got: ${String(error)}`
      );
      assert.match((error as Error).message, /timed out/i);
      return true;
    }
  );

  const elapsed = Date.now() - startedAt;
  // Generous ceiling: the point is that it returns at all, near the deadline,
  // rather than hanging for the life of the process.
  assert.ok(
    elapsed < TIMEOUT_MS * 10,
    `expected the body read to abort near ${TIMEOUT_MS}ms, took ${elapsed}ms`
  );
});
