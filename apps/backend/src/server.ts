import { env } from "./config/env";
import { createApp } from "./app";
import { closePool } from "./db/pool";

const app = createApp();
const server = app.listen(env.PORT, () => {
  console.log(`VocoTable backend listening on port ${env.PORT}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}. Shutting down.`);
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
