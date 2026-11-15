/**
 * The Node test program of `@lectern/store-sql` (AGENTS.md §7).
 *
 * The stores themselves are platform-free — they speak to `SqlDriver` and `BlobFs` — so the whole suite runs
 * in a Node environment over a real in-memory SQLite database, and a device runs the same code through the
 * diagnostics checks `apps/android` registers.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
