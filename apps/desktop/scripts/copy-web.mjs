#!/usr/bin/env node
/**
 * Copy the web app's production build into the shell (F§10.3).
 *
 * The shell's renderer is not built here. `apps/web` is the one implementation of the reader UI in the
 * repository, and this script moves what its `vite build` wrote — `index.html`, its hashed assets and the
 * offline worker's precache list — into `resources/web`, which is the directory `src/main/windows/main-window.ts`
 * loads from disk. Rebuilding it inside the desktop package would be a second implementation of the same
 * screens, which is exactly what F§10.3's "consume the built `apps/web/dist`" rules out.
 *
 * The copy is deliberately loud about a missing build: without `apps/web/dist/index.html` there is nothing to
 * show, and a shell that started with a blank window would be far harder to diagnose than an exit code 1 that
 * says which build is missing and how to make it.
 *
 * The copied tree is a build artefact of another package, so it is sat behind its own ignore file and never
 * committed; `resources/icons/` keeps the icons that *are* part of the shell (drawn by `make-icons.mjs`, which
 * the verification command runs), and it sits beside this directory, untouched by this script.
 */

import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** `apps/desktop`, from `apps/desktop/scripts`. */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The web app's build. */
const SOURCE = join(PACKAGE_ROOT, "..", "web", "dist");

/** Where the shell reads its page from. */
const TARGET = join(PACKAGE_ROOT, "resources", "web");

/** The file the copy is only useful with: without it there is no page to load. */
const ENTRY = "index.html";

/**
 * The ignore file left inside the copied tree.
 *
 * `resources/web` is generated on every build from another package's output, so it must never be committed;
 * the rule is written here rather than in the repository's `.gitignore` because it belongs to the directory
 * this script owns — a copy that is deleted and rewritten on every build should carry its own boundary with
 * it. The pattern ignores the file that holds it as well, which is what keeps the directory invisible to git.
 */
const IGNORE = `# Copied from apps/web/dist by scripts/copy-web.mjs — generated, never committed.\n*\n`;

/** Every file under `dir`, as paths relative to it, for the line this script reports. */
async function filesUnder(dir, base = dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(path, base)));
    else found.push(path.slice(base.length + 1));
  }
  return found;
}

/** Whether the web build is there at all. */
async function isBuilt() {
  try {
    await stat(join(SOURCE, ENTRY));
    return true;
  } catch {
    return false;
  }
}

if (!(await isBuilt())) {
  process.stderr.write(
    `the web app is not built: ${join(SOURCE, ENTRY)} is missing.\n` +
      "Build it first — `pnpm --filter @lectern/web run build` — and run this again.\n",
  );
  process.exit(1);
}

await rm(TARGET, { recursive: true, force: true });
await mkdir(TARGET, { recursive: true });
await cp(SOURCE, TARGET, { recursive: true });
await writeFile(join(TARGET, ".gitignore"), IGNORE, "utf8");

const copied = await filesUnder(TARGET);
process.stdout.write(`copied ${copied.length} file(s) from apps/web/dist into resources/web\n`);
