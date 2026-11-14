/**
 * The hub's entry point (F§7.1): read the environment, build the hub, listen, and stop when the supervisor
 * asks.
 *
 * The two host globals this file needs are declared here rather than imported: no declaration file for a Node
 * built-in is installed on this host, and the rules forbid adding one. Nothing else in the hub reaches for a
 * global — the rest of the code is handed what it needs — so the entry point is the only place that touches
 * the process it runs in.
 */

import type { FastifyServerOptions } from "fastify";
import { buildApp } from "./app";
import { loadConfig } from "./config";

declare const process: {
  env: Record<string, string | undefined>;
  exit(code: number): void;
  on(event: string, listener: () => void): void;
};

declare const console: {
  error(message: string): void;
  log(message: string): void;
};

/** F§7.1's host: the hub is reached over the operator's own network, so it listens on every interface. */
const HOST = "0.0.0.0";

/** The log the hub writes: the request line and the level, with the one header a token ever travels in removed. */
const LOGGER: FastifyServerOptions["logger"] = { level: "info", redact: ["req.headers.authorization"] };

/** Stop the hub once, however many signals arrive, and leave the process with a success code. */
function shutdownOnce(app: { close(): Promise<void> }): () => void {
  let closing = false;
  return () => {
    if (closing) return;
    closing = true;
    void app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const app = await buildApp(config, { logger: LOGGER });
  const shutdown = shutdownOnce(app);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  await app.listen({ host: HOST, port: config.port });
  console.log(`lectern hub listening on ${HOST}:${config.port}`);
}

void main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exit(1);
});
