/**
 * The web app's build (F§10.1): a hash-routed single-page app whose assets are addressed relatively.
 *
 * `base: "./"` is what lets the desktop shell load this same build from disk (F§10.3): an absolute
 * `/assets/...` URL would resolve against the file system root instead of beside `index.html`. The
 * `preview` block is the server the browser tests run against (F§13's phase 2), pinned to one port so a
 * stale server on it fails the run instead of being silently reused.
 *
 * The second plugin is the app's own: the service worker that keeps the shell cannot know what a build
 * emitted, so the build tells it, in a file beside the worker (F§10.1).
 */

import { readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** The port `vite preview` binds for the browser tests. */
const PREVIEW_PORT = 4174;

/** The file list `apps/web/public/sw.js` precaches on install. */
const MANIFEST_NAME = "precache-manifest.json";

/** Every file under `dir`, as paths relative to `root` — the whole output tree, not just its top level. */
function outputFiles(root: string, dir: string = root): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...outputFiles(root, path));
    else if (entry.name !== MANIFEST_NAME) found.push(`./${relative(root, path).split(sep).join("/")}`);
  }
  return found;
}

/**
 * `precacheManifest()` — write `dist/precache-manifest.json`: every file the build left in the output
 * directory, the shell included, as paths relative to the app's root.
 *
 * The list is read in `closeBundle`, which is the last moment of a build and therefore the only one at which
 * "every emitted file" is a settled set — the bundle object itself is not enough, because `index.html` is
 * written by the build around the bundle rather than inside it, and the shell is the one file the worker
 * cannot do without. Only the list itself is left out: it is what is being written.
 */
function precacheManifest(): Plugin {
  let outDir = "";
  return {
    name: "lectern-precache-manifest",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const manifest = { files: outputFiles(outDir).sort() };
      writeFileSync(join(outDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    },
  };
}

export default defineConfig({
  plugins: [react(), precacheManifest()],
  base: "./",
  build: { outDir: "dist" },
  preview: { host: "127.0.0.1", port: PREVIEW_PORT, strictPort: true },
});
