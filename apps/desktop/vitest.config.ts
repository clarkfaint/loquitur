/**
 * The shell's unit tests: Node, because everything they exercise is main-process code — a record read from and
 * written to a file, and the channel table that validates what crosses the renderer boundary. Nothing here
 * mounts a window or starts an application; the end-to-end suite does that.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
