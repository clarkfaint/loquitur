#!/usr/bin/env node
// Lectern preflight check (F§13). Zero dependencies: Node built-ins only.
//
//   node scripts/preflight.mjs --phase <1|2|3|4|5>
//   node scripts/preflight.mjs --targets
//
// --phase runs every check for the requested phase and for all lower phases, prints one
// OK / MISSING line per check, writes docs/preflight.json, and exits 1 when a check the
// requested phase needs is missing.
// --targets reports which inspection targets from AGENTS.md section 3.1 are present and
// always exits 0.

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PREFLIGHT_JSON = join(REPO_ROOT, "docs", "preflight.json");
const MIN_NODE_MAJOR = 24;
const MIN_JAVA_MAJOR = 17;
const PHASES = [1, 2, 3, 4, 5];
const READER_CDP_HOST = "127.0.0.1";
const READER_CDP_PORT = 9222;

const IS_LINUX = process.platform === "linux";

function runCommand(args, timeoutMs = 20_000) {
  const [command, ...rest] = args;
  const result = spawnSync(command, rest, {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    env: process.env,
  });
  if (result.error) {
    return { found: false, ok: false, status: null, text: "", reason: result.error.message };
  }
  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();
  return {
    found: true,
    ok: result.status === 0,
    status: result.status,
    text: stdout || stderr,
    reason: null,
  };
}

function findExecutableOnPath(name) {
  const pathValue = process.env.PATH ?? "";
  for (const directory of pathValue.split(":").filter(Boolean)) {
    const candidate = join(directory, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not there or not executable; keep looking.
    }
  }
  return null;
}

function firstLine(text) {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

const CHECKS = [
  {
    id: "node",
    phase: 1,
    label: `Node >= ${MIN_NODE_MAJOR}`,
    run() {
      const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
      return { ok: major >= MIN_NODE_MAJOR, detail: `found ${process.versions.node} at ${process.execPath}` };
    },
  },
  {
    id: "pnpm",
    phase: 1,
    label: "pnpm",
    run() {
      const result = runCommand(["pnpm", "--version"]);
      if (!result.found) return { ok: false, detail: "pnpm is not on PATH" };
      return { ok: result.ok, detail: result.ok ? `found pnpm ${firstLine(result.text)}` : `pnpm exited ${result.status}` };
    },
  },
  {
    id: "git",
    phase: 1,
    label: "git",
    run() {
      const result = runCommand(["git", "--version"]);
      if (!result.found) return { ok: false, detail: "git is not on PATH" };
      return { ok: result.ok, detail: result.ok ? `found ${firstLine(result.text)}` : `git exited ${result.status}` };
    },
  },
  {
    id: "system-font",
    phase: 1,
    label: "system font (fc-list)",
    run() {
      const result = runCommand(["fc-list"]);
      if (!result.found) return { ok: false, detail: "fc-list is not on PATH (install fontconfig)" };
      const entries = result.text.split("\n").filter(Boolean);
      if (entries.length === 0) return { ok: false, detail: "fc-list listed no fonts" };
      const family = ((entries[0] ?? "").split(":")[1] ?? "").trim();
      return { ok: true, detail: `${entries.length} font entries, for example "${family}"` };
    },
  },
  {
    id: "xvfb-run",
    phase: 3,
    label: "xvfb-run (Linux only)",
    run() {
      if (!IS_LINUX) return { ok: true, detail: `not required on ${process.platform}` };
      const found = findExecutableOnPath("xvfb-run");
      return { ok: found !== null, detail: found ? `found ${found}` : "xvfb-run is not on PATH (install xvfb)" };
    },
  },
  {
    id: "java",
    phase: 4,
    label: `java >= ${MIN_JAVA_MAJOR}`,
    run() {
      const result = runCommand(["java", "-version"]);
      if (!result.found) return { ok: false, detail: "java is not on PATH (install JDK 17 or newer)" };
      const match = /version "(\d+)(?:\.(\d+))?/.exec(result.text);
      if (match === null) return { ok: false, detail: `could not read a version from: ${firstLine(result.text)}` };
      const major = Number.parseInt(match[1] ?? "0", 10);
      return { ok: major >= MIN_JAVA_MAJOR, detail: `found Java ${major} (${firstLine(result.text)})` };
    },
  },
  {
    id: "adb",
    phase: 4,
    label: "adb",
    run() {
      const which = runCommand(["adb", "version"]);
      if (!which.found) return { ok: false, detail: "adb is not on PATH (install Android platform tools)" };
      return { ok: which.ok, detail: which.ok ? `found ${firstLine(which.text)}` : `adb exited ${which.status}` };
    },
  },
  {
    id: "ANDROID_HOME",
    phase: 4,
    label: "ANDROID_HOME points at an existing directory",
    run() {
      const value = (process.env.ANDROID_HOME ?? "").trim();
      if (value === "") {
        const fallback = (process.env.ANDROID_SDK_ROOT ?? "").trim();
        return {
          ok: false,
          detail: fallback === "" ? "ANDROID_HOME is not set" : `ANDROID_HOME is not set (ANDROID_SDK_ROOT is ${fallback})`,
        };
      }
      const exists = existsSync(value) && statSync(value).isDirectory();
      return { ok: exists, detail: exists ? `found ${value}` : `${value} is not an existing directory` };
    },
  },
  {
    id: "docker-compose",
    phase: 5,
    label: "docker compose version",
    run() {
      const result = runCommand(["docker", "compose", "version"]);
      if (!result.found) return { ok: false, detail: "docker is not on PATH" };
      return { ok: result.ok, detail: result.ok ? `found ${firstLine(result.text)}` : `docker compose exited ${result.status}` };
    },
  },
];

const INSPECTION_TARGETS = [
  {
    id: "T-WEB",
    path: null,
    description: "reference web reader, logged in by the operator, with the probe document open",
  },
  {
    id: "T-EXT-RUN",
    path: null,
    description: "reference extension active on the local probe page (serve it with targets/probe/serve.mjs)",
  },
  { id: "T-EXT-PKG", path: "targets/extension", description: "copy of the installed reference extension directory" },
  { id: "T-WIN", path: "targets/desktop-win", description: "copy of the reference Windows application package or install directory" },
  { id: "T-APK", path: "targets/android/base.apk", description: "reference Android package pulled from the operator's own device" },
  { id: "T-SHOTS", path: "targets/shots", description: "operator-made screenshots or screen recordings, one directory per platform" },
];

function probeTcp(port, host, timeoutMs) {
  return new Promise((settle) => {
    let done = false;
    const finish = (reachable) => {
      if (done) return;
      done = true;
      socket.destroy();
      settle(reachable);
    };
    const socket = createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function runTargets() {
  console.log("Lectern inspection targets (AGENTS.md section 3.1)");
  const cdpReachable = await probeTcp(READER_CDP_PORT, READER_CDP_HOST, 500);
  for (const target of INSPECTION_TARGETS) {
    const label = target.id.padEnd(11);
    if (target.path === null) {
      const state = cdpReachable ? "REACHABLE" : "ABSENT";
      console.log(`${state.padEnd(10)}${label}Chrome CDP ${READER_CDP_HOST}:${READER_CDP_PORT} — ${target.description}`);
      continue;
    }
    const full = join(REPO_ROOT, target.path);
    const state = existsSync(full) ? "PRESENT" : "ABSENT";
    console.log(`${state.padEnd(10)}${label}${target.path} — ${target.description}`);
  }
  console.log("PRESENT   targets/probe/ — Lectern's own probe files ship with the repository");
  console.log("Targets are optional: inspection is advisory and every Unit Contract is buildable without them.");
  process.exitCode = 0;
  return;
}

function runPhase(phase) {
  const applicable = CHECKS.filter((check) => check.phase <= phase);
  console.log(`Lectern preflight — phase ${phase} (runs phases 1..${phase})`);
  console.log(`Repository: ${REPO_ROOT}`);
  const results = [];
  let ok = true;
  for (const check of applicable) {
    let outcome;
    try {
      outcome = check.run();
    } catch (error) {
      outcome = { ok: false, detail: `check raised: ${String(error)}` };
    }
    const passed = outcome.ok === true;
    if (!passed) ok = false;
    console.log(`${(passed ? "OK" : "MISSING").padEnd(8)}${check.label} — ${outcome.detail}`);
    results.push({ id: check.id, phase: check.phase, label: check.label, ok: passed, detail: outcome.detail });
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    phase,
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    ok,
    checks: results,
  };
  mkdirSync(dirname(PREFLIGHT_JSON), { recursive: true });
  writeFileSync(PREFLIGHT_JSON, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const missing = results.filter((entry) => !entry.ok);
  console.log(`Result: ${ok ? "OK" : "MISSING TOOLS"} — ${results.length} checks, ${missing.length} missing.`);
  if (!ok) {
    console.log(`Missing: ${missing.map((entry) => entry.label).join(", ")}`);
    console.log(`Wrote ${PREFLIGHT_JSON}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Wrote ${PREFLIGHT_JSON}`);
  process.exitCode = 0;
}

function usage() {
  console.log("Usage:");
  console.log("  node scripts/preflight.mjs --phase <1|2|3|4|5>   check the tooling a phase needs");
  console.log("  node scripts/preflight.mjs --targets             list which inspection targets exist");
}

async function main() {
  const argv = process.argv.slice(2);
  let mode = null;
  let phase = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--targets") {
      mode = "targets";
      continue;
    }
    if (arg === "--phase") {
      phase = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
      mode = "phase";
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      mode = "help";
      continue;
    }
    usage();
    console.log(`Unknown argument: ${arg}`);
    process.exitCode = 1;
    return;
  }
  if (mode === null || mode === "help") {
    usage();
    process.exitCode = mode === "help" ? 0 : 1;
    return;
  }
  if (mode === "targets") {
    await runTargets();
    return;
  }
  if (!PHASES.includes(phase)) {
    usage();
    console.log(`Invalid --phase value: ${argv.join(" ")}`);
    process.exitCode = 1;
    return;
  }
  runPhase(phase);
}

await main();
