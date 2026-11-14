/**
 * The unit tests' environment (F§10.1): a DOM, because the shell, the router and the settings all read and
 * write one — `localStorage`, `location.hash`, `document.documentElement`. The tests themselves are ordinary
 * TypeScript: nothing here mounts a component, so they stay deterministic and fast.
 */

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
