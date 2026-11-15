#!/usr/bin/env node
// Lectern Android-only guard (U-045).
//
//   node apps/android/scripts/check-android-only.mjs
//
// The app ships on Android alone (F§10.4, AGENTS.md §6), and the exclusion has to hold in the repository and
// not only in the code that runs on a device: an `ios` directory, an `ios` key in `app.json`, a `platforms`
// list that is anything but `["android"]`, an `eas.json` (Expo Application Services), or a dependency on the
// update/notification services or on an iOS-only package each fail the check. Zero dependencies: Node
// built-ins only.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IOS_DIRECTORY = "ios";
const EAS_FILE = "eas.json";
const BANNED_DEPENDENCIES = ["expo-updates", "expo-notifications"];
const IOS_SUFFIX = "-ios";
const MANIFEST_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/** Read and parse a JSON file in the app, or report why it could not be read. */
function readJson(name) {
  const path = join(APP_DIR, name);
  if (!existsSync(path)) return { ok: false, detail: `${name} is missing` };
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { ok: false, detail: `${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Every dependency the manifest declares, across the four fields a package manager reads. */
function declaredDependencies(manifest) {
  const declared = [];
  for (const field of MANIFEST_FIELDS) {
    const entries = manifest[field];
    if (entries === undefined || entries === null || typeof entries !== "object") continue;
    for (const name of Object.keys(entries)) declared.push(name);
  }
  return declared;
}

const findings = [];
function check(label, ok, detail) {
  findings.push({ label, ok, detail });
}

// 1. No iOS directory: the native projects come from `expo prebuild --platform android` alone.
check(
  `no ${IOS_DIRECTORY}/ directory`,
  !existsSync(join(APP_DIR, IOS_DIRECTORY)),
  `apps/android/${IOS_DIRECTORY} exists — the app is Android-only`,
);

// 2. No EAS configuration: no account, no over-the-air updates, no build service.
check(`no ${EAS_FILE}`, !existsSync(join(APP_DIR, EAS_FILE)), `${EAS_FILE} exists — this app uses no EAS service`);

// 3. `app.json`: no `ios` key, and `platforms` exactly `["android"]`.
const appJson = readJson("app.json");
if (!appJson.ok) {
  check("app.json is readable", false, appJson.detail);
} else {
  const expo = appJson.value?.expo;
  check(
    "app.json is a valid Expo config",
    expo !== undefined && expo !== null && typeof expo === "object",
    "app.json has no `expo` object",
  );
  if (expo !== undefined && expo !== null && typeof expo === "object") {
    check("app.json declares no `ios` key", !Object.hasOwn(expo, "ios"), "app.json carries an `ios` key — the app is Android-only");
    const platforms = expo.platforms;
    check(
      'app.json `platforms` is exactly ["android"]',
      Array.isArray(platforms) && platforms.length === 1 && platforms[0] === "android",
      `app.json declares platforms ${JSON.stringify(platforms ?? null)}`,
    );
  }
}

// 4. `package.json`: no update or notification service, and nothing whose name says it is iOS-only.
const packageJson = readJson("package.json");
if (!packageJson.ok) {
  check("package.json is readable", false, packageJson.detail);
} else {
  const declared = declaredDependencies(packageJson.value ?? {});
  const banned = declared.filter((name) => BANNED_DEPENDENCIES.includes(name));
  const iosOnly = declared.filter((name) => name.includes(IOS_SUFFIX));
  check(
    `no dependency on ${BANNED_DEPENDENCIES.join(" or ")}`,
    banned.length === 0,
    `package.json declares ${banned.join(", ")} — neither service is part of Lectern`,
  );
  check(
    `no dependency whose name contains ${IOS_SUFFIX}`,
    iosOnly.length === 0,
    `package.json declares ${iosOnly.join(", ")} — the app is Android-only`,
  );
}

let failed = 0;
for (const finding of findings) {
  if (finding.ok) {
    process.stdout.write(`OK      ${finding.label}\n`);
  } else {
    failed += 1;
    process.stdout.write(`FAIL    ${finding.label} — ${finding.detail}\n`);
  }
}

if (failed > 0) {
  process.stderr.write(`check-android-only: ${failed} of ${findings.length} checks failed\n`);
  process.exit(1);
}
process.stdout.write(`check-android-only: ${findings.length} checks pass\n`);
