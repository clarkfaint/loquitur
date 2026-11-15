/**
 * The end-to-end run's hub (F§10.3, as U-027's is for the web app).
 *
 * A real hub — `@lectern/server`'s `buildApp` with F§7.1's mock engine and a temporary data directory — listening
 * on a free port for the whole run. The shell talks to it over HTTP exactly as the operator's hub would be
 * talked to: the settings screen saves its address and token, the import pipeline posts a document to it, and
 * the player asks it for audio. The mock engine means no model, no GPU and no network are involved.
 *
 * The address and token are written to `e2e/.hub.local`, which is gitignored and which the launch helper reads,
 * and both the socket and the temporary directory are released when the run ends.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp, loadConfig } from "@lectern/server";
import type { FullConfig } from "@playwright/test";

/** The token the test hub shares. F§7.1 requires at least 32 characters; this one is that and nothing else. */
const TOKEN = "desktop-e2e-token-0123456789abcdef0123";

/** Where the run's hub address and token are written, beside the specs that read them. */
const HUB_FILE = fileURLToPath(new URL("./.hub.local", import.meta.url));

export default async function globalSetup(_config: FullConfig): Promise<() => Promise<void>> {
  const dataDir = await mkdtemp(join(tmpdir(), "lectern-desktop-e2e-hub-"));
  const config = loadConfig({ LECTERN_TOKEN: TOKEN, LECTERN_ENABLE_MOCK: "1", LECTERN_DATA_DIR: dataDir });
  const app = await buildApp(config);
  // Port 0 asks the operating system for a free one, and the bound port is read back rather than guessed: a
  // fixed port would collide with whatever else the machine is running.
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("the test hub did not bind a TCP port");

  const baseUrl = `http://127.0.0.1:${address.port}`;
  await writeFile(HUB_FILE, `${JSON.stringify({ baseUrl, token: TOKEN }, null, 2)}\n`, "utf8");

  return async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  };
}
