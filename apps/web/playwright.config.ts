/**
 * The web app's browser tests (F§10.1, F§13 phase 2). Chromium only, headless, against the *production* build
 * — `vite build` runs before `playwright test` in the unit's verification command, and `vite preview` serves
 * `dist/` — so what the tests drive is what the desktop shell will load from disk (F§10.3).
 *
 * `globalSetup` starts a real hub for the whole run; the app itself is pointed at it from the settings screen,
 * which is the only way in.
 */

import { defineConfig } from "@playwright/test";

/** The port `vite preview` binds; `vite.config.ts` sets the same one with `strictPort`. */
const PORT = 4174;

export default defineConfig({
  testDir: "./e2e",
  // One worker at a time: the tests share one hub and one browser, and the settings screen's state is the
  // browser profile's.
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  globalSetup: "./e2e/global-setup.ts",
  use: {
    browserName: "chromium",
    headless: true,
    baseURL: `http://127.0.0.1:${PORT}`,
    launchOptions: {
      // The reader starts playback from a control, but a test may drive it by script; a browser that demanded
      // a gesture first would make that fail for a reason that has nothing to do with the app.
      args: ["--autoplay-policy=no-user-gesture-required"],
    },
  },
  webServer: {
    command: "vite preview",
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
