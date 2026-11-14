/**
 * The browser test rig for `@lectern/ui-web` (U-024). Chromium only, headless, started against a Vite
 * server whose root is the harness page — the sink's own timings are the browser's, so the tests drive a
 * real one instead of a stub that models it.
 */

import { defineConfig } from "@playwright/test";

/** The port `e2e/vite.config.ts` binds; `strictPort` makes a clash a failure rather than a surprise. */
const PORT = 4173;

export default defineConfig({
  testDir: "./e2e",
  // The timing cases measure wall time, so one worker at a time keeps the machine quiet.
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    browserName: "chromium",
    headless: true,
    baseURL: `http://127.0.0.1:${PORT}`,
    launchOptions: {
      // The sink is driven by script, not by a click: autoplay must not need a gesture.
      args: ["--autoplay-policy=no-user-gesture-required"],
    },
  },
  webServer: {
    command: "vite --config e2e/vite.config.ts",
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
