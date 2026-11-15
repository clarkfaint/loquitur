/**
 * The shell's end-to-end run (F§10.3, F§13 phase 3).
 *
 * There is no `webServer` here and no browser: the app under test is the Electron shell itself, launched with
 * Playwright's `_electron` against the *built* `out/main/index.js` and the *copied* `resources/web` — so what
 * the cases drive is exactly what the packaging step would ship. The hub is the one `globalSetup` starts with
 * F§7.1's mock engine, which means no model and no network are needed.
 *
 * One worker, because the cases share one Electron application, one hub and one user-data directory, and a
 * shell is a single-instance program by construction: two of them in parallel would be testing the lock rather
 * than the app.
 */

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  globalSetup: "./e2e/global-setup.ts",
  // Playback is real audio in a real application, and the first launch of an Electron binary is the slowest
  // thing in the run.
  timeout: 120_000,
  expect: { timeout: 20_000 },
});
