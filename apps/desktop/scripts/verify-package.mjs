#!/usr/bin/env node
/**
 * Check what `dist:linux` produced (F§10.3, F§13 phase 3).
 *
 * The packaging step is the one part of the desktop build that cannot be unit-tested: it writes a directory
 * tree, an archive and two installers, and the only honest check is to open what it wrote and look. This
 * script does that, in the order the application itself would meet it:
 *
 * 1. the unpacked application is there — the executable, the app archive, and the three resource trees the
 *    shell reads at run time (the reader page, the capture overlay, the icons);
 * 2. both installers are there — the AppImage and the `.deb`;
 * 3. nothing that must not ship is in the package — no `targets/`, no source map, no test file — and that is
 *    checked twice, because a packaged application is two trees at once: the loose files beside the archive and
 *    the files *inside* it. Walking only the loose tree would miss everything the archive carries, which is
 *    where a stray test or source map would really hide.
 *
 * Every failure names the path and the command that produces it, because the fix is always the same one and an
 * operator should not have to read this script to find it.
 *
 * Zero dependencies: Node built-ins only.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** `apps/desktop`, from `apps/desktop/scripts`. */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Where electron-builder writes, per `electron-builder.yml`'s `directories.output`. */
const DIST = join(PACKAGE_ROOT, "dist");

/** The unpacked application: the tree the AppImage and the `.deb` are both built from. */
const UNPACKED = join(DIST, "linux-unpacked");

/** The executable, named after `productName` — electron-builder lower-cases it on Linux. */
const EXECUTABLE = join(UNPACKED, "lectern");

/** What the unpacked application must hold, as paths relative to `dist/linux-unpacked`. */
const REQUIRED = [
  "resources/app.asar",
  "resources/web/index.html",
  "resources/overlay/index.html",
  "resources/icons/32.png",
  "resources/icons/512.png",
];

/** The installers, by the suffix electron-builder gives each target. */
const INSTALLERS = [".AppImage", ".deb"];

/** Substrings no path in the package may carry. */
const FORBIDDEN_SEGMENTS = ["targets", ".map", "__tests__"];

/** The command that writes everything this script looks for. */
const REBUILD = "pnpm --filter @lectern/desktop run dist:linux";

const problems = [];
const checked = [];

/** Record one satisfied check, with the size it was found at. */
async function expectFile(path, what) {
  try {
    const found = await stat(path);
    if (!found.isFile()) throw new Error("not a file");
    checked.push(`${what} — ${relative(PACKAGE_ROOT, path)} (${found.size} bytes)`);
    return true;
  } catch (cause) {
    problems.push(`${what} is missing: ${relative(PACKAGE_ROOT, path)} (${cause.message})`);
    return false;
  }
}

/** Every path under `dir`, relative to it, including directories. */
async function pathsUnder(dir, base = dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const label = relative(base, path);
    found.push(label);
    if (entry.isDirectory()) found.push(...(await pathsUnder(path, base)));
  }
  return found;
}

/**
 * The file names inside an asar archive.
 *
 * The format is Chromium's pickle, twice, followed by the files: four bytes holding the length of the outer
 * pickle (`4`), four bytes holding the length of the header pickle, then the header pickle itself — whose own
 * first four bytes are the length of the JSON directory that follows it. Reading that JSON is the whole of it,
 * and it is worth the twenty lines: it is the only way to see what the application *really* carries.
 */
async function archivePaths(archive) {
  const bytes = await readFile(archive);
  const header = bytes.subarray(8, 8 + bytes.readUInt32LE(4));
  const jsonLength = header.readUInt32LE(4);
  const directory = JSON.parse(header.subarray(8, 8 + jsonLength).toString("utf8"));
  if (directory === null || typeof directory !== "object" || typeof directory.files !== "object") {
    throw new Error("the archive's header is not a directory");
  }
  const found = [];
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files)) {
      const path = prefix === "" ? name : `${prefix}/${name}`;
      found.push(path);
      if (entry !== null && typeof entry.files === "object") walk(entry, path);
    }
  };
  walk(directory, "");
  return found;
}

const executable = await expectFile(EXECUTABLE, "the unpacked executable");
if (executable) {
  const mode = (await stat(EXECUTABLE)).mode;
  if ((mode & 0o111) === 0) problems.push(`${EXECUTABLE} is not executable (mode ${mode.toString(8)})`);
}

for (const required of REQUIRED) await expectFile(join(UNPACKED, required), `the package's ${required}`);

for (const suffix of INSTALLERS) {
  let found = null;
  try {
    found = (await readdir(DIST)).filter((name) => name.endsWith(suffix));
  } catch (cause) {
    problems.push(`${relative(PACKAGE_ROOT, DIST)} could not be read (${cause.message})`);
  }
  if (found !== null && found.length === 0) problems.push(`no ${suffix} installer in ${relative(PACKAGE_ROOT, DIST)}`);
  for (const name of found ?? []) checked.push(`installer — dist/${name}`);
}

// What must not ship, in both trees the package is made of.
const loose = await pathsUnder(UNPACKED).catch((cause) => {
  problems.push(`${relative(PACKAGE_ROOT, UNPACKED)} could not be read (${cause.message})`);
  return [];
});
let packed = [];
try {
  packed = await archivePaths(join(UNPACKED, "resources", "app.asar"));
} catch (cause) {
  problems.push(`resources/app.asar could not be read (${cause.message})`);
}
for (const [tree, paths] of [
  ["dist/linux-unpacked", loose],
  ["resources/app.asar", packed],
]) {
  const strays = paths.filter((path) => FORBIDDEN_SEGMENTS.some((segment) => path.includes(segment)));
  if (strays.length > 0) problems.push(`${tree} carries ${strays.length} path(s) that must not ship: ${strays.join(", ")}`);
  else checked.push(`${tree} — ${paths.length} path(s), none carrying ${FORBIDDEN_SEGMENTS.join(", ")}`);
}

for (const line of checked) process.stdout.write(`ok   ${line}\n`);
if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`FAIL ${problem}\n`);
  process.stderr.write(`\nRun \`${REBUILD}\` and this script again.\n`);
  process.exit(1);
}
process.stdout.write(`\n${checked.length} check(s) passed: the package is complete and carries nothing it should not.\n`);
