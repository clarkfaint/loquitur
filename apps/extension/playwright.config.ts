/**
 * The extension's browser tests (F§10.2, F§13 phase 2). Chromium only, against the *built* extension —
 * `wxt build` runs before `playwright test` in the unit's verification command — so what the tests load is the
 * package that ships, not a development bundle.
 *
 * The launch shape is the fixture's, not this file's: every case needs a *persistent* context with the
 * extension loaded (`--load-extension`), which is a context the fixture creates itself, in
 * `e2e/fixtures.ts`. What is here is the part Playwright itself owns: one worker, a real hub for the run, and
 * a generous timeout, because these cases play real audio in a real browser.
 */

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // One worker: the cases share one browser profile and one hub, and the extension's state — the settings a
  // case writes, the document it has started reading — is the profile's.
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 90_000,
  use: {
    browserName: "chromium",
  },
});
