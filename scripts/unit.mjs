#!/usr/bin/env node
// Lectern unit-contract extractor. Zero dependencies: Node built-ins only.
//
//   node scripts/unit.mjs U-0NN          print that unit's contract from spec.md
//   node scripts/unit.mjs U-0NN --json   print { id, title, dependsOn[], patchScope[], outputs[], registries[] }
//
// A unit block runs from its "### U-0NN ..." heading to the next "### U-" heading, or to the end of
// spec.md. An identifier that spec.md does not define is an error (exit 1), never an empty print.
//
// The other guards import parseUnit and parseUnits from here, so one parser answers every machine
// question about a contract: which units exist, what a unit depends on, which files it delivers,
// which of those are registries, and which extra paths a patch scope allows.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SPEC_PATH = join(REPO_ROOT, "spec.md");

const UNIT_HEADING = /^### (U-\d{3,}(?:-P\d+)?)\b(.*)$/;
const TITLE_SEPARATOR = /^\s*[—–-]\s*(.+)$/;
const DECLARED_DEPENDENCIES = /^-\s*Depends on:\s*(.*)$/;
const REQUIRED_OUTPUTS_HEADING = /^\*\*Required File Outputs\*\*/;
// A patch scope is its own bullet, labelled "Patch scope:"; the prose of another bullet may mention
// the label, so the pattern is anchored instead of searched.
const PATCH_SCOPE_LINE = /^-\s*(?:\*\*)?Patch scope:(?:\*\*)?\s*/;
const BOLD_HEADING = /^\*\*/;
const OUTPUT_BULLET = /^-\s+`([^`]+)`/;
const REGISTRY_MARKER = "(registry)";
const BACKTICKED_PATH = /`([^`]+)`/g;
const UNIT_ID = /U-\d{3,}(?:-P\d+)?/g;

const USAGE = [
  "Usage:",
  "  node scripts/unit.mjs U-0NN          print that unit's contract",
  "  node scripts/unit.mjs U-0NN --json   print its parsed fields as JSON",
].join("\n");

function titleFrom(rest) {
  const separator = TITLE_SEPARATOR.exec(rest);
  if (separator !== null) return separator[1].trim();
  return rest.trim();
}

function backtickedPaths(text) {
  return [...text.matchAll(BACKTICKED_PATH)].map((match) => match[1]);
}

/** Every unit block of spec.md, in document order, with its raw lines. */
export function listUnits(specText) {
  const units = [];
  let current = null;
  for (const line of specText.split("\n")) {
    const heading = UNIT_HEADING.exec(line);
    if (heading !== null) {
      current = { id: heading[1], title: titleFrom(heading[2]), lines: [line] };
      units.push(current);
      continue;
    }
    if (current !== null) current.lines.push(line);
  }
  return units;
}

/** The machine-readable fields of one unit block, or null when the id is not in spec.md. */
export function parseUnit(specText, unitId) {
  return parseUnits(specText).find((unit) => unit.id === unitId) ?? null;
}

/** Every unit block of spec.md, parsed: id, title, dependsOn, patchScope, outputs, registries, text. */
export function parseUnits(specText) {
  return listUnits(specText).map((unit) => {
    const outputs = [];
    const registries = [];
    let dependsOn = [];
    let patchScope = [];
    let insideOutputs = false;
    for (const line of unit.lines) {
      if (DECLARED_DEPENDENCIES.test(line)) {
        dependsOn = DECLARED_DEPENDENCIES.exec(line)?.[1].match(UNIT_ID) ?? [];
        continue;
      }
      if (PATCH_SCOPE_LINE.test(line)) {
        patchScope = backtickedPaths(line);
        insideOutputs = false;
        continue;
      }
      if (REQUIRED_OUTPUTS_HEADING.test(line)) {
        insideOutputs = true;
        continue;
      }
      if (BOLD_HEADING.test(line)) {
        insideOutputs = false;
        continue;
      }
      if (!insideOutputs) continue;
      const bullet = OUTPUT_BULLET.exec(line);
      if (bullet !== null) {
        outputs.push(bullet[1]);
        if (line.includes(REGISTRY_MARKER)) registries.push(bullet[1]);
      }
    }
    return {
      id: unit.id,
      title: unit.title,
      dependsOn,
      patchScope,
      outputs,
      registries,
      text: unit.lines.join("\n").trimEnd(),
    };
  });
}

/** spec.md as text. Throws when it cannot be read: callers turn that into exit code 1. */
export function readSpec(specPath = SPEC_PATH) {
  return readFileSync(specPath, "utf8");
}

function parseArguments(argv) {
  const identifiers = [];
  let json = false;
  let help = false;
  let unknown = null;
  for (const argument of argv) {
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument.startsWith("-")) {
      unknown = argument;
      continue;
    }
    identifiers.push(argument);
  }
  return { identifiers, json, help, unknown };
}

export function runCli(argv, options = {}) {
  const specPath = options.specPath ?? SPEC_PATH;
  const write = options.out ?? ((text) => process.stdout.write(`${text}\n`));
  const writeError = options.err ?? ((text) => process.stderr.write(`${text}\n`));
  const { identifiers, json, help, unknown } = parseArguments(argv);

  if (unknown !== null) {
    writeError(`Unknown option: ${unknown}`);
    writeError(USAGE);
    return 1;
  }
  if (help) {
    write(USAGE);
    return 0;
  }
  if (identifiers.length !== 1) {
    writeError("Exactly one unit identifier is required, for example U-001.");
    writeError(USAGE);
    return 1;
  }

  let specText;
  try {
    specText = readSpec(specPath);
  } catch (error) {
    writeError(`Cannot read ${specPath}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const unit = parseUnit(specText, identifiers[0]);
  if (unit === null) {
    writeError(`Unknown unit ${identifiers[0]}: ${specPath} does not define it.`);
    return 1;
  }

  if (json) {
    write(
      JSON.stringify(
        {
          id: unit.id,
          title: unit.title,
          dependsOn: unit.dependsOn,
          patchScope: unit.patchScope,
          outputs: unit.outputs,
          registries: unit.registries,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  write(unit.text);
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = runCli(process.argv.slice(2));
