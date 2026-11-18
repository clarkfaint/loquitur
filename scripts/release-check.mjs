#!/usr/bin/env node
// Lectern release check (U-067): every platform's verification, in one run, with a record.
//
//   node scripts/release-check.mjs [--device] [--docker]
//
// The steps run in the order the release unit fixes: the workspace's own lint, type check and test tasks; the
// four guard scripts; each app's build and end-to-end suite; the Android host checks (its Vitest suite, its type
// check, the Android-only guard and the Hermes bundle export); and finally `scripts/e2e-cross-device.mjs`, which
// proves F§8's and F§9's behaviour between two devices. `--device` adds the Android device scripts, which drive
// the operator's own phone through `adb`; `--docker` adds U-022's real-engine smoke test over the compose stack.
//
// A step whose prerequisites are absent — no phone attached, no Docker, not requested — is recorded as
// `SKIPPED` with the reason rather than silently omitted, so `docs/release-check.json` says what was and was not
// exercised on this host. The run exits 1 if any step that ran failed.
//
// Zero dependencies: Node built-ins only (this file is in `scripts/`, which R10 admits no dependency for).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root: this file lives in `<root>/scripts`. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the run's record is written (the contract's own path). */
const REPORT_PATH = join(REPO_ROOT, "docs", "release-check.json");

/** The unit this run is the release check of, recorded so the report can name it. */
const UNIT = "U-067";

/** How many lines of a step's own output the record keeps. */
const TAIL_LINES = 12;

/** How much output one step may produce before the child's pipes are full (the web e2e suite is verbose). */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const USAGE = "Usage: node scripts/release-check.mjs [--device] [--docker]";

/** The three states a step can be recorded in: the contract's own three words. */
const PASS = "PASS";
const FAIL = "FAIL";
const SKIPPED = "SKIPPED";

/** The token U-022's smoke test authenticates with, read from `infra/.env` the way that unit's chain reads it. */
const ENV_FILE = join(REPO_ROOT, "infra", ".env");

/** The Android application id the device harness installs and clears. */
const ANDROID_PACKAGE = "dev.lectern.app";

/** The harness's own scratch directory, which `.gitignore` already excludes as runtime data. */
const DEVICE_RUN_DIR = join(REPO_ROOT, "data", "device-run");

/** A step's last lines of output, with the terminal control sequences a tool may emit stripped out. */
function tailOf(text) {
  const lines = text
    .replaceAll("\u001b", "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");
  return lines.slice(Math.max(0, lines.length - TAIL_LINES));
}

/** Whether an executable answers on this host, and what it says. */
function probe(command, args) {
  const result = spawnSync(command, args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES });
  return { found: result.error === undefined && result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

/** The device `adb` is talking to, resolved from the platform rather than written down anywhere. */
function resolveDeviceSerial() {
  const listed = spawnSync("adb", ["devices", "-l"], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES });
  if (listed.error !== undefined) return null;
  const attached = (listed.stdout ?? "")
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => line.split(/\s+/))
    .filter((fields) => fields[1] === "device")
    .map((fields) => fields[0]);
  if (attached.length === 0) return null;
  // One phone can be listed twice — its `host:port` transport and its mDNS name are the same device — and a
  // bare `adb` command then fails with "more than one device", so a serial is always chosen and handed on.
  return attached.find((serial) => serial.includes(":")) ?? attached[0];
}

/** Whether the Android host checks can run at all: the app package and its installed toolchain. */
function androidReason() {
  if (!existsSync(join(REPO_ROOT, "apps", "android", "package.json"))) return "apps/android is not present";
  return null;
}

/** Whether a Playwright suite can run: the app's own binary has to be installed. */
function playwrightReason(app) {
  const binary = join(REPO_ROOT, "apps", app, "node_modules", ".bin", "playwright");
  return existsSync(binary) ? null : `apps/${app} has no Playwright binary installed`;
}

/** Whether the desktop suite can run: it needs a display, and on Linux that is `xvfb-run`. */
function desktopReason() {
  const missing = playwrightReason("desktop");
  if (missing !== null) return missing;
  if (process.platform !== "linux") return null;
  return probe("which", ["xvfb-run"]).found ? null : "xvfb-run is not installed, so no display is available";
}

/** Whether the device scripts can run: a phone attached over `adb`. */
function deviceReason(flags) {
  if (!flags.device) return "not requested (pass --device)";
  const adb = probe("adb", ["version"]);
  if (!adb.found) return "adb is not installed";
  return resolveDeviceSerial() === null ? "no Android device is attached (adb devices)" : null;
}

/** Whether the compose stack can be started: Docker, its compose plugin and a live daemon. */
function dockerReason(flags) {
  if (!flags.docker) return "not requested (pass --docker)";
  const version = probe("docker", ["version", "--format", "{{.Server.Version}}"]);
  if (!version.found) return "the Docker daemon is not reachable";
  return probe("docker", ["compose", "version"]).found ? null : "the Docker compose plugin is not installed";
}

/** The token U-022's smoke test reads out of `infra/.env`, or `null` when the stack was never configured. */
function hubToken() {
  if (!existsSync(ENV_FILE)) return null;
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    if (line.startsWith("LECTERN_TOKEN=")) return line.slice("LECTERN_TOKEN=".length).trim();
  }
  return null;
}

/** The compose file every Docker step names; the commands are U-022's own. */
const COMPOSE = ["compose", "-f", "infra/docker-compose.yml"];

/**
 * The steps of a release check, in the contract's order. Each names the command it runs, the reason it cannot
 * run on this host when there is one, and whether the flag it belongs to was passed.
 */
function stepsFor(flags) {
  const pnpm = (...args) => ["pnpm", ...args];
  return [
    { id: "lint", label: "workspace lint (Biome)", argv: pnpm("-w", "run", "lint") },
    { id: "typecheck", label: "workspace type check (turbo)", argv: pnpm("-w", "run", "typecheck") },
    { id: "test", label: "workspace test suites (turbo)", argv: pnpm("-w", "run", "test") },
    { id: "guard-unit", label: "guard: unit contracts (scripts/unit.mjs)", argv: ["node", "scripts/unit.mjs", UNIT] },
    { id: "guard-forbidden", label: "guard: forbidden content", argv: ["node", "scripts/check-forbidden.mjs"] },
    { id: "guard-scope", label: "guard: unit scope", argv: ["node", "scripts/check-scope.mjs", UNIT] },
    { id: "guard-isomorphic", label: "guard: core isomorphism", argv: ["node", "scripts/check-isomorphic.mjs"] },
    { id: "web-build", label: "web build", argv: pnpm("--filter", "@lectern/web", "run", "build") },
    {
      id: "web-e2e",
      label: "web end-to-end suite (Playwright)",
      argv: pnpm("--filter", "@lectern/web", "exec", "playwright", "test"),
      reason: () => playwrightReason("web"),
    },
    { id: "extension-build", label: "extension build", argv: pnpm("--filter", "@lectern/extension", "run", "build") },
    {
      id: "extension-e2e",
      label: "extension end-to-end suite (Playwright)",
      argv: pnpm("--filter", "@lectern/extension", "exec", "playwright", "test"),
      reason: () => playwrightReason("extension"),
    },
    { id: "desktop-build", label: "desktop build", argv: pnpm("--filter", "@lectern/desktop", "run", "build") },
    {
      id: "desktop-e2e",
      label: "desktop end-to-end suite (Playwright under xvfb-run)",
      argv: ["xvfb-run", "-a", "pnpm", "--filter", "@lectern/desktop", "exec", "playwright", "test"],
      reason: desktopReason,
    },
    {
      id: "android-test",
      label: "Android host suite (Vitest)",
      argv: pnpm("--filter", "@lectern/android", "exec", "vitest", "run"),
      reason: androidReason,
    },
    {
      id: "android-typecheck",
      label: "Android host type check",
      argv: pnpm("--filter", "@lectern/android", "run", "typecheck"),
      reason: androidReason,
    },
    {
      id: "android-only",
      label: "Android-only guard",
      argv: ["node", "apps/android/scripts/check-android-only.mjs"],
      reason: androidReason,
    },
    {
      id: "android-export",
      label: "Android Hermes export",
      argv: pnpm("--filter", "@lectern/android", "exec", "expo", "export", "--platform", "android", "--output-dir", "dist"),
      reason: androidReason,
    },
    { id: "cross-device", label: "cross-device end-to-end verification", argv: ["node", "scripts/e2e-cross-device.mjs"] },
    {
      id: "device-prepare",
      label: "prepare the phone: clear the app's storage and this harness's scratch",
      command: `adb shell pm clear ${ANDROID_PACKAGE} (and clear data/device-run)`,
      run: (environment) => prepareDevice(environment),
      reason: () => deviceReason(flags),
    },
    {
      id: "device-run-all",
      label: "Android device checks: conformance, share intent, media session",
      argv: ["sh", "apps/android/scripts/device/run-all.sh"],
      reason: () => deviceReason(flags),
      device: true,
    },
    {
      id: "device-offline",
      label: "Android device check: offline playback",
      argv: ["sh", "apps/android/scripts/device/verify-offline.sh"],
      reason: () => deviceReason(flags),
      device: true,
    },
    {
      id: "device-sync",
      label: "Android device check: sync round trip",
      argv: ["sh", "apps/android/scripts/device/verify-sync.sh"],
      reason: () => deviceReason(flags),
      device: true,
    },
    {
      id: "docker-env",
      label: "compose environment file (U-022's own first step)",
      argv: ["cp", "-n", "infra/.env.example", "infra/.env"],
      reason: () => dockerReason(flags),
    },
    {
      id: "docker-up",
      label: "compose stack up (hub, kokoro, profiles)",
      argv: ["docker", ...COMPOSE, "up", "-d", "--build", "--wait"],
      reason: () => dockerReason(flags),
    },
    {
      id: "docker-smoke",
      label: "real-engine smoke test (U-022) against the stack",
      argv: ["node", "scripts/smoke-engine.mjs", "--base", "http://127.0.0.1:8787"],
      env: () => ({ LECTERN_TOKEN: hubToken() ?? "" }),
      reason: () => dockerReason(flags),
    },
  ];
}

/** One step's command as a line a reader can paste, for the record and the console. */
function commandLine(argv) {
  return argv.map((argument) => (/^[\w@./:=+-]+$/.test(argument) ? argument : JSON.stringify(argument))).join(" ");
}

/**
 * Run one step and record what happened.
 *
 * A step is never given a shell: its `argv` is its whole command, and a step that has to do something a single
 * command cannot — clearing the phone's storage — carries a `run` function instead and answers its own exit code.
 * A step's `env` is added to this process's own environment for that child alone, which is how the smoke test is
 * handed the token `infra/.env` holds.
 */
function runStep(step, environment) {
  const reason = step.reason?.() ?? null;
  const command = step.run === undefined ? commandLine(step.argv) : step.command;
  if (reason !== null) {
    process.stdout.write(`SKIP  ${step.id} — ${reason}\n`);
    return { id: step.id, label: step.label, command, status: SKIPPED, exitCode: null, durationMs: 0, reason };
  }
  process.stdout.write(`RUN   ${step.id} — ${command}\n`);
  const started = Date.now();
  if (step.run !== undefined) {
    const exitCode = step.run(environment);
    const durationMs = Date.now() - started;
    if (exitCode === 0) {
      process.stdout.write(`PASS  ${step.id} — exit 0 in ${(durationMs / 1000).toFixed(1)}s\n`);
      return { id: step.id, label: step.label, command, status: PASS, exitCode, durationMs };
    }
    process.stdout.write(`FAIL  ${step.id} — exit ${exitCode}\n`);
    return { id: step.id, label: step.label, command, status: FAIL, exitCode, durationMs, tail: [] };
  }
  const result = spawnSync(step.argv[0], step.argv.slice(1), {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: step.env === undefined ? environment : { ...environment, ...step.env() },
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  const durationMs = Date.now() - started;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error !== undefined) {
    process.stdout.write(`FAIL  ${step.id} — ${result.error.message}\n`);
    return {
      id: step.id,
      label: step.label,
      command,
      status: FAIL,
      exitCode: null,
      durationMs,
      reason: result.error.message,
      tail: tailOf(output),
    };
  }
  const status = result.status === 0 ? PASS : FAIL;
  process.stdout.write(`${status}  ${step.id} — exit ${result.status} in ${(durationMs / 1000).toFixed(1)}s\n`);
  return {
    id: step.id,
    label: step.label,
    command,
    status,
    exitCode: result.status,
    durationMs,
    ...(status === FAIL ? { tail: tailOf(output) } : {}),
  };
}

/**
 * Empty the app's own storage and this harness's scratch before a device run.
 *
 * The app keeps the reader's place per document and U-052's media-session check needs most of the share
 * fixture's own length, so a run that inherits a nearly finished document reads as "not playing" at the end; the
 * harness's scratch has to go with it, because a freshly emptied app pulls the previous run's records straight
 * back on its first round. It is the practice U-052's close and U-061's run both record, and it happens before
 * the checks rather than inside them.
 */
function prepareDevice(environment) {
  const serial = environment.ANDROID_SERIAL ?? resolveDeviceSerial();
  if (serial === null) {
    process.stderr.write("prepare-device: no Android device is attached\n");
    return 1;
  }
  const cleared = spawnSync("adb", ["shell", "pm", "clear", ANDROID_PACKAGE], { cwd: REPO_ROOT, env: environment, encoding: "utf8" });
  process.stdout.write(`${`${cleared.stdout ?? ""}${cleared.stderr ?? ""}`.trimEnd()}\n`);
  spawnSync("adb", ["reverse", "--remove-all"], { cwd: REPO_ROOT, env: environment, encoding: "utf8" });
  rmSync(DEVICE_RUN_DIR, { recursive: true, force: true });
  if (cleared.status !== 0) {
    process.stderr.write(`prepare-device: pm clear ${ANDROID_PACKAGE} exited ${cleared.status}\n`);
    return 1;
  }
  process.stdout.write(`prepared ${serial}: ${ANDROID_PACKAGE} cleared, data/device-run removed, reverses removed\n`);
  return 0;
}

/** The compose stack, taken down however the run ended: a release check leaves no container behind. */
function stopStack(environment) {
  spawnSync("docker", [...COMPOSE, "down"], { cwd: REPO_ROOT, env: environment, encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES });
}

/** The branch and commit this run is against, as the record's provenance. */
function revision() {
  const hash = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
  const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
  return {
    commit: hash.status === 0 ? (hash.stdout ?? "").trim() : null,
    branch: branch.status === 0 ? (branch.stdout ?? "").trim() : null,
  };
}

function parseArguments(argv) {
  const flags = { device: false, docker: false };
  let action = null;
  for (const argument of argv) {
    if (argument === "--device") flags.device = true;
    else if (argument === "--docker") flags.docker = true;
    else if (argument === "--help" || argument === "-h") action = "help";
    else {
      process.stderr.write(`Unknown option: ${argument}\n${USAGE}\n`);
      return { error: true };
    }
  }
  return { flags, action };
}

function main(argv) {
  const parsed = parseArguments(argv);
  if (parsed.error === true) return 1;
  if (parsed.action === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const flags = parsed.flags;
  const serial = flags.device ? resolveDeviceSerial() : null;
  const environment = serial === null ? { ...process.env } : { ...process.env, ANDROID_SERIAL: serial };
  const started = Date.now();

  // A record from an earlier run is stale the moment this one starts, and leaving it in place would put a
  // generated file in the tree the guard steps then read.
  rmSync(REPORT_PATH, { force: true });
  mkdirSync(dirname(REPORT_PATH), { recursive: true });

  const steps = [];
  const stackStep = stepsFor(flags).find((step) => step.id === "docker-up");
  const composeRequested = stackStep !== undefined && (stackStep.reason?.() ?? null) === null;
  try {
    for (const step of stepsFor(flags)) steps.push(runStep(step, environment));
  } finally {
    if (composeRequested) stopStack(environment);
  }

  const counts = { pass: 0, fail: 0, skipped: 0 };
  for (const step of steps) {
    if (step.status === PASS) counts.pass += 1;
    else if (step.status === FAIL) counts.fail += 1;
    else counts.skipped += 1;
  }
  const report = {
    generatedAt: new Date().toISOString(),
    unit: UNIT,
    revision: revision(),
    flags: { device: flags.device, docker: flags.docker },
    deviceSerial: serial,
    durationMs: Date.now() - started,
    summary: { ...counts, total: steps.length },
    steps,
  };
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  for (const step of steps) {
    if (step.status !== FAIL) continue;
    process.stdout.write(`\n${step.id} (${step.command}) exited ${step.exitCode}:\n`);
    for (const line of step.tail) process.stdout.write(`  ${line}\n`);
  }
  process.stdout.write(
    `\nrelease check: ${counts.pass} passed, ${counts.fail} failed, ${counts.skipped} skipped of ${steps.length} step(s) in ${(report.durationMs / 1000).toFixed(0)}s — docs/release-check.json\n`,
  );
  return counts.fail === 0 ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
