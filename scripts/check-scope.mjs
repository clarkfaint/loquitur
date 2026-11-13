#!/usr/bin/env node
// Lectern scope guard. Zero dependencies: Node built-ins only.
//
//   node scripts/check-scope.mjs U-0NN
//
// Every path this unit changed must be one the contract allows it to change.
//
//   Base      the most recent commit whose subject starts with "feat(U-", "blocked(U-", or "chore(spec)" and does
//             not name the unit being checked; if there is none, the empty tree.
//   Changed   files that differ from the base (staged or not), plus untracked, unignored files.
//   Allowed   the unit's outputs and patch scope; pnpm-lock.yaml; docs/status.md;
//             docs/evidence/<UNIT>.md; any package.json; packages/*/src/index.ts;
//             packages/*/src/*/index.ts; every path a lower-numbered unit marked (registry).
//
// Exit 1 lists each changed path that is not allowed. A unit identifier that spec.md does not
// define, or a tree without git, is a failure: the allowed set cannot be built at all.

import { spawnSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseUnit, parseUnits, REPO_ROOT, readSpec, SPEC_PATH } from "./unit.mjs";

const COMMIT_BOUNDARY = /^(?:(?:feat|blocked)\(U-|chore\(spec\))/;
const UNIT_ID = /^U-(\d+)(?:-P(\d+))?$/;
const ALWAYS_ALLOWED = ["pnpm-lock.yaml", "docs/status.md"];
const BARREL_PATTERNS = [/^packages\/[^/]+\/src\/index\.ts$/, /^packages\/[^/]+\/src\/[^/]+\/index\.ts$/];
const USAGE = "Usage: node scripts/check-scope.mjs U-0NN";

function runGit(args) {
  const result = spawnSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8" });
  if (result.error !== undefined) throw new Error(`git is not available: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${result.status}: ${(result.stderr ?? "").trim()}`);
  }
  return result.stdout ?? "";
}

function unitOrder(unitId) {
  const match = UNIT_ID.exec(unitId);
  if (match === null) return null;
  return { number: Number(match[1]), patch: match[2] === undefined ? 0 : Number(match[2]) };
}

export function findBaseCommit(unitId) {
  for (const line of runGit(["log", "--format=%H%x1f%s"]).split("\n")) {
    if (line === "") continue;
    const separator = line.indexOf("\x1f");
    if (separator === -1) continue;
    const hash = line.slice(0, separator);
    const subject = line.slice(separator + 1);
    if (!COMMIT_BOUNDARY.test(subject)) continue;
    if (subject.includes(unitId)) continue;
    return hash;
  }
  return null;
}

export function changedPaths(baseCommit) {
  const againstBase = baseCommit === null ? runGit(["ls-files"]) : runGit(["diff", "--name-only", baseCommit]);
  const untracked = runGit(["ls-files", "--others", "--exclude-standard"]);
  const paths = new Set();
  for (const line of [...againstBase.split("\n"), ...untracked.split("\n")]) {
    const path = line.trim();
    if (path !== "") paths.add(path);
  }
  return [...paths].sort();
}

export function allowedPaths(unit, specText) {
  const allowed = new Set([...unit.outputs, ...unit.patchScope, ...ALWAYS_ALLOWED, `docs/evidence/${unit.id}.md`]);
  const order = unitOrder(unit.id);
  if (order === null) return allowed;
  for (const candidate of parseUnits(specText)) {
    const candidateOrder = unitOrder(candidate.id);
    if (candidateOrder === null || candidateOrder.number >= order.number) continue;
    for (const registry of candidate.registries) allowed.add(registry);
  }
  return allowed;
}

export function isAllowedPath(path, allowed) {
  if (allowed.has(path)) return true;
  if (basename(path) === "package.json") return true;
  return BARREL_PATTERNS.some((pattern) => pattern.test(path));
}

export function runCheck(unitId, options = {}) {
  const specPath = options.specPath ?? SPEC_PATH;
  const write = options.out ?? ((text) => process.stdout.write(`${text}\n`));
  const writeError = options.err ?? ((text) => process.stderr.write(`${text}\n`));
  try {
    const specText = readSpec(specPath);
    const unit = parseUnit(specText, unitId);
    if (unit === null) throw new Error(`unknown unit ${unitId}: ${specPath} does not define it`);
    const baseCommit = findBaseCommit(unitId);
    const changed = changedPaths(baseCommit);
    const allowed = allowedPaths(unit, specText);
    const violations = changed.filter((path) => !isAllowedPath(path, allowed));
    if (violations.length > 0) {
      writeError(`check-scope: ${unitId} — ${violations.length} changed path(s) outside this unit's scope`);
      for (const path of violations) writeError(`  ${path}`);
      return 1;
    }
    const base = baseCommit === null ? "the empty tree" : baseCommit.slice(0, 7);
    write(`check-scope: ${unitId} — ${changed.length} changed path(s), all allowed (base ${base})`);
    return 0;
  } catch (error) {
    writeError(`check-scope: cannot complete the check — ${error instanceof Error ? error.message : String(error)}`);
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
  const identifiers = argv.filter((argument) => !argument.startsWith("-"));
  const optionsSeen = argv.filter((argument) => argument.startsWith("-"));
  if (optionsSeen.length > 0 || identifiers.length !== 1) {
    if (optionsSeen.length > 0) writeError(`Unexpected option: ${optionsSeen[0]}`);
    else writeError("Exactly one unit identifier is required, for example U-001.");
    writeError(USAGE);
    return 1;
  }
  return runCheck(identifiers[0], options);
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = runCli(process.argv.slice(2));
