/**
 * The web app's build (F§10.1): a hash-routed single-page app whose assets are addressed relatively.
 *
 * `base: "./"` is what lets the desktop shell load this same build from disk (F§10.3): an absolute
 * `/assets/...` URL would resolve against the file system root instead of beside `index.html`. The
 * `preview` block is the server the browser tests run against (F§13's phase 2), pinned to one port so a
 * stale server on it fails the run instead of being silently reused.
 */

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The port `vite preview` binds for the browser tests. */
const PREVIEW_PORT = 4174;

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist" },
  preview: { host: "127.0.0.1", port: PREVIEW_PORT, strictPort: true },
});
