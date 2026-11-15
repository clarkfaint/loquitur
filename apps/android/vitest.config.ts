/**
 * The Node-side test program of the Android app (AGENTS.md §7).
 *
 * Only the pure modules are tested here — the self-test, the connection store's validation — because a test
 * that reaches `react-native` needs a device or an emulator and belongs to the on-device diagnostics screen
 * that this unit ships. The include list names `src/**` only, so a screen under `app/` is never collected.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
