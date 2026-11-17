/**
 * The browser tests' hub (F§10.1): a real hub — `@lectern/server`'s `buildApp` with F§7.1's mock engine and a
 * temporary data directory — listening on a free port for the whole run, with F§9's own mock LLM endpoint beside
 * it.
 *
 * A hub of the app's own is what makes these tests end-to-end: the settings screen's "Test connection" and its
 * saved-connection probe go over HTTP to a Fastify instance, through the browser's CORS rules, with the same
 * routes the operator's hub serves. The mock engine means no model and no network are needed, and the mock LLM
 * means F§9's summaries can be asked for without a model endpoint either: its address is what F§7.1's
 * `LLM_BASE_URL` names, and the model named below is what every result records.
 *
 * The address and token are written to `e2e/.hub.local` (gitignored) for the helpers to read, and both the
 * socket, the mock endpoint and the temporary directory are released when the run ends.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp, loadConfig } from "@lectern/server";
import { startMockLlm } from "@lectern/server/testing";
import type { FullConfig } from "@playwright/test";

/** The token the test hub shares. F§7.1 requires at least 32 characters; this one is that and nothing else. */
const TOKEN = "e2e-token-0123456789abcdef0123456789";

/** The model F§7.1's `LLM_MODEL` names, which every summary this run makes records as its own. */
export const LLM_MODEL = "lectern-e2e-mock";

/** Where the run's hub address and token are written, beside the specs that read them. */
const HUB_FILE = fileURLToPath(new URL("./.hub.local", import.meta.url));

export default async function globalSetup(_config: FullConfig): Promise<() => Promise<void>> {
  const dataDir = await mkdtemp(join(tmpdir(), "lectern-web-e2e-"));
  const llm = await startMockLlm();
  const config = loadConfig({
    LECTERN_TOKEN: TOKEN,
    LECTERN_ENABLE_MOCK: "1",
    LECTERN_DATA_DIR: dataDir,
    LLM_BASE_URL: llm.baseUrl,
    LLM_MODEL,
  });
  const app = await buildApp(config);
  // Port 0 asks the operating system for a free one, and the bound port is read back rather than guessed: a
  // hard-coded port would collide with whatever else the machine is running.
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("the test hub did not bind a TCP port");

  const baseUrl = `http://127.0.0.1:${address.port}`;
  await writeFile(HUB_FILE, `${JSON.stringify({ baseUrl, token: TOKEN }, null, 2)}\n`, "utf8");

  return async () => {
    await app.close();
    await llm.close();
    await rm(dataDir, { recursive: true, force: true });
  };
}
