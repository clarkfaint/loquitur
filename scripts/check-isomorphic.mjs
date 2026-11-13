#!/usr/bin/env node
// Lectern isomorphism guard. Zero dependencies: Node built-ins only.
//
//   node scripts/check-isomorphic.mjs
//
// @lectern/core has two entry points: the isomorphic one, which must import nothing from Node, the
// DOM or React Native, and the Node-only parsers entry. This guard follows every relative import
// from packages/core/src/index.ts and fails when the walk
//
//   * reaches a file under packages/core/src/parsers/, or
//   * meets a specifier for a Node built-in ("node:" prefixed, "fs", "path"), React, React Native,
//     or an Expo package.
//
// Before @lectern/core exists there is no entry to follow: that is a notice with exit 0, because
// the boundary is vacuously intact. Anything the guard cannot read is a failure (exit 1).

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ISOMORPHIC_ENTRY = join(REPO_ROOT, "packages", "core", "src", "index.ts");
const NODE_ONLY_PARSERS = join(REPO_ROOT, "packages", "core", "src", "parsers");
const USAGE = "Usage: node scripts/check-isomorphic.mjs";

const SPECIFIERS = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
const RESOLUTION_SUFFIXES = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx"];
const NODE_BUILTINS = ["fs", "path"];
const RUNTIME_MODULES = ["react", "react-native"];

export function forbiddenSpecifier(specifier) {
  if (specifier.startsWith("node:")) return "Node built-in";
  if (specifier.startsWith("expo-") || specifier.startsWith("@expo/")) return "Expo package";
  for (const name of NODE_BUILTINS) {
    if (specifier === name || specifier.startsWith(`${name}/`)) return "Node built-in";
  }
  for (const name of RUNTIME_MODULES) {
    if (specifier === name || specifier.startsWith(`${name}/`)) return "DOM or React Native runtime";
  }
  return null;
}

function resolveRelative(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  for (const suffix of RESOLUTION_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function isInsideParsers(absolutePath) {
  return absolutePath === NODE_ONLY_PARSERS || absolutePath.startsWith(`${NODE_ONLY_PARSERS}${sep}`);
}

export function walkIsomorphicGraph(entry, findings) {
  const visited = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || visited.has(file)) continue;
    visited.add(file);
    const relativePath = relative(REPO_ROOT, file);
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        const number = index + 1;
        for (const match of line.matchAll(SPECIFIERS)) {
          const specifier = match[1];
          if (specifier === undefined) continue;
          const forbidden = forbiddenSpecifier(specifier);
          if (forbidden !== null) findings.push({ path: relativePath, line: number, rule: `${forbidden}: "${specifier}"` });
          if (!specifier.startsWith(".")) continue;
          if (isInsideParsers(resolve(dirname(file), specifier))) {
            findings.push({ path: relativePath, line: number, rule: `Node-only parser import: "${specifier}"` });
          }
          const target = resolveRelative(file, specifier);
          if (target !== null) pending.push(target);
        }
      });
  }
  return visited;
}

export function runCheck(options = {}) {
  const entry = options.entry ?? ISOMORPHIC_ENTRY;
  const write = options.out ?? ((text) => process.stdout.write(`${text}\n`));
  const writeError = options.err ?? ((text) => process.stderr.write(`${text}\n`));
  try {
    if (!existsSync(entry)) {
      write(`check-isomorphic: notice — ${relative(REPO_ROOT, entry)} does not exist yet, nothing to follow`);
      return 0;
    }
    const findings = [];
    const visited = walkIsomorphicGraph(entry, findings);
    if (findings.length > 0) {
      writeError(`check-isomorphic: ${findings.length} finding(s) in ${visited.size} visited module(s)`);
      for (const finding of findings) writeError(`  ${finding.path}:${finding.line} — ${finding.rule}`);
      return 1;
    }
    write(`check-isomorphic: clean — ${visited.size} module(s) reachable from ${relative(REPO_ROOT, entry)}`);
    return 0;
  } catch (error) {
    writeError(`check-isomorphic: cannot complete the walk — ${error instanceof Error ? error.message : String(error)}`);
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
