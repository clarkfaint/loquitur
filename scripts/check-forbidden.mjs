#!/usr/bin/env node
// Lectern forbidden-content guard. Zero dependencies: Node built-ins only.
//
//   node scripts/check-forbidden.mjs
//
// Scans every git-tracked file under apps/, packages/, infra/ and scripts/ and fails (exit 1,
// listing the file and line) on anything Lectern must never carry: the reference product's name in
// any letter case, an Apple-platform path or file name, an iOS platform branch, a leftover work
// marker, a suppressed type error, or a banned dependency in a package.json.
//
// Every literal that would match its own content rule is assembled at run time from fragments, so
// this file does not report itself. Replacing the fragments with the whole word would make the guard
// flag its own source, which is what the rule is for.
//
// A guard that cannot read its input — no repository, no git, an unparsable package.json — exits 1
// instead of reporting a clean tree.

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRECTORIES = ["apps", "packages", "infra", "scripts"];
const USAGE = "Usage: node scripts/check-forbidden.mjs";

const fragment = (...parts) => parts.join("");

const PRODUCT_NAME = fragment("Spee", "chify");

const FORBIDDEN_CONTENT = [
  { rule: "iOS platform branch", text: fragment("Platform.OS === ", "'i", "os'") },
  { rule: "iOS platform branch (double quotes)", text: fragment("Platform.OS === ", '"i', 'os"') },
  { rule: "leftover work marker", text: fragment("TO", "DO") },
  { rule: "leftover work marker", text: fragment("FIX", "ME") },
  { rule: "suppressed type error", text: fragment("@ts", "-ignore") },
];

const EXCLUDED_PLATFORM_SEGMENT = "ios";
const EXCLUDED_PLATFORM_FILES = ["Podfile"];
const EXCLUDED_PLATFORM_SUFFIXES = [".xcodeproj", ".xcworkspace", ".swift", ".m", ".mm"];

// The contract's dependency notation: a bare name is exactly that package, "scope/*" is the whole
// scope, and "name*" is a family of packages.
const BANNED_DEPENDENCIES = [
  "stripe",
  "@stripe/*",
  "react-native-purchases",
  "@sentry/*",
  "posthog*",
  "mixpanel*",
  "@amplitude/*",
  "firebase",
  "@react-native-firebase/*",
  "@rntp/player",
  "react-native-track-player",
];

const MANIFEST_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

function trackedFiles() {
  const result = spawnSync("git", ["-C", REPO_ROOT, "ls-files", "-z", "--", ...SCAN_DIRECTORIES], { encoding: "utf8" });
  if (result.error !== undefined) throw new Error(`git is not available: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`git ls-files exited ${result.status}: ${(result.stderr ?? "").trim()}`);
  return (result.stdout ?? "")
    .split("\0")
    .filter((entry) => entry !== "")
    .sort();
}

export function matchesDependencyPattern(pattern, name) {
  if (pattern.endsWith("/*")) {
    const scope = pattern.slice(0, -2);
    return name === scope || name.startsWith(`${scope}/`);
  }
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

function scanPath(relativePath, findings) {
  const segments = relativePath.split("/");
  if (segments.includes(EXCLUDED_PLATFORM_SEGMENT)) {
    findings.push({ path: relativePath, line: null, rule: "excluded-platform path segment" });
  }
  const name = basename(relativePath);
  if (EXCLUDED_PLATFORM_FILES.includes(name) || EXCLUDED_PLATFORM_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    findings.push({ path: relativePath, line: null, rule: "excluded-platform file name" });
  }
}

function scanContent(relativePath, contents, findings) {
  const wanted = PRODUCT_NAME.toLowerCase();
  contents.split("\n").forEach((line, index) => {
    const number = index + 1;
    if (line.toLowerCase().includes(wanted)) {
      findings.push({ path: relativePath, line: number, rule: "reference product name" });
    }
    for (const entry of FORBIDDEN_CONTENT) {
      if (line.includes(entry.text)) findings.push({ path: relativePath, line: number, rule: entry.rule });
    }
  });
}

function scanManifest(relativePath, contents, findings) {
  if (basename(relativePath) !== "package.json") return;
  let manifest;
  try {
    manifest = JSON.parse(contents);
  } catch (error) {
    throw new Error(`${relativePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${relativePath} is not a JSON object`);
  }
  for (const field of MANIFEST_FIELDS) {
    const declared = manifest[field];
    if (declared === undefined || declared === null || typeof declared !== "object") continue;
    for (const name of Object.keys(declared)) {
      const pattern = BANNED_DEPENDENCIES.find((candidate) => matchesDependencyPattern(candidate, name));
      if (pattern !== undefined) findings.push({ path: relativePath, line: null, rule: `banned dependency (${pattern})` });
    }
  }
}

export function runCheck(options = {}) {
  const write = options.out ?? ((text) => process.stdout.write(`${text}\n`));
  const writeError = options.err ?? ((text) => process.stderr.write(`${text}\n`));
  try {
    const files = trackedFiles();
    const findings = [];
    let scanned = 0;
    let skipped = 0;
    for (const relativePath of files) {
      const absolute = join(REPO_ROOT, relativePath);
      if (!statSync(absolute).isFile()) {
        skipped += 1;
        continue;
      }
      const contents = readFileSync(absolute, "utf8");
      scanned += 1;
      scanPath(relativePath, findings);
      scanContent(relativePath, contents, findings);
      scanManifest(relativePath, contents, findings);
    }
    if (findings.length > 0) {
      writeError(`check-forbidden: ${findings.length} finding(s) in ${scanned} tracked file(s)`);
      for (const finding of findings) {
        const where = finding.line === null ? finding.path : `${finding.path}:${finding.line}`;
        writeError(`  ${where} — ${finding.rule}`);
      }
      return 1;
    }
    const note = skipped === 0 ? "" : `, ${skipped} non-file entry(ies) skipped`;
    write(`check-forbidden: clean — ${scanned} tracked file(s) scanned under ${SCAN_DIRECTORIES.join(", ")}${note}`);
    return 0;
  } catch (error) {
    writeError(`check-forbidden: cannot complete the scan — ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export function runCli(argv, options = {}) {
  const write = options.out ?? ((text) => process.stdout.write(`${text}\n`));
  const writeError = options.err ?? ((text) => process.stderr.write(`${text}\n`));
  if (argv.includes("--help") || argv.includes("-h")) {
    write(USAGE);
    return 0;
  }
  const unexpected = argv.filter((argument) => argument !== "");
  if (unexpected.length > 0) {
    writeError(`Unexpected argument: ${unexpected[0]}`);
    writeError(USAGE);
    return 1;
  }
  return runCheck(options);
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = runCli(process.argv.slice(2));
