#!/usr/bin/env node
/**
 * The hub's production bundle (F§12): esbuild turns `src/main.ts` into one ESM file, leaving the native
 * and worker-based packages to be resolved from `node_modules` when the bundle runs.
 *
 * The banner is load-bearing, not decoration. Bundling the hub's CommonJS dependencies (`fastify`,
 * `fastify-plugin`, `@fastify/cors`) into an ESM output leaves esbuild's CommonJS shim looking for a
 * `require` that an ESM file does not have, and the bundle then dies before it listens:
 * `Error: Dynamic require of "node:path" is not supported`. Defining `require` from the bundle's own URL
 * is what makes the same bundle start.
 *
 * Run it from anywhere: the paths below are resolved from this file, not from the working directory.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/** This package's own directory, so `dist/` lands beside the sources whoever runs the script. */
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));

/** The entry point the `dev` script runs through `tsx`. */
const ENTRY_POINT = join(PACKAGE_DIR, "src/main.ts");

/** Where the bundle goes. `dist/` is generated and never committed; esbuild creates the directory. */
const OUT_FILE = join(PACKAGE_DIR, "dist/server.mjs");

/**
 * The packages the bundle must not swallow: the native ones (`better-sqlite3`, `@napi-rs/canvas`) and the
 * worker-based ones (`tesseract.js`, and `pdfjs-dist`, which is imported through its legacy subpath, so
 * the package and its subpaths are both named).
 */
const EXTERNAL = ["better-sqlite3", "@napi-rs/canvas", "tesseract.js", "pdfjs-dist", "pdfjs-dist/*"];

/** The CommonJS shim's `require`, taken from the bundle's own URL. */
const BANNER = [
  'import { createRequire as __lecternCreateRequire } from "node:module";',
  "const require = __lecternCreateRequire(import.meta.url);",
].join("\n");

await build({
  entryPoints: [ENTRY_POINT],
  outfile: OUT_FILE,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: EXTERNAL,
  banner: { js: BANNER },
  logLevel: "info",
});

console.log(`bundled ${OUT_FILE}`);
