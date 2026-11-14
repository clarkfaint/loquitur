/**
 * The extension's unit tests.
 *
 * They run against a DOM, because the two modules this unit delivers that touch the platform — the
 * settings record and the message helpers — are written for one: `chrome.storage` holds the settings and
 * a page's `MessageSender` arrives from a browser event. The tests install a small `chrome` double
 * themselves, so nothing here needs a running browser.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  // The extension's own `tsconfig.json` extends the config `wxt prepare` generates, which does not exist on a
  // tree that has never been prepared — and Vite/oxc would refuse every test file with
  // `[TSCONFIG_ERROR] Failed to load tsconfig '.wxt/tsconfig.json'`. The transform therefore reads the
  // repository's base config, which always exists; `wxt prepare` still owns the program `tsc` type-checks.
  tsconfig: "../../tsconfig.base.json",
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
