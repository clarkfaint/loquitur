#!/usr/bin/env node
// Lectern release-APK permission audit (U-053, F§10.4, F§11).
//
//   node apps/android/scripts/audit-apk.mjs [path/to/app-release.apk]
//
// F§10.4 fixes the permissions the Android app may ask for — network, a media-playback foreground service,
// notifications, a wake lock and the camera — and blocks the microphone and the external-storage permissions in
// `app.json`. The *shipped* APK's manifest is the merge of the app's own generated manifest with every linked
// Android library's manifest, so a permission can reach the shipped app from a dependency that no file in this
// repository names. That is why this reads the built APK, through the SDK's own `aapt2 dump badging` (or
// `apkanalyzer manifest permissions` when `aapt2` cannot be found), and not the configuration it was built
// from.
//
// Exit 0 only when the package is `dev.lectern.app` and every `uses-permission` is either one of the eight the
// contract's allowlist names, or a permission the app declares for itself — a name namespaced to the
// application id, which is how the Android manifest merger names a library's signature-level permission (this
// app's own is `dev.lectern.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`, `protectionLevel=signature`).
// Anything else is listed and the exit is 1, with the six categories the contract names called out by name.
//
// Zero dependencies: Node built-ins only.

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const USAGE = "Usage: node apps/android/scripts/audit-apk.mjs [path/to/app-release.apk]";
const DEFAULT_APK = "apps/android/android/app/build/outputs/apk/release/app-release.apk";
const TOOL_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** F§10.4's package id: the one application this audit accepts. */
const PACKAGE_NAME = "dev.lectern.app";

/** F§10.4's permission set, as the contract's allowlist spells it. */
const ALLOWED_PERMISSIONS = [
  "android.permission.INTERNET",
  "android.permission.ACCESS_NETWORK_STATE",
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK",
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.WAKE_LOCK",
  "android.permission.CAMERA",
  "android.permission.VIBRATE",
];

/**
 * The categories the contract names as failures by name. Every one of them is outside the allowlist anyway, so
 * this table only decides how the offending permission is *described* — a named category is a clearer sentence
 * than "not in the allowlist" for the reader of a failed run.
 */
const FORBIDDEN_CATEGORIES = [
  { category: "microphone", names: ["android.permission.RECORD_AUDIO"] },
  { category: "billing", names: ["com.android.vending.BILLING", "com.android.vending.CHECK_LICENSE"] },
  { category: "advertising identifier", names: ["com.google.android.gms.permission.AD_ID"] },
  {
    category: "location",
    names: [
      "android.permission.ACCESS_FINE_LOCATION",
      "android.permission.ACCESS_COARSE_LOCATION",
      "android.permission.ACCESS_BACKGROUND_LOCATION",
    ],
  },
  {
    category: "contacts",
    names: ["android.permission.READ_CONTACTS", "android.permission.WRITE_CONTACTS", "android.permission.GET_ACCOUNTS"],
  },
  {
    category: "external storage",
    names: [
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.WRITE_EXTERNAL_STORAGE",
      "android.permission.MANAGE_EXTERNAL_STORAGE",
      "android.permission.READ_MEDIA_AUDIO",
      "android.permission.READ_MEDIA_IMAGES",
      "android.permission.READ_MEDIA_VIDEO",
    ],
  },
];

const PACKAGE_LINE = /^package: name='([^']+)'/mu;
const USES_PERMISSION_LINE = /^uses-permission(?:-sdk-\d+)?: name='([^']+)'/gmu;

/** One line on stdout, every one of them prefixed so a run can be grepped. */
function say(line) {
  process.stdout.write(`${line}\n`);
}

/** One line on stderr, for the reason a run refused. */
function complain(line) {
  process.stderr.write(`${line}\n`);
}

/** Whether a path is a file this process may execute. */
function executableAt(path) {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** A program of this name from `PATH`, or `null`. */
function onPath(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    if (executableAt(candidate)) return candidate;
  }
  return null;
}

/**
 * The Android SDK the audit reads its tools out of. `ANDROID_HOME` first and `ANDROID_SDK_ROOT` beside it —
 * the two names `scripts/preflight.mjs`'s phase-4 check reads — with this host's own default behind both.
 */
function sdkRoot() {
  const named = (process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? "").trim();
  return named === "" ? join(homedir(), "android-sdk") : named;
}

/** The newest `aapt2` the SDK holds, else one from `PATH`. */
function findAapt2() {
  const buildTools = join(sdkRoot(), "build-tools");
  if (existsSync(buildTools)) {
    const versions = readdirSync(buildTools)
      .filter((entry) => executableAt(join(buildTools, entry, "aapt2")))
      .sort();
    const newest = versions.at(-1);
    if (newest !== undefined) return join(buildTools, newest, "aapt2");
  }
  return onPath("aapt2");
}

/** `apkanalyzer` from the SDK's command-line tools, else one from `PATH`. */
function findApkanalyzer() {
  const bundled = join(sdkRoot(), "cmdline-tools", "latest", "bin", "apkanalyzer");
  if (executableAt(bundled)) return bundled;
  return onPath("apkanalyzer");
}

/** Run a program and answer its output and whether it succeeded. */
function run(program, args) {
  const result = spawnSync(program, args, { encoding: "utf8", timeout: TOOL_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES });
  if (result.error !== undefined) return { ok: false, detail: result.error.message, text: "" };
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0)
    return { ok: false, detail: `${program} exited ${result.status}: ${text.trim().split("\n").at(-1) ?? ""}`, text };
  return { ok: true, detail: null, text };
}

/** The APK's package id and permission list, read with `aapt2 dump badging`. */
function readWithAapt2(program, apk) {
  const result = run(program, ["dump", "badging", apk]);
  if (!result.ok) return { ok: false, detail: result.detail };
  const packageLine = PACKAGE_LINE.exec(result.text);
  const permissions = [...result.text.matchAll(USES_PERMISSION_LINE)].map((match) => match[1]);
  return { ok: true, packageName: packageLine === null ? null : packageLine[1], permissions };
}

/** The APK's package id and permission list, read with `apkanalyzer manifest …`. */
function readWithApkanalyzer(program, apk) {
  const id = run(program, ["manifest", "application-id", apk]);
  if (!id.ok) return { ok: false, detail: id.detail };
  const permissions = run(program, ["manifest", "permissions", apk]);
  if (!permissions.ok) return { ok: false, detail: permissions.detail };
  const packageName = id.text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)[0];
  return {
    ok: true,
    packageName: packageName ?? null,
    permissions: permissions.text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  };
}

/** The category a permission belongs to, or `null` when the contract names none for it. */
function categoryOf(permission) {
  for (const entry of FORBIDDEN_CATEGORIES) {
    if (entry.names.includes(permission)) return entry.category;
  }
  return null;
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    say(USAGE);
    return 0;
  }

  const named = argv.find((argument) => !argument.startsWith("-"));
  const apk = resolve(named ?? DEFAULT_APK);
  if (!existsSync(apk)) {
    complain(`audit-apk: ${apk} does not exist — build the release variant first (./gradlew :app:assembleRelease)`);
    return 1;
  }

  // `aapt2` first, `apkanalyzer` behind it: the contract names both, and `aapt2` is the one the SDK's
  // build-tools always carries.
  const aapt2 = findAapt2();
  const apkanalyzer = aapt2 === null ? findApkanalyzer() : null;
  if (aapt2 === null && apkanalyzer === null) {
    complain(
      `audit-apk: no aapt2 in ${join(sdkRoot(), "build-tools")} and no apkanalyzer in ${join(sdkRoot(), "cmdline-tools")}, and neither is on PATH — set ANDROID_HOME`,
    );
    return 1;
  }

  const read = aapt2 === null ? readWithApkanalyzer(apkanalyzer, apk) : readWithAapt2(aapt2, apk);
  if (!read.ok) {
    complain(`audit-apk: the APK's manifest could not be read — ${read.detail}`);
    return 1;
  }

  const tool = aapt2 === null ? apkanalyzer : aapt2;
  const permissions = [...new Set(read.permissions)].sort();
  say(`audit-apk: ${read.packageName ?? "no package"} · ${permissions.length} uses-permission entries · read with ${tool}`);

  const allowed = new Set(ALLOWED_PERMISSIONS);
  const outside = [];
  for (const permission of permissions) {
    if (allowed.has(permission)) {
      say(`audit-apk: allowed   ${permission}`);
      continue;
    }
    if (read.packageName !== null && permission.startsWith(`${read.packageName}.`)) {
      say(`audit-apk: own       ${permission} (namespaced to this app, so declared by the app itself)`);
      continue;
    }
    outside.push(permission);
    const category = categoryOf(permission);
    const because = category === null ? "not in F§10.4's allowlist" : `${category}, which F§10.4 blocks`;
    say(`audit-apk: OUTSIDE   ${permission} — ${because}`);
  }

  if (read.packageName !== PACKAGE_NAME) {
    complain(`audit-apk: the APK's package is ${read.packageName ?? "unreadable"}, not ${PACKAGE_NAME} (F§10.4)`);
    return 1;
  }

  if (outside.length > 0) {
    complain(`audit-apk: ${outside.length} of ${permissions.length} permissions are outside F§10.4's allowlist — ${outside.join(", ")}`);
    return 1;
  }

  say(`audit-apk: ${PACKAGE_NAME} declares only F§10.4's permissions (${permissions.length} checked)`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
