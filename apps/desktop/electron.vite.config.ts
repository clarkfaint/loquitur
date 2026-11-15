/**
 * The shell's build (F§10.3).
 *
 * Two bundles come out of here and no third. The main process and the preload script are compiled from this
 * package's own sources; the renderer is the web app's production build, copied in by `scripts/copy-web.mjs`
 * and never rebuilt, which is what keeps one reader UI in the repository instead of two — the shell loads
 * `resources/web/index.html` off disk exactly as `vite build` wrote it.
 *
 * The two bundles are deliberately *not* one format, and that is F§10.3's doing rather than a preference:
 *
 * - the main process is an ES module (`"type": "module"` in `package.json`), which is also what `main` points
 *   at; the bundler supplies the `__dirname` shim an ESM main would otherwise not have.
 * - the preload script must be CommonJS. F§10.3 requires `sandbox: true`, and Chromium loads a sandboxed
 *   preload in a context with no module support at all, so an `import` in that bundle would keep the shell
 *   from starting. It is emitted as `index.cjs` for the same reason: under `"type": "module"` a `.js` file is
 *   an ES module whatever its contents say.
 * - a sandboxed preload may require nothing from `node_modules` either, so `externalizeDeps` is off for it:
 *   the channel names and the schemas that check them are bundled in rather than required. The main bundle is
 *   self-contained for the same reason a package wants one — `out/` plus `resources/` is then the whole
 *   application. Only `electron` stays external in both, which is what the runtime provides.
 */

import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      outDir: "out/main",
      externalizeDeps: false,
    },
  },
  preload: {
    build: {
      outDir: "out/preload",
      externalizeDeps: false,
      rollupOptions: {
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
});
