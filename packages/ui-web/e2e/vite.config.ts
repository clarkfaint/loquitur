/**
 * The Vite server the sink tests run against (U-024): it serves `e2e/harness`, whose page loads `main.ts`
 * and nothing else. The port is fixed and strict so `playwright.config.ts` can poll a known URL.
 */

import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const harnessRoot = fileURLToPath(new URL("./harness", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

export default defineConfig({
  root: harnessRoot,
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    // The harness imports the workspace packages as source, which lives outside the harness directory.
    fs: { allow: [repositoryRoot] },
  },
});
