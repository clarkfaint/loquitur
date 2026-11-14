/**
 * What the extension's browser tests need before a case runs: a hub and a page server.
 *
 * The hub is the real one — `@lectern/server` with F§7.1's mock engine and a temporary data directory — because
 * the offscreen document is the context that calls it, and a stubbed hub would not exercise the request the
 * extension actually makes. The page server serves `e2e/pages/` on a port of the operating system's choosing,
 * so a reading case has a page to read without a second browser profile's worth of setup.
 *
 * Both addresses and the run's token are written to `e2e/.env.local` (gitignored: `.gitignore` already ignores
 * `*.local`) for the fixtures to read, and both are released when the run ends.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FullConfig } from "@playwright/test";

/** Where the test pages live, and the only extension this server answers for. */
const PAGES = fileURLToPath(new URL("./pages/", import.meta.url));
const CONTENT_TYPES: Record<string, string> = { html: "text/html; charset=utf-8" };

/** The token the run's hub shares. F§7.1 requires at least 32 characters; this one is that and nothing else. */
const TOKEN = "e2e-extension-token-0123456789abcdef";

/** Where the run's addresses and token are written, beside the specs that read them. */
const ENV_FILE = fileURLToPath(new URL("./.env.local", import.meta.url));

/** What this file needs from the hub package, declared here because the import below is a dynamic one. */
interface HubApp {
  listen(options: { port: number; host: string }): Promise<string>;
  close(): Promise<void>;
  server: { address(): { port: number } | string | null };
}

/** The two hub entry points this file uses. */
interface HubModule {
  loadConfig(env: Record<string, string>): unknown;
  buildApp(config: unknown): Promise<HubApp>;
}

/**
 * The hub package, reached through a *string-typed* specifier.
 *
 * A static `import { buildApp } from "@lectern/server"` would put that package's sources — and with them
 * `packages/core/src/parsers` — into this package's type-check program, which WXT generates to include every
 * file under the package directory. There, `@fastify/cors`'s own node-types reference makes `Buffer` a real type
 * and two frozen parser lines stop compiling (measured; it is U-023's failure mode in a different program). A
 * specifier the compiler cannot follow keeps the program to this package's own graph, and Playwright's loader
 * resolves it at run time, which is what this file needs.
 */
async function hubModule(): Promise<HubModule> {
  const specifier: string = "@lectern/server";
  return (await import(specifier)) as HubModule;
}

/** A server for `e2e/pages/`: one page per request, by name, and nothing else. */
function pageServer(): ReturnType<typeof createServer> {
  return createServer((request, response) => {
    const name = basename(decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname));
    const type = CONTENT_TYPES[name.split(".").pop() ?? ""];
    if (type === undefined) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    void readFile(join(PAGES, name), "utf8").then(
      (body) => {
        response.writeHead(200, { "content-type": type });
        response.end(body);
      },
      () => {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("not found");
      },
    );
  });
}

export default async function globalSetup(_config: FullConfig): Promise<() => Promise<void>> {
  const dataDir = await mkdtemp(join(tmpdir(), "lectern-extension-e2e-"));
  const pages = pageServer();
  await new Promise<void>((resolve) => {
    pages.listen(0, "127.0.0.1", resolve);
  });

  const hub = await hubModule();
  const app = await hub.buildApp(hub.loadConfig({ LECTERN_TOKEN: TOKEN, LECTERN_ENABLE_MOCK: "1", LECTERN_DATA_DIR: dataDir }));
  // Port 0 asks the operating system for a free one: a hard-coded port would collide with whatever else the
  // machine is running, and this hub's address is what the extension is told to talk to.
  await app.listen({ port: 0, host: "127.0.0.1" });

  // The bound ports are read back rather than guessed, and the file is what the fixtures read.
  const addresses = [
    `LECTERN_HUB_URL=http://127.0.0.1:${boundPort(app.server)}`,
    `LECTERN_TOKEN=${TOKEN}`,
    `LECTERN_PAGES_URL=http://127.0.0.1:${boundPort(pages)}`,
  ];
  await writeFile(ENV_FILE, `${addresses.join("\n")}\n`, "utf8");

  return async () => {
    await app.close();
    await new Promise<void>((resolve) => {
      pages.close(() => resolve());
    });
    await rm(dataDir, { recursive: true, force: true });
  };
}

/** The port a server bound, read back rather than guessed. */
function boundPort(server: { address(): { port: number } | string | null }): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("a test server did not bind a TCP port");
  return address.port;
}
