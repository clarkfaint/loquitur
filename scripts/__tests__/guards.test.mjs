// Guard suite for the Lectern repository scripts. Zero dependencies: Node built-ins only.
//
//   node --test scripts/__tests__/
//
// Every guard runs inside a temporary tree that contains a copy of the guard itself, so the guard's
// real entry point, its own root discovery and its exit code are exercised, and nothing in the
// repository is written. The temporary trees live under os.tmpdir() and are removed afterwards.
//
// No literal that a guard rejects appears in this file: the fixtures are assembled from fragments,
// because this file is itself inside the scanned scripts/ directory.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GUARD_FILES = ["unit.mjs", "check-forbidden.mjs", "check-scope.mjs", "check-isomorphic.mjs"];

const fragment = (...parts) => parts.join("");
const PRODUCT_NAME = fragment("Spee", "chify");
const WORK_MARKER = fragment("TO", "DO");
const FIXUP_MARKER = fragment("FIX", "ME");
const SUPPRESSED_ERROR = fragment("@ts", "-ignore");
const IOS_BRANCH_SINGLE = fragment("Platform.OS === ", "'i", "os'");
const IOS_BRANCH_DOUBLE = fragment("Platform.OS === ", '"i', 'os"');
const APPLE_DIRECTORY = "ios";

const temporaryTrees = [];

function writeFile(root, relativePath, contents) {
  const absolute = join(root, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, "utf8");
}

function makeTree(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "lectern-guards-"));
  temporaryTrees.push(root);
  for (const [relativePath, contents] of Object.entries(files)) writeFile(root, relativePath, contents);
  return root;
}

function installGuards(root) {
  mkdirSync(join(root, "scripts"), { recursive: true });
  for (const name of GUARD_FILES) copyFileSync(join(SCRIPTS_DIRECTORY, name), join(root, "scripts", name));
}

function runGit(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function prepareRepository(root, subject = null) {
  assert.equal(runGit(root, ["init", "-q"]).status, 0, "git init");
  assert.equal(runGit(root, ["add", "-A"]).status, 0, "git add");
  if (subject === null) return;
  const commit = runGit(root, [
    "-c",
    "user.name=Lectern Guard Test",
    "-c",
    "user.email=guards@lectern.invalid",
    "commit",
    "-q",
    "--no-gpg-sign",
    "-m",
    subject,
  ]);
  assert.equal(commit.status, 0, `git commit: ${commit.stderr}`);
}

function runGuard(root, script, args = []) {
  const result = spawnSync(process.execPath, [join(root, "scripts", script), ...args], { encoding: "utf8", cwd: root });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

after(() => {
  for (const tree of temporaryTrees) rmSync(tree, { recursive: true, force: true });
});

const SPEC = [
  "# Spec",
  "",
  "### U-000 — Base unit",
  "",
  "**Required File Outputs**",
  "- `scripts/preflight.mjs` — preflight",
  "",
  "### U-001 — Target unit",
  "",
  "**Inputs & Dependencies**",
  "- Depends on: U-000",
  "- Reads: F§2.1",
  "",
  "**Required File Outputs**",
  "- `package.json` — root manifest",
  "- `packages/core/src/index.ts` — export barrel (registry)",
  "- `scripts/unit.mjs` — extractor",
  "",
  "- Patch scope: `packages/core/src/registry.ts`",
  "- Patch notes: why that path is in scope",
  "",
  "### U-002 — Later unit",
  "",
  "**Inputs & Dependencies**",
  "- Depends on: U-000, U-001",
  "",
  "**Required File Outputs**",
  "- `apps/web/index.html` — shell",
  "",
].join("\n");

describe("scripts/unit.mjs", () => {
  function unitTree() {
    const root = makeTree({ "spec.md": SPEC });
    installGuards(root);
    return root;
  }

  it("prints the block from its heading to the next heading", () => {
    const result = runGuard(unitTree(), "unit.mjs", ["U-001"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /### U-001 — Target unit/);
    assert.match(result.stdout, /- `package\.json` — root manifest/);
    assert.doesNotMatch(result.stdout, /### U-002/);
    assert.doesNotMatch(result.stdout, /### U-000/);
  });

  it("reports the machine-readable fields with --json", () => {
    const result = runGuard(unitTree(), "unit.mjs", ["U-001", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      id: "U-001",
      title: "Target unit",
      dependsOn: ["U-000"],
      patchScope: ["packages/core/src/registry.ts"],
      outputs: ["package.json", "packages/core/src/index.ts", "scripts/unit.mjs"],
      registries: ["packages/core/src/index.ts"],
    });
  });

  it("reports a unit without dependencies or registry entries", () => {
    const result = runGuard(unitTree(), "unit.mjs", ["U-000", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      id: "U-000",
      title: "Base unit",
      dependsOn: [],
      patchScope: [],
      outputs: ["scripts/preflight.mjs"],
      registries: [],
    });
  });

  it("reads several dependencies from one line", () => {
    const result = runGuard(unitTree(), "unit.mjs", ["U-002", "--json"]);
    assert.deepEqual(JSON.parse(result.stdout).dependsOn, ["U-000", "U-001"]);
  });

  it("fails on an unknown identifier, an unknown option and a missing identifier", () => {
    const root = unitTree();
    const unknownUnit = runGuard(root, "unit.mjs", ["U-999"]);
    assert.equal(unknownUnit.status, 1);
    assert.match(unknownUnit.stderr, /U-999/);
    assert.equal(runGuard(root, "unit.mjs", ["U-001", "--nope"]).status, 1);
    assert.equal(runGuard(root, "unit.mjs", []).status, 1);
  });

  it("fails when spec.md is missing", () => {
    const root = makeTree({ "README.md": "no spec here\n" });
    installGuards(root);
    assert.equal(runGuard(root, "unit.mjs", ["U-001"]).status, 1);
  });
});

describe("scripts/check-forbidden.mjs", () => {
  function forbiddenTree(files) {
    const root = makeTree(files);
    installGuards(root);
    prepareRepository(root);
    return root;
  }

  function expectFinding(files, expected) {
    const result = runGuard(forbiddenTree(files), "check-forbidden.mjs");
    assert.equal(result.status, 1, `expected a finding, stdout: ${result.stdout}`);
    assert.match(result.stderr, expected);
    return result;
  }

  it("passes a tree that holds nothing but Lectern's own content", () => {
    const root = forbiddenTree({
      "apps/web/src/index.ts": 'export const title = "New reader";\n',
      "packages/core/package.json": '{ "name": "@lectern/core", "dependencies": { "zod": "4.6.7" } }\n',
    });
    const result = runGuard(root, "check-forbidden.mjs");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /clean/);
  });

  it("finds the reference product's name whatever its letter case", () => {
    expectFinding({ "apps/web/src/brand.ts": `export const brand = "${PRODUCT_NAME.toLowerCase()}";\n` }, /apps\/web\/src\/brand\.ts:1/);
    expectFinding({ "apps/web/src/brand.ts": `export const brand = "${PRODUCT_NAME.toUpperCase()}";\n` }, /brand\.ts:1/);
  });

  it("finds an excluded-platform path segment", () => {
    expectFinding({ [`apps/${APPLE_DIRECTORY}/App.tsx`]: "export const app = 1;\n" }, new RegExp(`apps/${APPLE_DIRECTORY}/App\\.tsx`));
  });

  it("finds excluded-platform file names", () => {
    expectFinding({ "apps/web/Podfile": "platform :ios\n" }, /apps\/web\/Podfile/);
    expectFinding({ "packages/ui/Widget.swift": "struct Widget {}\n" }, /Widget\.swift/);
    expectFinding({ "packages/ui/Widget.xcodeproj": "project\n" }, /Widget\.xcodeproj/);
  });

  it("finds an iOS platform branch in either quote style", () => {
    expectFinding({ "apps/web/src/platform.ts": `export const mobile = ${IOS_BRANCH_SINGLE};\n` }, /apps\/web\/src\/platform\.ts:1/);
    expectFinding({ "apps/web/src/platform.ts": `export const mobile = ${IOS_BRANCH_DOUBLE};\n` }, /platform\.ts:1/);
  });

  it("finds every leftover source marker", () => {
    const body = [WORK_MARKER, FIXUP_MARKER, SUPPRESSED_ERROR].join("\n");
    const result = expectFinding({ "scripts/legacy.mjs": `${body}\n` }, /scripts\/legacy\.mjs:1/);
    assert.match(result.stderr, /scripts\/legacy\.mjs:2/);
    assert.match(result.stderr, /scripts\/legacy\.mjs:3/);
  });

  it("finds a banned dependency in a manifest, and leaves other manifests alone", () => {
    expectFinding(
      { "apps/web/package.json": '{ "dependencies": { "stripe": "1.0.0" } }\n' },
      /apps\/web\/package\.json — banned dependency/,
    );
    expectFinding(
      { "apps/web/package.json": '{ "devDependencies": { "@sentry/react": "9.0.0" } }\n' },
      /banned dependency \(@sentry\/\*\)/,
    );
    expectFinding({ "packages/x/package.json": '{ "dependencies": { "posthog-js": "1.0.0" } }\n' }, /banned dependency \(posthog\*\)/);
  });

  it("treats a bare dependency name as exact, not as a prefix", () => {
    const root = forbiddenTree({
      "apps/web/package.json": '{ "dependencies": { "striped-flag": "1.0.0", "@lectern/fixtures": "workspace:*" } }\n',
    });
    assert.equal(runGuard(root, "check-forbidden.mjs").status, 0);
  });

  it("fails when a scanned package.json cannot be parsed", () => {
    const result = runGuard(forbiddenTree({ "apps/web/package.json": "{ not json\n" }), "check-forbidden.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot complete the scan/);
  });

  it("fails outside a git repository and on an unexpected argument", () => {
    const root = makeTree({ "apps/web/src/index.ts": "export const title = 1;\n" });
    installGuards(root);
    assert.equal(runGuard(root, "check-forbidden.mjs").status, 1);
    assert.equal(runGuard(root, "check-forbidden.mjs", ["--nope"]).status, 1);
  });
});

const SCOPE_SPEC = [
  "# Spec",
  "",
  "### U-898 — Registry provider",
  "",
  "**Required File Outputs**",
  "- `apps/x/registry.ts` — registry entry (registry)",
  "",
  "### U-900 — Target unit",
  "",
  "**Inputs & Dependencies**",
  "- Depends on: U-898",
  "",
  "**Required File Outputs**",
  "- `apps/x/body.txt` — deliverable",
  "",
].join("\n");

describe("scripts/check-scope.mjs", () => {
  function scopeTree(files = {}, subject = "feat(U-000): base tree") {
    const root = makeTree({ "spec.md": SCOPE_SPEC, ...files });
    installGuards(root);
    prepareRepository(root, subject);
    return root;
  }

  it("passes when every change is a declared output", () => {
    const root = scopeTree();
    writeFile(root, "apps/x/body.txt", "delivered\n");
    const result = runGuard(root, "check-scope.mjs", ["U-900"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /all allowed/);
  });

  it("fails and lists a change outside the unit's outputs", () => {
    const root = scopeTree();
    writeFile(root, "apps/x/body.txt", "delivered\n");
    writeFile(root, "apps/x/stray.txt", "not mine\n");
    const result = runGuard(root, "check-scope.mjs", ["U-900"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /apps\/x\/stray\.txt/);
    assert.doesNotMatch(result.stderr, /apps\/x\/body\.txt/);
  });

  it("allows a path a lower-numbered unit marked (registry)", () => {
    const root = scopeTree();
    writeFile(root, "apps/x/registry.ts", "export const registry = {};\n");
    assert.equal(runGuard(root, "check-scope.mjs", ["U-900"]).status, 0);
  });

  it("allows the ledger, the unit's evidence file, any package.json and the lockfile", () => {
    const root = scopeTree();
    writeFile(root, "docs/status.md", "| U-900 | DONE |\n");
    writeFile(root, "docs/evidence/U-900.md", "# Evidence\n");
    writeFile(root, "apps/x/package.json", '{ "name": "@lectern/x" }\n');
    writeFile(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    writeFile(root, "apps/x/body.txt", "delivered\n");
    const result = runGuard(root, "check-scope.mjs", ["U-900"]);
    assert.equal(result.status, 0, result.stderr);
  });

  it("treats every tracked file as changed when no unit commit exists", () => {
    const root = scopeTree({ "apps/x/stray.txt": "not mine\n" }, "chore: initial import");
    const result = runGuard(root, "check-scope.mjs", ["U-900"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /apps\/x\/stray\.txt/);
    assert.match(result.stderr, /spec\.md/);
  });

  it("fails on an unknown unit and on a missing identifier", () => {
    const root = scopeTree();
    assert.equal(runGuard(root, "check-scope.mjs", ["U-901"]).status, 1);
    assert.equal(runGuard(root, "check-scope.mjs", []).status, 1);
  });
});

describe("scripts/check-isomorphic.mjs", () => {
  function isomorphicTree(files) {
    const root = makeTree(files);
    installGuards(root);
    return root;
  }

  it("passes a graph that stays inside the isomorphic entry", () => {
    const root = isomorphicTree({
      "packages/core/src/index.ts": 'export * from "./model";\n',
      "packages/core/src/model.ts": "export const model = { tokenizerVersion: 1 };\n",
    });
    const result = runGuard(root, "check-isomorphic.mjs");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /clean/);
  });

  it("fails when the entry reaches a Node-only parser module", () => {
    const root = isomorphicTree({
      "packages/core/src/index.ts": 'export * from "./parsers/pdf";\n',
      "packages/core/src/parsers/pdf.ts": "export const parsePdf = () => null;\n",
    });
    const result = runGuard(root, "check-isomorphic.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Node-only parser import/);
  });

  it("fails on a Node built-in reached through another module", () => {
    const root = isomorphicTree({
      "packages/core/src/index.ts": 'export * from "./model";\n',
      "packages/core/src/model.ts": 'import { readFileSync } from "node:fs";\nexport const read = readFileSync;\n',
    });
    const result = runGuard(root, "check-isomorphic.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /model\.ts:1/);
    assert.match(result.stderr, /Node built-in/);
  });

  it("fails on a DOM runtime import", () => {
    const root = isomorphicTree({
      "packages/core/src/index.ts": 'import { useState } from "react";\nexport const hook = useState;\n',
    });
    const result = runGuard(root, "check-isomorphic.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /DOM or React Native runtime/);
  });

  it("notices an entry that does not exist yet and exits 0", () => {
    const root = isomorphicTree({ "packages/core/README.md": "core lives here\n" });
    const result = runGuard(root, "check-isomorphic.mjs");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /does not exist yet/);
  });
});
