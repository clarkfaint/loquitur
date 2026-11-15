# spec.md — Lectern Unit Contracts

68 atomic Unit Contracts in 5 phases. Execute them in numeric order, one per session, under the rules in `AGENTS.md`. Architecture references (`F§n.n`) point into `features.md`.

## How to read a contract

Every contract has exactly six fields.

| Field | Meaning |
|---|---|
| **Unit ID & Title** | The identifier used in `docs/status.md`, commit messages, and evidence file names. |
| **Inputs & Dependencies** | `Depends on:` units that must be `DONE`. `Reads:` the `F§` sections to read. `Uses:` exact files or packages from earlier units. `Installs:` the only packages you may add. `Patch scope:` files of earlier units this contract may edit (absent means none). |
| **REA Inspection Target & Method** | One target from AGENTS.md §3.1, the allowed tools, the steps, and the questions the evidence file must answer. `Target: N/A` means do not call REA; write the evidence file with `Inspection: N/A`. |
| **Forbidden Actions** | Unit-specific guardrails. The hard rules in AGENTS.md always apply in addition. |
| **Required File Outputs** | The complete list of files to create. Each path is followed by what it must contain. A path marked `(registry)` is append-only for later units. |
| **Pass/Fail Verification Test** | The exact command to run from the repository root. The unit passes only when it exits 0 and the listed pass conditions hold. |

Conventions used in every contract:

- All commands run from the repository root with a POSIX shell.
- `pnpm --filter <pkg> exec vitest run <path>` runs only the named tests.
- Tests use the `mock` TTS engine (`F§6`) and the mock LLM server unless stated otherwise.
- Workspace packages export TypeScript source directly (`"exports": { ".": "./src/index.ts" }`); there is no per-package build step. Bundlers and Vitest compile them.
- Each new workspace package gets `package.json` (`private: true`, `type: module`, scripts `test: vitest run` and `typecheck: tsc --noEmit`), `tsconfig.json` extending `tsconfig.base.json`, and `vitest.config.ts`.

## Unit index

| Phase | Units | Scope |
|---|---|---|
| 1 | U-000 – U-022 | Monorepo, shared core engine, TTS adapters, engine hub |
| 2 | U-023 – U-037 | Web app and Chrome extension |
| 3 | U-038 – U-044 | Desktop app (Windows, Linux) |
| 4 | U-045 – U-053 | Android app |
| 5 | U-054 – U-067 | Self-hosted sync, library, AI summaries, release audit |

---

# Phase 1 — Monorepo & Shared Core Engine

### U-000 — Preflight, ledgers, and inspection probes

**Unit ID & Title:** U-000 — Preflight, ledgers, and inspection probes

**Inputs & Dependencies**
- Depends on: none
- Reads: F§3.1, F§13
- Uses: `git` (run `git init -b main` only if `.git` is absent)

**REA Inspection Target & Method**
- Target: N/A — infrastructure unit. Do not call REA.

**Forbidden Actions**
- Do not install any package or create `package.json`; this unit uses only Node built-ins.
- Do not put any reference-product name, URL, or content in the probe files.
- Do not create anything under `targets/` other than the files listed below.
- Do not attempt to install missing system tools; report them.

**Required File Outputs**
- `.gitignore` — ignores `node_modules/`, `dist/`, `.output/`, `.wxt/`, `out/`, `build/`, `.turbo/`, `test-results/`, `playwright-report/`, `data/`, `*.local`, `infra/.env`, `apps/android/android/`, `apps/android/.expo/`, and everything under `targets/` except `targets/README.md` and `targets/probe/`.
- `scripts/preflight.mjs` — zero-dependency Node script. `--phase <1|2|3|4|5>` checks, in order: Node ≥ 24, `pnpm`, `git`, at least one system font via `fc-list` (phase 1); `xvfb-run` on Linux (phase 3); `java` ≥ 17, `adb`, existing `ANDROID_HOME` (phase 4); `docker compose version` (phase 5). Each phase includes the checks of lower phases. Prints one line per check (`OK` / `MISSING`), writes `docs/preflight.json`, and exits 1 if a check for the requested phase is missing. `--targets` lists which `T-*` paths from AGENTS.md §3.1 exist and always exits 0.
- `docs/status.md` — title, one paragraph explaining the ledger, and the table header `| Unit | Status | Date | Commit | Note |`.
- `targets/README.md` — operator instructions: start Chrome with `--remote-debugging-port=9222` and a dedicated `--user-data-dir`; where to copy the extension directory, the Windows package, and the APK (`adb shell pm path <package>` then `adb pull`); how to serve the probe page; which probe file to import into the reference product and when.
- `targets/probe/probe.txt` — original text, 350–500 words, containing: a title line; the six tokenizer golden inputs from F§5.3 embedded in prose; a decimal number; a bulleted list of three items; one sentence longer than 420 characters; a quoted sentence.
- `targets/probe/article.html` — the same text as a valid HTML article with `<header>`, `<nav>`, `<aside>`, and `<footer>` furniture around an `<article>` containing `h1`, `h2`, `p`, `ul`, and `blockquote`.
- `targets/probe/serve.mjs` — zero-dependency static server for `targets/probe/` on `127.0.0.1:4173`.

**Pass/Fail Verification Test**
```sh
node scripts/preflight.mjs --phase 1 \
  && node scripts/preflight.mjs --targets \
  && test -s docs/status.md && test -s targets/probe/article.html \
  && git check-ignore -q targets/android/base.apk \
  && ! git check-ignore -q targets/probe/probe.txt \
  && node -e "const t=require('fs').readFileSync('targets/probe/probe.txt','utf8');const n=t.split(/\s+/).length;if(n<350||n>500||!t.includes('Roe v. Wade'))process.exit(1)"
```
Pass: exit code 0 and `docs/preflight.json` exists.

---

### U-001 — Monorepo scaffold and guard scripts

**Unit ID & Title:** U-001 — Monorepo scaffold and guard scripts

**Inputs & Dependencies**
- Depends on: U-000
- Reads: F§2.1, F§2.3, F§3.1; AGENTS.md §5 and §6
- Installs (root devDependencies, exact): `typescript`, `turbo`, `@biomejs/biome`, `vitest`

**REA Inspection Target & Method**
- Target: N/A — infrastructure unit. Do not call REA.

**Forbidden Actions**
- Do not create any directory under `packages/` or `apps/` in this unit.
- Do not add ESLint, Prettier, Jest, Nx, Lerna, Husky, or a CI workflow.
- Do not write the reference product's name literally in `check-forbidden.mjs`; assemble it from two string fragments so the script does not flag itself.
- Do not make any guard script exit 0 when it cannot parse its input.

**Required File Outputs**
- `package.json` — `private: true`, `name: "lectern"`, `packageManager: "pnpm@12.18.0"`, `engines.node: ">=24"`, scripts `lint` (`biome check .`), `typecheck` (`turbo run typecheck`), `test` (`turbo run test`), `build` (`turbo run build`).
- `pnpm-workspace.yaml` — `packages/*` and `apps/*`.
- `turbo.json` — tasks `typecheck`, `test`, `build` (`build` outputs `dist/**`, `.output/**`, `out/**`).
- `tsconfig.base.json` — `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `module: "ESNext"`, `moduleResolution: "Bundler"`, `target: "ES2022"`, `verbatimModuleSyntax`, `noEmit`.
- `biome.json` — formatter and linter on; ignores the generated paths from `.gitignore`, `targets/`, and `**/generated/**`.
- `scripts/unit.mjs` — `node scripts/unit.mjs U-0NN` prints that contract from `spec.md` (from its `### U-0NN ` heading to the next `### U-` heading or end of file). Exits 1 for an unknown ID. `--json` prints `{ id, title, dependsOn[], patchScope[], outputs[], registries[] }`, where `outputs` are the backticked paths that start each bullet under *Required File Outputs*, `registries` are those marked `(registry)`, and `patchScope` are the backticked paths on the `Patch scope:` line (that line contains paths only; explanations follow on a `Patch notes:` line).
- `scripts/check-forbidden.mjs` — scans git-tracked files under `apps/`, `packages/`, `infra/`, and `scripts/`. Fails (exit 1, listing file and line) on: the reference product's name in any letter case; a path segment `ios/`; files named `Podfile`, `*.xcodeproj`, `*.xcworkspace`, `*.swift`, `*.m`, `*.mm`; the strings `Platform.OS === 'ios'`, `Platform.OS === "ios"`, `TODO`, `FIXME`, `@ts-ignore`; a dependency in any `package.json` matching `stripe`, `@stripe/*`, `react-native-purchases`, `@sentry/*`, `posthog*`, `mixpanel*`, `@amplitude/*`, `firebase`, `@react-native-firebase/*`, `@rntp/player`, `react-native-track-player`.
- `scripts/check-scope.mjs` — `node scripts/check-scope.mjs U-0NN`. Base = the most recent commit whose subject starts with `feat(U-`, `blocked(U-`, or `chore(spec)` and does not name the current unit; if there is none, the empty tree. Changed = files differing from base plus untracked, unignored files. Allowed = the unit's `outputs` and `patchScope`; `pnpm-lock.yaml`; `pnpm-workspace.yaml`; `docs/status.md`; `docs/evidence/<UNIT>.md`; any `package.json`; `packages/*/src/index.ts`; `packages/*/src/*/index.ts`; every path marked `(registry)` by a lower-numbered unit. Exits 1 and lists each changed path that is not allowed.
- `scripts/check-isomorphic.mjs` — follows relative imports starting at `packages/core/src/index.ts` and fails if any reached file is under `packages/core/src/parsers/`, or imports a `node:` module, `fs`, `path`, `react`, `react-native`, or an `expo-*` package. Exits 0 with a notice when `packages/core/src/index.ts` does not exist yet.
- `scripts/__tests__/guards.test.mjs` — `node:test` tests that run each guard against temporary directories: unit extraction and `--json` fields; one positive and one negative case for each forbidden pattern class; scope pass, scope violation, and registry allowance; isomorphic pass and violation.

**Pass/Fail Verification Test**
```sh
pnpm install \
  && pnpm -w run lint \
  && node --test "scripts/__tests__/*.test.mjs" \
  && node scripts/unit.mjs U-001 | grep -q "Monorepo scaffold and guard scripts" \
  && node scripts/unit.mjs U-001 --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.exit(JSON.parse(s).outputs.length===10?0:1))" \
  && ! node scripts/unit.mjs U-999 >/dev/null 2>&1 \
  && node scripts/check-forbidden.mjs \
  && node scripts/check-scope.mjs U-001
```
Pass: exit code 0.

---

### U-002 — Core: document model, normalization, identifiers

**Unit ID & Title:** U-002 — Core: document model, normalization, identifiers

**Inputs & Dependencies**
- Depends on: U-001
- Reads: F§5.1, F§5.2
- Installs (`packages/core`, exact): `zod`

**REA Inspection Target & Method**
- Target: N/A — the document model is a Lectern design with no reference counterpart to observe. Do not call REA.

**Forbidden Actions**
- Do not use `node:crypto`, `crypto.subtle`, or any hashing package; `sha256Hex` is synchronous, pure TypeScript, and isomorphic.
- Do not add fields to, remove fields from, or rename any type in F§5.1.
- Do not import from Node, the DOM, React, or React Native anywhere in this unit.

**Required File Outputs**
- `packages/core/package.json` — name `@lectern/core`; `exports`: `"."` → `./src/index.ts`, `"./parsers"` → `./src/parsers/index.ts`, `"./testing"` → `./src/testing/index.ts`.
- `packages/core/tsconfig.json` — extends the base config.
- `packages/core/vitest.config.ts` — Node environment, includes `src/**/*.test.ts`.
- `packages/core/src/index.ts` — re-exports this unit's modules.
- `packages/core/src/model.ts` — every type in F§5.1 and a zod schema for each (`DocumentModelSchema`, `BlockSchema`, `SentenceSchema`, `WordSchema`, `PositionSchema`, `PdfAnchorSchema`); types are inferred from the schemas.
- `packages/core/src/normalize.ts` — `normalizeText(s: string): string` per F§5.2.
- `packages/core/src/hash.ts` — `sha256Hex(input: string | Uint8Array): string`; strings are encoded as UTF-8.
- `packages/core/src/ids.ts` — `docIdFor(blockTexts: string[]): string` per F§5.2.
- `packages/core/src/__tests__/model.test.ts` — a valid document parses; each of 6 distinct invalid documents is rejected.
- `packages/core/src/__tests__/normalize.test.ts` — one test per normalization step, plus idempotence (`normalize(normalize(x)) === normalize(x)`).
- `packages/core/src/__tests__/hash.test.ts` — `sha256Hex('')` = `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`; `sha256Hex('abc')` = `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad`; a 1 000-character multi-byte string equals the value computed in the test with `node:crypto`.
- `packages/core/src/__tests__/ids.test.ts` — both `docId` golden values from F§5.2.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/core exec vitest run src/__tests__/model.test.ts src/__tests__/normalize.test.ts src/__tests__/hash.test.ts src/__tests__/ids.test.ts \
  && pnpm --filter @lectern/core run typecheck \
  && node scripts/check-isomorphic.mjs
```
Pass: exit code 0 and all four test files report passing tests.

---

### U-003 — Core: sentence and word tokenizer

**Unit ID & Title:** U-003 — Core: sentence and word tokenizer

**Inputs & Dependencies**
- Depends on: U-002
- Reads: F§5.1, F§5.3
- Uses: `packages/core/src/model.ts`, `packages/core/src/normalize.ts`

**REA Inspection Target & Method**
- Target: `T-WEB`, with `targets/probe/probe.txt` open in the reference reader.
- Tools: `list_browser_targets`, `capture_browser_scenario`, `capture_web_screenshot`.
- Method: (1) `list_browser_targets` on `http://127.0.0.1:9222`; select the reader tab. (2) One `capture_browser_scenario` in connect mode with that `target_id` and the tab's current URL as `start_url`; declared actions: click the play control, wait 8 s, click it again to pause; capture accessibility text. (3) `capture_web_screenshot` of the paused state.
- Questions: Where does the sentence highlight begin and end around `Dr.`, `v.`, `U.S.`, `3.15`, and a quoted sentence? Does the word highlight include attached punctuation? Is there one highlight level or two (sentence and word)?

**Forbidden Actions**
- Do not use `Intl.Segmenter`, a regular-expression lookbehind, or any NLP or sentence-splitting package.
- Do not change the abbreviation sets or the golden cases in F§5.3, even if the inspection shows the reference product splitting differently; record the difference under *Deviation proposals*.
- Do not trim or alter characters inside a sentence or word range; ranges index the block text exactly.

**Required File Outputs**
- `packages/core/src/abbreviations.ts` — `CASE_INSENSITIVE_ABBREVIATIONS` and `EXACT_CASE_ABBREVIATIONS` as `ReadonlySet<string>`, with exactly the members listed in F§5.3.
- `packages/core/src/tokenizer.ts` — `TOKENIZER_VERSION = 1`; `splitSentences(blockText): { charStart, charEnd, text }[]`; `splitWords(sentenceText): Word[]`; `tokenizeBlock(blockText, firstSentenceIndex, blockIndex): Sentence[]`.
- `packages/core/src/__tests__/tokenizer.test.ts` — the six golden cases from F§5.3 verbatim; `blockText.slice(charStart, charEnd) === sentence.text` for every sentence; `sentence.text.slice(w.charStart, w.charEnd) === w.text` for every word; every non-whitespace character of the block lies in exactly one word; a 900-character sentence without terminators splits into pieces of at most 400 characters; a punctuation-only token merges into its neighbour; empty and whitespace-only input yields no sentences.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/core exec vitest run src/__tests__/tokenizer.test.ts \
  && pnpm --filter @lectern/core run typecheck \
  && node scripts/check-isomorphic.mjs
```
Pass: exit code 0; the test file contains the six golden inputs as literal strings (`grep -c "Roe v. Wade" packages/core/src/__tests__/tokenizer.test.ts` ≥ 1).

---

### U-004 — Core: document builder, plain-text parser, skip classifier

**Unit ID & Title:** U-004 — Core: document builder, plain-text parser, skip classifier

**Inputs & Dependencies**
- Depends on: U-003
- Reads: F§5.1, F§5.2, F§5.4 (TXT / Markdown row, skip classification)
- Uses: `packages/core/src/tokenizer.ts`, `packages/core/src/ids.ts`, `packages/core/src/normalize.ts`

**REA Inspection Target & Method**
- Target: N/A — skip behaviour on paged documents is inspected in U-007. Do not call REA.

**Forbidden Actions**
- Do not add a Markdown library; implement only the constructs listed in F§5.4.
- Do not delete skipped blocks from the model; set `skip: true`.
- Do not modify document text when stripping citations; `stripCitations` returns a new string for synthesis only.
- Do not place these modules under `src/parsers/`; they are isomorphic and Android calls them directly.

**Required File Outputs**
- `packages/core/src/builder.ts` — `RawBlock` (`{ kind, level?, page?, text, fontRatio?, yRatio? }`), `DocumentMetaInput` (`{ title?, lang?, source }`), and `buildDocument(rawBlocks, meta): DocumentModel`. Normalizes text, drops empty blocks, runs `classifySkip`, tokenizes, assigns global sentence indexes, counts, and `docId`. Title defaults to the first heading, else the first 60 characters of the first block.
- `packages/core/src/skip.ts` — `classifySkip(rawBlocks): RawBlock[]` and `stripCitations(text): string` per F§5.4.
- `packages/core/src/text.ts` — `parseText(input: string): RawBlock[]` and `parseMarkdown(input: string): RawBlock[]`.
- `packages/core/src/playable.ts` — `playableSentences(doc, { skipFurniture }): number[]` (global sentence indexes in order) and `sentenceAt(doc, index): Sentence`.
- `packages/core/src/__tests__/builder.test.ts` — output validates against `DocumentModelSchema`; sentence indexes are contiguous from 0; `docId` matches the F§5.2 golden for the two golden inputs; counts are correct.
- `packages/core/src/__tests__/skip.test.ts` — a 5-page synthetic input with a repeated header and `Page N` footer marks exactly those blocks; a 2-page input marks nothing; `stripCitations('See [12] and [3, 4].')` returns `See and .` with single spaces.
- `packages/core/src/__tests__/text.test.ts` — headings, list items, quotes, paragraphs, and inline marker stripping.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/core exec vitest run src/__tests__/builder.test.ts src/__tests__/skip.test.ts src/__tests__/text.test.ts \
  && pnpm --filter @lectern/core run typecheck \
  && node scripts/check-isomorphic.mjs
```
Pass: exit code 0.

---

### U-005 — Fixture generator

**Unit ID & Title:** U-005 — Fixture generator

**Inputs & Dependencies**
- Depends on: U-001
- Reads: F§5.4, F§5.5
- Installs (`packages/fixtures`, exact, current registry versions): `pdf-lib`, `@napi-rs/canvas`, `fflate`

**REA Inspection Target & Method**
- Target: N/A — fixtures are original Lectern test data. Do not call REA.

**Forbidden Actions**
- Do not copy text from any book, article, website, or the reference product; write the fixture prose yourself.
- Do not download fonts, images, or sample documents.
- Do not generate fixtures at test time; commit the generated files.
- If `@napi-rs/canvas` reports zero available font families, stop and write `BLOCKED`; do not commit blank images.

**Required File Outputs**
- `packages/fixtures/package.json` — name `@lectern/fixtures`, script `generate: node generate.mjs`.
- `packages/fixtures/source/lighthouse.md` — original prose, 700–900 words: one `#` title, three `##` chapters, a three-item list, a block quote, one word hyphenated across a line break in the PDF layout, and one footnote.
- `packages/fixtures/generate.mjs` — builds every file below from `source/lighthouse.md` into `packages/fixtures/generated/`. `--check` builds into a temporary directory and validates magic bytes, non-zero sizes, and PDF page counts, then exits 0 or 1.
- `packages/fixtures/generated/sample.txt` — plain text.
- `packages/fixtures/generated/sample.md` — the Markdown source.
- `packages/fixtures/generated/article.html` — article with `nav`, `aside`, and `footer` furniture.
- `packages/fixtures/generated/text.pdf` — 5 pages, real text layer, running header `Lighthouse Notes` and footer `Page N` on every page, chapter headings at 1.5× body size, the hyphenated line break, and the footnote in a smaller font at the bottom of a page.
- `packages/fixtures/generated/page.png` — one page of body text rendered as a 1240×1754 image, black on white, 28 px sans-serif.
- `packages/fixtures/generated/scanned.pdf` — 2 pages, each a full-page embedded image of rendered text, no text layer.
- `packages/fixtures/generated/book.epub` — valid EPUB 3: `mimetype` first and stored uncompressed, `META-INF/container.xml`, OPF with a 3-chapter spine, a `nav` document, and a cover page.
- `packages/fixtures/generated/doc.docx` — minimal valid DOCX with a title, two headings, paragraphs, and a list.
- `packages/fixtures/make-icons.mjs` — `node make-icons.mjs --out <dir> --sizes 16,32,48,128` writes `<size>.png` files of an original geometric mark (a rounded square with three horizontal bars of decreasing length) drawn with `@napi-rs/canvas`; used later for extension, desktop, and Android icons.
- `packages/fixtures/generated/expected.json` — `{ title, chapterTitles[], firstSentenceOfChapter[], headerText, footerPattern, footnoteStart, dehyphenatedWord, pageImageWords[] }` used by parser tests.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/fixtures run generate \
  && node packages/fixtures/generate.mjs --check \
  && for f in sample.txt sample.md article.html text.pdf page.png scanned.pdf book.epub doc.docx expected.json; do test -s packages/fixtures/generated/$f || exit 1; done \
  && head -c 4 packages/fixtures/generated/text.pdf | grep -q "%PDF" \
  && d=$(mktemp -d) && node packages/fixtures/make-icons.mjs --out "$d" --sizes 16,128 && test -s "$d/16.png" && test -s "$d/128.png" \
  && node scripts/check-forbidden.mjs
```
Pass: exit code 0.

---

### U-006 — Core parser: HTML and article extraction

**Unit ID & Title:** U-006 — Core parser: HTML and article extraction

**Inputs & Dependencies**
- Depends on: U-004, U-005
- Reads: F§5.4 (HTML / URL row)
- Uses: `packages/core/src/builder.ts`, `packages/fixtures/generated/article.html`, `packages/fixtures/generated/expected.json`
- Installs (`packages/core`, exact): `@mozilla/readability`, `linkedom`; devDependency `@lectern/fixtures` (`workspace:*`)

**REA Inspection Target & Method**
- Target: N/A — in-page article detection is inspected in U-032 on `T-EXT-RUN`. Do not call REA.

**Forbidden Actions**
- Do not use `jsdom`, `cheerio`, or a headless browser.
- Do not fetch URLs in this unit; `parseHtml` takes a string.
- Do not execute scripts or load subresources from the parsed HTML.
- Do not import this module from `packages/core/src/index.ts`.

**Required File Outputs**
- `packages/core/src/parsers/index.ts` — re-exports parser modules (Node-only entry).
- `packages/core/src/parsers/html-map.ts` — `mapElementToRawBlocks(root: Element): RawBlock[]` mapping `h1–h6`, `p`, `li`, `blockquote`, `figcaption`, and the block-level fallback from F§5.4.
- `packages/core/src/parsers/html.ts` — `parseHtml(html, opts?: { url?: string }): { rawBlocks, title, lang }`. Uses Readability on a linkedom document; falls back to `body` when Readability returns null.
- `packages/core/src/parsers/__tests__/html.test.ts` — the fixture article yields the expected title and chapter headings; no block contains text from `nav`, `aside`, or `footer`; a document with no article structure uses the fallback; `<script>` and `<style>` content never appears.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/core exec vitest run src/parsers/__tests__/html.test.ts \
  && pnpm --filter @lectern/core run typecheck \
  && node scripts/check-isomorphic.mjs
```
Pass: exit code 0.

---

### U-007 — Core parser: PDF text with anchors

**Unit ID & Title:** U-007 — Core parser: PDF text with anchors

**Inputs & Dependencies**
- Depends on: U-006
- Reads: F§5.1 (`PdfAnchor`), F§5.4 (PDF row, skip classification)
- Uses: `packages/core/src/builder.ts`, `packages/core/src/skip.ts`, `packages/fixtures/generated/text.pdf`, `packages/fixtures/generated/expected.json`
- Installs (`packages/core`, exact): `pdfjs-dist`

**REA Inspection Target & Method**
- Target: `T-WEB`, with `packages/fixtures/generated/text.pdf` imported by the operator and open in the reference reader.
- Tools: `list_browser_targets`, `capture_browser_scenario`, `capture_web_screenshot`.
- Method: one connect-mode scenario: click play, wait 10 s, pause, scroll to page 2, capture accessibility text; then one screenshot.
- Questions: Are the running header and page-number footer spoken or skipped by default? Is there a visible control for skipping them? Is the hyphenated word read as one word? Is the footnote read in place, at the end, or skipped? Does the highlight sit on the original page image or on reflowed text?

**Forbidden Actions**
- Do not render pages to images in this unit (that is U-010).
- Do not use `pdf-parse`, `pdf2json`, or Poppler binaries.
- Do not load `pdfjs-dist` from a CDN; import the legacy build from `node_modules` and disable the worker for Node.
- Do not reorder text items within a page except by the line-grouping rule in F§5.4.

**Required File Outputs**
- `packages/core/src/parsers/pdf-layout.ts` — pure functions over `{ str, x, y, width, height, fontSize, itemIndex }[]`: `groupLines`, `groupParagraphs`, `dehyphenate`, `detectHeadings`. No `pdfjs-dist` import.
- `packages/core/src/parsers/pdf.ts` — `parsePdf(bytes, opts?): Promise<{ rawBlocks, title, pageCount, wordAnchors }>`, where `wordAnchors` maps each word of each block to `{ page, itemIndex, charStart, charEnd }`; and `anchorsFor(document, wordAnchors): PdfAnchor[]`.
- `packages/core/src/parsers/__tests__/pdf-layout.test.ts` — synthetic items: single-column line grouping, paragraph gap threshold, de-hyphenation, heading detection at 1.25×.
- `packages/core/src/parsers/__tests__/pdf.test.ts` — on `text.pdf`: `pageCount` is 5; chapter headings match `expected.json`; header and footer blocks on all 5 pages have `skip: true`; the de-hyphenated word appears whole; the footnote block is `footnote` with `skip: true`; every word of every non-skipped block has exactly one anchor and each anchor's `itemIndex` exists on its page.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/core exec vitest run src/parsers/__tests__/pdf-layout.test.ts src/parsers/__tests__/pdf.test.ts \
  && pnpm --filter @lectern/core run typecheck \
  && node scripts/check-isomorphic.mjs
```
Pass: exit code 0.

---

### U-008 — Core parser: EPUB

**Unit ID & Title:** U-008 — Core parser: EPUB

**Inputs & Dependencies**
- Depends on: U-006
- Reads: F§5.4 (EPUB row)
- Uses: `packages/core/src/parsers/html-map.ts`, `packages/fixtures/generated/book.epub`, `packages/fixtures/generated/expected.json`
- Installs (`packages/core`, exact): `fflate`

**REA Inspection Target & Method**
- Target: N/A — EPUB structure is defined by the public EPUB 3 specification. Do not call REA.

**Forbidden Actions**
- Do not use `epubjs`, `epub2`, or any EPUB library.
- Do not process DRM-protected files: if `META-INF/encryption.xml` lists content documents, fail with code `DRM_PROTECTED`. Never attempt decryption.
- Do not follow external references or load remote resources.

**Required File Outputs**
- `packages/core/src/parsers/epub.ts` — `parseEpub(bytes): Promise<{ rawBlocks, title, lang }>` per F§5.4: container → OPF → manifest and spine → XHTML documents in spine order via `mapElementToRawBlocks`; skips `nav` and cover items; title from OPF `dc:title`.
- `packages/core/src/parsers/__tests__/epub.test.ts` — the fixture yields the expected title and chapter titles in order; no navigation text appears; a zip without `META-INF/container.xml` fails with `INVALID_EPUB`; a synthetic `encryption.xml` listing a spine item fails with `DRM_PROTECTED`.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/core exec vitest run src/parsers/__tests__/epub.test.ts \
  && pnpm --filter @lectern/core run typecheck
```
Pass: exit code 0.

---

### U-009 — Core parser: DOCX

**Unit ID & Title:** U-009 — Core parser: DOCX

**Inputs & Dependencies**
- Depends on: U-006
- Reads: F§5.4 (DOCX row)
- Uses: `packages/core/src/parsers/html.ts`, `packages/core/src/parsers/html-map.ts`, `packages/fixtures/generated/doc.docx`
- Installs (`packages/core`, exact): `mammoth`

**REA Inspection Target & Method**
- Target: N/A — DOCX conversion is delegated to an open-source library. Do not call REA.

**Forbidden Actions**
- Do not parse `word/document.xml` by hand; use `mammoth.convertToHtml`.
- Do not support legacy `.doc`; reject it with `UNSUPPORTED_FORMAT`.
- Do not embed images or run macros.

**Required File Outputs**
- `packages/core/src/parsers/docx.ts` — `parseDocx(bytes): Promise<{ rawBlocks, title }>`; converts to HTML and maps with `mapElementToRawBlocks` (not Readability).
- `packages/core/src/parsers/__tests__/docx.test.ts` — the fixture yields the title, both headings with correct levels, the paragraphs, and three list items; an OLE2 `.doc` header is rejected.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/core exec vitest run src/parsers/__tests__/docx.test.ts \
  && pnpm --filter @lectern/core run typecheck
```
Pass: exit code 0.

---

### U-010 — Core: OCR pipeline and scanned-PDF fallback

**Unit ID & Title:** U-010 — Core: OCR pipeline and scanned-PDF fallback

**Inputs & Dependencies**
- Depends on: U-007
- Reads: F§5.5
- Uses: `packages/core/src/parsers/pdf.ts`, `packages/fixtures/generated/page.png`, `packages/fixtures/generated/scanned.pdf`, `packages/fixtures/generated/expected.json`
- Installs (`packages/core`, exact): `tesseract.js`, `@tesseract.js-data/eng`, `@napi-rs/canvas`
- Patch scope: `packages/core/src/parsers/pdf.ts`
- Patch notes: add an optional OCR engine option to the PDF parser and the fewer-than-20-characters page fallback from F§5.5; change nothing else.

**REA Inspection Target & Method**
- Target: N/A — hub OCR has no observable reference counterpart; the camera scanner is inspected in U-051. Do not call REA.

**Forbidden Actions**
- Do not let tesseract.js download language data at run time; load it from the installed `@tesseract.js-data/eng` package path.
- Do not call any cloud OCR service.
- Do not add PaddleOCR, OpenCV, or image pre-processing libraries.
- Do not place `OcrEngine` or `groupOcrLines` under `src/parsers/`; they are isomorphic and Android uses them.

**Required File Outputs**
- `packages/core/src/ocr.ts` — the `OcrEngine` interface from F§5.5 and `groupOcrLines(lines): RawBlock[]` (confidence filter, top-to-bottom order, paragraph gap rule).
- `packages/core/src/parsers/ocr-tesseract.ts` — `createTesseractOcrEngine(opts?: { cacheDir?: string }): OcrEngine & { dispose(): Promise<void> }`; one reusable worker.
- `packages/core/src/parsers/pdf-raster.ts` — `rasterizePdfPage(bytes, pageNumber, dpi): Promise<Uint8Array>` (PNG) using `pdfjs-dist` and `@napi-rs/canvas`.
- `packages/core/src/parsers/image.ts` — `parseImage(bytes, ocr): Promise<{ rawBlocks, title }>`.
- `packages/core/src/__tests__/ocr.test.ts` — `groupOcrLines` on synthetic lines: drops confidence below 40, orders by position, splits paragraphs at the gap threshold.
- `packages/core/src/parsers/__tests__/ocr-tesseract.test.ts` — on `page.png`, at least 90% of `expected.pageImageWords` are recognized (case-insensitive word match); on `scanned.pdf` with the engine supplied, both pages yield text and no anchors; without an engine, `scanned.pdf` yields zero blocks and no error. Test timeout 120 s.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/core exec vitest run src/__tests__/ocr.test.ts src/parsers/__tests__/ocr-tesseract.test.ts src/parsers/__tests__/pdf.test.ts \
  && pnpm --filter @lectern/core run typecheck \
  && node scripts/check-isomorphic.mjs
```
Pass: exit code 0, including the unchanged U-007 PDF tests.

---

### U-011 — Core: unified document dispatcher

**Unit ID & Title:** U-011 — Core: unified document dispatcher

**Inputs & Dependencies**
- Depends on: U-008, U-009, U-010
- Reads: F§5.4 (dispatcher)
- Uses: all modules under `packages/core/src/parsers/`, `packages/core/src/builder.ts`, `packages/core/src/text.ts`, every file in `packages/fixtures/generated/`

**REA Inspection Target & Method**
- Target: N/A — format dispatch is internal plumbing. Do not call REA.

**Forbidden Actions**
- Do not trust the file extension or declared MIME type before checking magic bytes.
- Do not add parsers for formats not in F§5.4 (no RTF, MOBI, AZW, PPTX, audio, or video).
- Do not catch and hide parser errors; map them to `{ code, message }` with codes `UNSUPPORTED_FORMAT`, `INVALID_EPUB`, `DRM_PROTECTED`, `PARSE_FAILED`, `EMPTY_DOCUMENT`.

**Required File Outputs**
- `packages/core/src/parsers/dispatch.ts` — `sniffFormat(bytes, hint?: { mime?, filename? }): SourceKind | 'image' | null`; `ParseError` class; `parseDocument(input: { bytes: Uint8Array; mime?: string; filename?: string; url?: string }, deps?: { ocr?: OcrEngine }): Promise<{ document: DocumentModel; anchors?: PdfAnchor[] }>`.
- `packages/core/src/parsers/__tests__/dispatch.test.ts` — each fixture file parses to a schema-valid document with the expected title, with correct `source.kind`, when given (a) no hint, (b) a wrong extension; random bytes fail with `UNSUPPORTED_FORMAT`; an empty text file fails with `EMPTY_DOCUMENT`; `text.pdf` returns anchors and `book.epub` does not.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/core exec vitest run src/parsers \
  && pnpm --filter @lectern/core run typecheck \
  && node scripts/check-isomorphic.mjs
```
Pass: exit code 0; every parser test from U-006 to U-011 passes in one run.

---

### U-012 — Core: timing, speed, and progress math

**Unit ID & Title:** U-012 — Core: timing, speed, and progress math

**Inputs & Dependencies**
- Depends on: U-004
- Reads: F§5.6 (a) through (f)
- Uses: `packages/core/src/model.ts`, `packages/core/src/playable.ts`

**REA Inspection Target & Method**
- Target: `T-WEB`, probe document open.
- Tools: `list_browser_targets`, `capture_browser_scenario`, `inspect_web_page`.
- Method: one connect-mode scenario: click play, wait 5 s, open the speed control, select the highest offered speed, wait 5 s, pause; capture accessibility text and DOM for the speed control and any media element. Then one `inspect_web_page` of the paused state.
- Questions: What are the minimum, maximum, and step of the speed control, and its preset values? Is speed shown as a multiplier, words per minute, or both? Does the highlight keep pace at the highest speed, and does it stay on the last word during pauses or disappear? Is a media element's rate or pitch-preservation property visible (else `UNKNOWN`)?

**Forbidden Actions**
- Do not apply the playback rate to any timing; timings are media time (F§5.6).
- Do not use floating-point milliseconds in outputs; round with `Math.round` exactly where F§5.6 says.
- Do not change a golden value; if a test disagrees with F§5.6, fix the code.
- Do not add audio analysis, forced alignment, or speech-recognition code.

**Required File Outputs**
- `packages/core/src/timing.ts` — `WordTiming`, `estimateTimings(words, durationMs)`, `alignEngineTimings(words, engineTokens, durationMs): { timings, timingSource }`, `findActiveWord(timings, tMs)`.
- `packages/core/src/speed.ts` — `RATE_MIN = 0.5`, `RATE_MAX = 5.0`, `RATE_STEP = 0.05`, `RATE_PRESETS = [1, 1.5, 2, 3, 4.5]`, `clampRate(rate)`, `planSpeed(rate, sinkMaxRate)`.
- `packages/core/src/progress.ts` — `progressFraction(doc, position)`, `remainingMs(doc, position, rate, baseWpm)`, `updateBaseWpm(previous, words, durationMs)`.
- `packages/core/src/__tests__/timing.test.ts` — the F§5.6(a) golden; the four F§5.6(c) lookups; alignment cases: exact match, engine splits a word into two tokens, engine drops punctuation tokens, one unmatched word in the middle is interpolated between neighbours, fewer than 50% matched falls back to `estimated`; output is monotonic and clamped for 200 seeded random inputs.
- `packages/core/src/__tests__/speed.test.ts` — the five F§5.6(e) goldens; `clampRate` at and beyond both bounds; `effectiveRate` never exceeds `rate` for every rate from 0.5 to 5.0 in steps of 0.05 and `sinkMaxRate` in `{1, 2, 4, 16}`.
- `packages/core/src/__tests__/progress.test.ts` — fraction 0 at start and 1 at the last word; remaining time halves when rate doubles.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/core exec vitest run src/__tests__/timing.test.ts src/__tests__/speed.test.ts src/__tests__/progress.test.ts \
  && pnpm --filter @lectern/core run typecheck \
  && node scripts/check-isomorphic.mjs
```
Pass: exit code 0.

---

### U-013 — Core: player protocol and state machine

**Unit ID & Title:** U-013 — Core: player protocol and state machine

**Inputs & Dependencies**
- Depends on: U-012
- Reads: F§5.7, F§5.8
- Uses: `packages/core/src/timing.ts`, `packages/core/src/speed.ts`, `packages/core/src/playable.ts`, `packages/core/src/model.ts`

**REA Inspection Target & Method**
- Target: `T-WEB`, probe document open.
- Tools: `list_browser_targets`, `capture_browser_scenario`.
- Method: three connect-mode scenarios, each ending with an accessibility-text capture. (A) click play, wait 3 s, click a word two paragraphs ahead, wait 3 s. (B) click play, wait 3 s, change speed, wait 3 s, change voice, wait 5 s. (C) seek to the last paragraph, play to the end, wait 5 s.
- Questions: Which player states are visible to the user (loading, buffering, playing, paused, ended)? After clicking a word during playback, does playback continue from that word or from the start of its sentence? Does a speed change restart the current sentence? Does a voice change restart the sentence and show a loading state? What does the control show at the end of the document?

**Forbidden Actions**
- Do not touch `window`, `document`, `Audio`, timers, or any native module; time comes from an injected `Clock`.
- Do not add states, commands, or snapshot fields beyond F§5.7.
- Do not play audio in tests; use the fake sink.
- Do not couple the controller to HTTP; chunks come only through the injected `ChunkSource`.

**Required File Outputs**
- `packages/core/src/player/protocol.ts` — `PlayerState`, `PlayerCommand`, `PlayerSnapshot` and their zod schemas, exactly as F§5.7.
- `packages/core/src/player/interfaces.ts` — `AudioQueueSink`, `ChunkSource`, `ChunkRef` (F§5.8), `Clock` (`now()`, `setTimeout`, `clearTimeout`), `DocumentProvider` (`get(docId): Promise<DocumentModel | null>`).
- `packages/core/src/player/controller.ts` — `createPlayerController(deps: { sink, chunks, documents, clock, settings: { skipFurniture, skipCitations, lookaheadMs } })` returning `{ dispatch(cmd), snapshot(), subscribe(cb), activeWord(): { sentenceIndex, wordIndex }, dispose() }`. Implements the F§5.7 transition table and rules.
- `packages/core/src/testing/index.ts` — re-exports testing helpers.
- `packages/core/src/testing/fake-clock.ts` — manual clock with `advance(ms)`.
- `packages/core/src/testing/fake-sink.ts` — in-memory `AudioQueueSink` driven by the fake clock, configurable `maxRate`.
- `packages/core/src/testing/fake-chunk-source.ts` — deterministic `ChunkSource` with configurable delay and failure injection.
- `packages/core/src/testing/sink-conformance.ts` — `runAudioQueueSinkConformance(factory, env: { wait(ms): Promise<void>; makeChunk(durationMs): Promise<{ chunkId, uri, durationMs }> }): Promise<{ name: string; ok: boolean; error?: string }[]>`. Runner-agnostic. Cases: events fire in order across three chunks; `clear` stops and empties; `pause` freezes position; `seekInCurrent` moves position; `setRate(2)` roughly halves wall time; `queue-empty` fires once; `dispose` is idempotent.
- `packages/core/src/player/__tests__/controller.test.ts` — one test per row of the F§5.7 table; prefetch window size; skipped blocks are passed over and included when `skipFurniture` is off; sleep timer stops at the next sentence boundary; `seek` while playing resumes and while paused stays paused; `setRate` that changes `synthSpeed` refills the queue; a chunk failure enters `error` and `play` retries; the fake sink passes the conformance suite.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/core exec vitest run src/player \
  && pnpm --filter @lectern/core run typecheck \
  && node scripts/check-isomorphic.mjs
```
Pass: exit code 0.

---

### U-014 — Core: local-first store contracts and reference stores

**Unit ID & Title:** U-014 — Core: local-first store contracts and reference stores

**Inputs & Dependencies**
- Depends on: U-004
- Reads: F§5.9
- Uses: `packages/core/src/model.ts`, `packages/core/src/hash.ts`

**REA Inspection Target & Method**
- Target: N/A — storage is a Lectern design; library layout is inspected in U-027. Do not call REA.

**Forbidden Actions**
- Do not add user, account, owner, or tenant fields to any record.
- Do not implement network sync here; only the outbox and `applyRemote`.
- Do not use wall-clock time directly; stores take an injected `now()` and `deviceId`.
- Do not add entity kinds beyond the five in F§5.9.

**Required File Outputs**
- `packages/core/src/store/types.ts` — `DocumentMeta`, `Folder`, `Bookmark`, `Progress`, `EntityKind`, `Op`, `LibraryStore`, `BlobCache` and zod schemas for the records and `Op`, exactly as F§5.9.
- `packages/core/src/store/lww.ts` — `isNewer(a: { ts, deviceId }, b: { ts, deviceId }): boolean` per the LWW rule.
- `packages/core/src/store/memory-library-store.ts` — `createMemoryLibraryStore({ deviceId, now, newId })`.
- `packages/core/src/store/memory-blob-cache.ts` — `createMemoryBlobCache()`; URIs are `memory://<key>`.
- `packages/core/src/testing/library-store-conformance.ts` — `runLibraryStoreConformance(factory): Promise<{ name, ok, error? }[]>`. Cases: document round trip; list filtered by folder and by text; delete produces a tombstone and removes the model; folder, bookmark, progress, and setting round trips; each mutation appends exactly one op; `ackOps` removes them; `applyRemote` applies newer, ignores older, breaks ties by `deviceId`, and never appends to the outbox; cursor round trip; two stores exchanging all ops in both directions converge to equal state.
- `packages/core/src/testing/blob-cache-conformance.ts` — `runBlobCacheConformance(factory)`. Cases: put/has/get/uri/delete; `sizeBytes`; `evictLru` removes least-recently-used unpinned entries until under the limit and never removes pinned ones.
- `packages/core/src/store/__tests__/stores.test.ts` — `isNewer` truth table; both memory implementations pass their conformance suites with every case `ok`.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/core exec vitest run src/store \
  && pnpm --filter @lectern/core run typecheck \
  && node scripts/check-isomorphic.mjs
```
Pass: exit code 0.

---

### U-015 — core-tts: engine interface, chunk identifiers, mock engine

**Unit ID & Title:** U-015 — core-tts: engine interface, chunk identifiers, mock engine

**Inputs & Dependencies**
- Depends on: U-012
- Reads: F§6, F§5.6
- Uses: `@lectern/core` (`sha256Hex`, `splitWords`, `alignEngineTimings`, `estimateTimings`)
- Installs (`packages/core-tts`, exact): `zod`; dependency `@lectern/core` (`workspace:*`)

**REA Inspection Target & Method**
- Target: N/A — voice selection UI is inspected in U-023. Do not call REA.

**Forbidden Actions**
- Do not add any real engine, model file, or native audio library in this unit.
- Do not use an audio encoding package; the WAV writer and MP3 duration reader are hand-written from the formulas below.
- Do not change the `chunkId` formula or its golden values.
- Do not import Node modules in `packages/core-tts/src` outside test files; the package is isomorphic (use `fetch`, `atob`, and typed arrays).

**Required File Outputs**
- `packages/core-tts/package.json` — name `@lectern/core-tts`; exports `"."` and `"./testing"`.
- `packages/core-tts/tsconfig.json` — extends the base config.
- `packages/core-tts/vitest.config.ts` — Node environment.
- `packages/core-tts/src/index.ts` — re-exports.
- `packages/core-tts/src/engine.ts` — `Voice`, `TtsEngine`, `VoiceSchema`, `parseVoiceId('engine:voice')`, per F§6.
- `packages/core-tts/src/chunk-id.ts` — `chunkIdFor(engine, engineVoiceId, synthSpeed, text)`.
- `packages/core-tts/src/wav.ts` — `encodeWavPcm16(samples: Int16Array, sampleRate): Uint8Array` and `readWavDurationMs(bytes): number` (reads the `fmt ` and `data` chunks; tolerates extra chunks).
- `packages/core-tts/src/mp3.ts` — `readMp3DurationMs(bytes): number`. Skips an ID3v2 tag, then sums frames. Layer III only. Samples per frame: 1152 (MPEG-1), 576 (MPEG-2 and 2.5). Frame length: `floor(144·bitrate/sampleRate) + padding` (MPEG-1), `floor(72·bitrate/sampleRate) + padding` (MPEG-2 and 2.5). Bitrate tables (kbps, index 1–14): MPEG-1 `32 40 48 56 64 80 96 112 128 160 192 224 256 320`; MPEG-2/2.5 `8 16 24 32 40 48 56 64 80 96 112 128 144 160`. Sample rates (index 0–2): MPEG-1 `44100 48000 32000`; MPEG-2 `22050 24000 16000`; MPEG-2.5 `11025 12000 8000`.
- `packages/core-tts/src/mock-engine.ts` — `createMockEngine()` per F§6.
- `packages/core-tts/src/synthesize-chunk.ts` — `synthesizeChunk(engine, { text, engineVoiceId, synthSpeed }): Promise<{ chunkId, audio, mime, durationMs, timings, timingSource }>`; tokenizes the text and aligns or estimates timings.
- `packages/core-tts/src/registry.ts` — `createEngineRegistry(engines)` with `listVoices()` (merged, failures of one engine do not hide the others) and `resolve(voiceId)`.
- `packages/core-tts/src/testing/index.ts` — re-exports `runTtsEngineConformance`.
- `packages/core-tts/src/testing/engine-conformance.ts` — `runTtsEngineConformance(engine)`: lists at least one voice; synthesizes non-empty audio with positive duration; duration scales inversely with `synthSpeed` within 25%; an unknown voice rejects.
- `packages/core-tts/src/__tests__/core-tts.test.ts` — both `chunkId` goldens from F§6; WAV round trip; `readMp3DurationMs` on 100 synthetic frames with header `FF FB 90 00` and 413 zero bytes each returns `round(100·1152/44100·1000)` = 2612, and on 100 MPEG-2 frames with header `FF F3 80 00` and 204 zero bytes each (64 kbps, 22 050 Hz, frame length 208) returns 2612; the mock engine passes conformance; `synthesizeChunk` returns one timing per word; the registry resolves `mock:mock-a` and rejects `nope:x`.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/core-tts exec vitest run \
  && pnpm --filter @lectern/core-tts run typecheck
```
Pass: exit code 0.

---

### U-016 — core-tts: Kokoro-FastAPI adapter

**Unit ID & Title:** U-016 — core-tts: Kokoro-FastAPI adapter

**Inputs & Dependencies**
- Depends on: U-015
- Reads: F§6 (Kokoro adapter), F§2.3 (external services)
- Uses: `packages/core-tts/src/engine.ts`, `packages/core-tts/src/mp3.ts`, `packages/core-tts/src/testing/engine-conformance.ts`

**REA Inspection Target & Method**
- Target: N/A — the engine is an open-source service with a published HTTP API. Do not call REA.

**Forbidden Actions**
- Do not call any endpoint other than `GET /v1/audio/voices` and `POST /dev/captioned_speech`.
- Do not send fields other than `model`, `input`, `voice`, `speed`, `response_format`, `stream`.
- Do not contact a real Kokoro server in tests; use the stub server.
- Do not hard-code a voice list; voices come from the engine.

**Required File Outputs**
- `packages/core-tts/src/kokoro-engine.ts` — `createKokoroEngine({ baseUrl, fetch?, timeoutMs? }): TtsEngine` with `id: 'kokoro'`. Validates responses with zod; decodes base64 audio; converts `start_time` / `end_time` seconds to integer milliseconds; `durationMs = max(readMp3DurationMs(audio), last token end)`; an empty `timestamps` array yields `engineTokens: null`; clamps `synthSpeed` to 0.25–4.0; maps HTTP and timeout failures to an error with code `ENGINE_UNAVAILABLE`.
- `packages/core-tts/src/__tests__/kokoro-engine.test.ts` — a local `node:http` stub implements both endpoints with canned JSON (synthetic MP3 frames, three timestamps). Asserts the exact request body; voice mapping to `kokoro:<id>`; millisecond conversion; empty timestamps → `null`; HTTP 500 and a timeout → `ENGINE_UNAVAILABLE`; the adapter passes `runTtsEngineConformance` against the stub.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/core-tts exec vitest run src/__tests__/kokoro-engine.test.ts \
  && pnpm --filter @lectern/core-tts run typecheck
```
Pass: exit code 0.

---

### U-017 — core-tts: Piper HTTP adapter

**Unit ID & Title:** U-017 — core-tts: Piper HTTP adapter

**Inputs & Dependencies**
- Depends on: U-015
- Reads: F§6 (Piper adapter)
- Uses: `packages/core-tts/src/engine.ts`, `packages/core-tts/src/wav.ts`, `packages/core-tts/src/testing/engine-conformance.ts`

**REA Inspection Target & Method**
- Target: N/A — the engine is an open-source service with a published HTTP API. Do not call REA.

**Forbidden Actions**
- Do not spawn a `piper` process or load ONNX models from Node; use only the HTTP server.
- Do not call endpoints other than `GET /voices` and `POST /synthesize`.
- Do not fabricate word timestamps; return `engineTokens: null`.

**Required File Outputs**
- `packages/core-tts/src/piper-engine.ts` — `createPiperEngine({ baseUrl, fetch?, timeoutMs? }): TtsEngine` with `id: 'piper'`. Sends `{ text, voice, length_scale: 1 / synthSpeed }`; returns WAV bytes with `durationMs` from `readWavDurationMs`; maps failures to `ENGINE_UNAVAILABLE`.
- `packages/core-tts/src/__tests__/piper-engine.test.ts` — a `node:http` stub serving a voice list and a generated WAV whose length depends on `length_scale`. Asserts the request body, `length_scale` for `synthSpeed` 1 and 2, voice mapping to `piper:<name>`, error mapping, and conformance.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/core-tts exec vitest run src/__tests__/piper-engine.test.ts \
  && pnpm --filter @lectern/core-tts run typecheck
```
Pass: exit code 0.

---

### U-018 — api-contract: engine route schemas

**Unit ID & Title:** U-018 — api-contract: engine route schemas

**Inputs & Dependencies**
- Depends on: U-014, U-015
- Reads: F§7.2 (phase 1 routes)
- Uses: `@lectern/core` schemas, `@lectern/core-tts` `VoiceSchema`
- Installs (`packages/api-contract`, exact): `zod`; dependencies `@lectern/core`, `@lectern/core-tts` (`workspace:*`)

**REA Inspection Target & Method**
- Target: N/A — the hub API is a Lectern design. Never inspect or record the reference product's network API. Do not call REA.

**Forbidden Actions**
- Do not define schemas for phase 5 routes here (U-054).
- Do not add authentication fields to request bodies; the token travels only in the `Authorization` header.
- Do not model users, sessions, plans, or quotas.

**Required File Outputs**
- `packages/api-contract/package.json` — name `@lectern/api-contract`.
- `packages/api-contract/tsconfig.json` — extends the base config.
- `packages/api-contract/vitest.config.ts` — Node environment.
- `packages/api-contract/src/index.ts` — re-exports.
- `packages/api-contract/src/common.ts` — `ErrorBodySchema` (`{ error: { code, message } }`) and the `ErrorCode` union: `UNAUTHORIZED`, `BAD_REQUEST`, `NOT_FOUND`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_FORMAT`, `INVALID_EPUB`, `DRM_PROTECTED`, `PARSE_FAILED`, `EMPTY_DOCUMENT`, `FETCH_REFUSED`, `ENGINE_UNAVAILABLE`, `UNKNOWN_VOICE`, `INTERNAL`.
- `packages/api-contract/src/engine-api.ts` — `FILENAME_HEADER = 'x-lectern-filename'`, `HealthResponseSchema`, `VoicesResponseSchema`, `TtsRequestSchema` (text 1–1 000 characters, `voiceId`, optional `synthSpeed` 1.0–4.0 defaulting to 1), `TtsResponseSchema`, `ParseJsonRequestSchema` (exactly one of `url` or `text`), `ParseResponseSchema`.
- `packages/api-contract/src/__tests__/engine-api.test.ts` — one valid and two invalid examples per schema; `ParseJsonRequestSchema` rejects a body with both `url` and `text`.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/api-contract exec vitest run \
  && pnpm --filter @lectern/api-contract run typecheck
```
Pass: exit code 0.

---

### U-019 — Hub: server skeleton, authentication, voices and TTS routes

**Unit ID & Title:** U-019 — Hub: server skeleton, authentication, voices and TTS routes

**Inputs & Dependencies**
- Depends on: U-016, U-017, U-018
- Reads: F§7.1, F§7.2, F§7.3, F§11
- Uses: `@lectern/core-tts` (`createEngineRegistry`, `synthesizeChunk`, engines), `@lectern/api-contract`
- Installs (`apps/server`, exact): `fastify`, `@fastify/cors`, `zod`; devDependency `tsx`; workspace dependencies `@lectern/core`, `@lectern/core-tts`, `@lectern/api-contract`

**REA Inspection Target & Method**
- Target: N/A — the hub is a Lectern design. Do not call REA.

**Forbidden Actions**
- Do not add users, sessions, cookies, JWTs, OAuth, rate plans, or usage counters. Authentication is one constant-time comparison with `LECTERN_TOKEN`.
- Do not start the server in tests; use Fastify `inject`.
- Do not log request bodies, tokens, or document text.
- Do not add a database in this unit.
- Do not register routes directly in `app.ts`; add them to the route registry.

**Required File Outputs**
- `apps/server/package.json` — name `@lectern/server`; exports `"."` → `./src/index.ts` and `"./testing"` → `./src/testing/index.ts`; scripts `dev` (`tsx src/main.ts`), `test`, `typecheck`.
- `apps/server/src/index.ts` (registry) — re-exports `buildApp`, `loadConfig`, and their types.
- `apps/server/tsconfig.json` — extends the base config, Node types.
- `apps/server/vitest.config.ts` — Node environment.
- `apps/server/src/config.ts` — `loadConfig(env): Config` validating F§7.1 with zod; rejects a token shorter than 32 characters.
- `apps/server/src/errors.ts` — `HubError(code, message, status)` and the Fastify error handler producing `ErrorBodySchema`.
- `apps/server/src/auth.ts` — `onRequest` hook; `/healthz` and `OPTIONS` are exempt.
- `apps/server/src/context.ts` — `HubContext` (`{ config, engines, ttsCache }`) passed to every route module.
- `apps/server/src/tts-cache.ts` — disk cache per F§7.3 with in-flight de-duplication.
- `apps/server/src/routes/index.ts` (registry) — exports `routes: ((app, ctx) => void)[]`.
- `apps/server/src/routes/health.ts` — `GET /healthz`.
- `apps/server/src/routes/voices.ts` — `GET /v1/voices`.
- `apps/server/src/routes/tts.ts` — `POST /v1/tts` and `GET /v1/tts/audio/:chunkId` (validates `chunkId` as 40 hex characters; supports `Range`).
- `apps/server/src/app.ts` — `buildApp(config, overrides?): Promise<FastifyInstance>`; CORS per F§7.2; registers every entry of `routes`.
- `apps/server/src/main.ts` — loads config, builds the app, listens on `0.0.0.0:LECTERN_PORT`, shuts down cleanly on `SIGTERM`.
- `apps/server/src/__tests__/engine-routes.test.ts` — with the mock engine and a temporary data directory: `/healthz` works without a token; other routes return 401 without or with a wrong token; `/v1/voices` lists both mock voices; `/v1/tts` returns one timing per word and a `chunkId` equal to the F§6 golden for `Hello, world.` with `mock:mock-a`; a second identical request does not call the engine again; 10 concurrent identical requests call it once; the audio route returns the bytes with the immutable cache header and honours a `Range` request with 206; text of 1 001 characters returns 400; an unknown voice returns 404 `UNKNOWN_VOICE`; a traversal `chunkId` returns 400.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/server exec vitest run src/__tests__/engine-routes.test.ts \
  && pnpm --filter @lectern/server run typecheck \
  && node scripts/check-forbidden.mjs
```
Pass: exit code 0.

---

### U-020 — Hub: parse route and safe URL fetch

**Unit ID & Title:** U-020 — Hub: parse route and safe URL fetch

**Inputs & Dependencies**
- Depends on: U-011, U-019
- Reads: F§7.2 (`POST /v1/parse`), F§5.4
- Uses: `@lectern/core/parsers` (`parseDocument`, `createTesseractOcrEngine`), `apps/server/src/routes/index.ts`, `apps/server/src/context.ts`, files in `packages/fixtures/generated/`
- Installs (`apps/server`): devDependency `@lectern/fixtures` (`workspace:*`)
- Patch scope: `apps/server/src/context.ts`, `apps/server/src/app.ts`
- Patch notes: add an OCR engine member to the context; in the app factory add a binary body parser for non-JSON content types (bodies arrive as buffers, limited by `LECTERN_MAX_UPLOAD_MB`) and create the OCR engine lazily on first use. Change nothing else.

**REA Inspection Target & Method**
- Target: N/A — the hub is a Lectern design. Do not call REA.

**Forbidden Actions**
- Do not store uploaded files or parsed documents on disk in this unit; the route is stateless.
- Do not fetch `file:`, `ftp:`, `data:`, or any non-HTTP(S) URL.
- Do not fetch private, loopback, or link-local addresses unless `LECTERN_ALLOW_PRIVATE_FETCH=1`; check the resolved address, not only the host name, and re-check after every redirect.
- Do not forward the hub's `Authorization` header or any cookie to fetched sites.
- Do not use a headless browser to render pages.
- Do not add multipart parsing; files arrive as the raw request body.

**Required File Outputs**
- `apps/server/src/fetch-url.ts` — `safeFetch(url, { maxBytes, timeoutMs, allowPrivate, lookup? }): Promise<{ bytes, mime, finalUrl }>` implementing the F§7.2 rules with an injectable DNS lookup.
- `apps/server/src/routes/parse.ts` — `POST /v1/parse` accepting raw file bytes (any non-JSON `Content-Type`, with the optional `X-Lectern-Filename` header), JSON `{ url }`, or JSON `{ text, title? }`; maps `ParseError` codes to HTTP 415 (`UNSUPPORTED_FORMAT`), 422 (`INVALID_EPUB`, `DRM_PROTECTED`, `PARSE_FAILED`, `EMPTY_DOCUMENT`), 413 (size), 400 (`FETCH_REFUSED`).
- `apps/server/src/__tests__/parse-route.test.ts` — each fixture uploads to a schema-valid `DocumentModel`; `text.pdf` returns anchors; `page.png` returns OCR text; `{ text }` works; `{ url }` against a local stub works with `allowPrivate` on and returns 400 `FETCH_REFUSED` with it off; a redirect to a private address is refused; a body over the limit returns 413; random bytes return 415.
- `apps/server/src/__tests__/fetch-url.test.ts` — scheme allowlist, redirect limit, timeout, size limit while streaming, and the address checks for `127.0.0.1`, `10.0.0.1`, `169.254.1.1`, `192.168.1.1`, `::1`, and `fc00::1` via the injected lookup.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/server exec vitest run \
  && pnpm --filter @lectern/server run typecheck
```
Pass: exit code 0, including the unchanged U-019 tests.

---

### U-021 — api-client: typed hub client and caching chunk source

**Unit ID & Title:** U-021 — api-client: typed hub client and caching chunk source

**Inputs & Dependencies**
- Depends on: U-013, U-014, U-020
- Reads: F§5.8, F§5.9 (`BlobCache`), F§7.2
- Uses: `@lectern/api-contract`, `@lectern/core` (`ChunkSource`, `BlobCache`, `createMemoryBlobCache`), `@lectern/server` `buildApp` (tests only)
- Installs (`packages/api-client`, exact): `zod`; workspace dependencies `@lectern/core`, `@lectern/core-tts`, `@lectern/api-contract`; devDependency `@lectern/server`

**REA Inspection Target & Method**
- Target: N/A — client plumbing for the Lectern hub. Do not call REA.

**Forbidden Actions**
- Do not use `axios`, `ky`, or any HTTP library; use the injected `fetch`.
- Do not read `window`, `localStorage`, `process.env`, or the file system; everything is injected, so the package stays isomorphic.
- Do not put the token in a URL or query string.
- Do not retry non-idempotent requests automatically.

**Required File Outputs**
- `packages/api-client/package.json` — name `@lectern/api-client`.
- `packages/api-client/tsconfig.json` — extends the base config.
- `packages/api-client/vitest.config.ts` — Node environment.
- `packages/api-client/src/index.ts` — re-exports.
- `packages/api-client/src/errors.ts` — `HubClientError` with `code`, `status`, and `offline: boolean`.
- `packages/api-client/src/client.ts` — `createHubClient({ baseUrl, token, fetch })` with `health()`, `voices()`, `tts(req)`, `ttsAudio(chunkId): Promise<Uint8Array>`, `parseFile(bytes, filename, mime)` (raw body with `Content-Type` and the `X-Lectern-Filename` header), `parseUrl(url)`, `parseText(text, title?)`. Validates every response with `@lectern/api-contract`.
- `packages/api-client/src/chunk-source.ts` — `createCachingChunkSource({ client, cache })`. Computes `chunkId` locally with `chunkIdFor`; on a cache hit (`<chunkId>` audio and `<chunkId>.json` metadata) returns without network; otherwise calls `tts`, downloads audio, stores both, and returns the cache URI. Concurrent requests for one chunk share a promise. Also `prefetchDocument(doc, voiceId, opts): AsyncIterable<{ done, total }>` and `isCached(text, voiceId, synthSpeed)`.
- `packages/api-client/src/testing/index.ts` — re-exports `fetchFromFastify`.
- `packages/api-client/src/testing/fastify-fetch.ts` — `fetchFromFastify(app): typeof fetch`, adapting Fastify `inject` to the `fetch` signature, including binary request and response bodies.
- `packages/api-client/src/__tests__/client.test.ts` — against a real hub app with the mock engine: every client method round-trips; a wrong token yields `code: 'UNAUTHORIZED'`; a rejecting fetch yields `offline: true`.
- `packages/api-client/src/__tests__/chunk-source.test.ts` — first `get` calls the hub once and caches; a second `get` makes no request; with fetch failing, cached chunks still resolve and uncached ones reject with `offline: true`; concurrent `get`s share one request; the local `chunkId` equals the hub's; `prefetchDocument` caches every playable sentence and reports progress.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/api-client exec vitest run \
  && pnpm --filter @lectern/api-client run typecheck
```
Pass: exit code 0.

---

### U-022 — Infra: hub image, compose file, real-engine smoke test

**Unit ID & Title:** U-022 — Infra: hub image, compose file, real-engine smoke test

**Inputs & Dependencies**
- Depends on: U-021
- Reads: F§2.3 (external services), F§7.1, F§12
- Uses: `apps/server/src/main.ts`; Docker with the compose plugin (`node scripts/preflight.mjs --phase 5` must pass)
- Installs (`apps/server`, exact, devDependency): `esbuild`

**REA Inspection Target & Method**
- Target: N/A — deployment of Lectern's own services. Do not call REA.

**Forbidden Actions**
- Do not use an image tag of `latest`; resolve and pin a specific Kokoro-FastAPI release tag and record it in the evidence file.
- Do not publish any port on `0.0.0.0` except the hub's; engine containers are reachable only on the compose network.
- Do not commit `infra/.env` or a real token.
- Do not add a reverse proxy, TLS termination, a database server, Redis, or a message queue.
- Do not run the hub container as root.

**Required File Outputs**
- `apps/server/build.mjs` — bundles `src/main.ts` to `dist/server.mjs` with esbuild (platform `node`, ESM; native and worker-based packages `better-sqlite3`, `@napi-rs/canvas`, `tesseract.js`, `pdfjs-dist` external).
- `infra/Dockerfile` — multi-stage: install with pnpm, build the bundle, copy the production `node_modules` of `@lectern/server` (for example with `pnpm deploy`), run as a non-root user with `LECTERN_DATA_DIR=/data` and a `HEALTHCHECK` on `/healthz`.
- `infra/docker-compose.yml` — services `hub` (port `8787:8787`, volume `lectern-data:/data`, `KOKORO_URL=http://kokoro:8880`, `env_file: .env`) and `kokoro` (pinned image, no published port, health check); profile `piper` adds a `piper` service and `PIPER_URL`.
- `infra/.env.example` — `LECTERN_TOKEN=replace-with-at-least-32-random-characters` and commented optional variables from F§7.1.
- `scripts/smoke-engine.mjs` — zero-dependency Node script. `--base <url>`; token from `LECTERN_TOKEN`. Checks: `/healthz` ok; `/v1/voices` contains a `kokoro:` voice; `/v1/tts` for `Hello, world.` with the first Kokoro voice returns `timingSource: "engine"` and 2 timings; the audio download is larger than 1 000 bytes; `/v1/parse` with text returns 1 sentence. Prints each check and exits 1 on the first failure.

**Pass/Fail Verification Test**
```sh
cp -n infra/.env.example infra/.env \
  && docker compose -f infra/docker-compose.yml config -q \
  && docker compose -f infra/docker-compose.yml up -d --build --wait \
  && LECTERN_TOKEN=$(grep '^LECTERN_TOKEN=' infra/.env | cut -d= -f2-) node scripts/smoke-engine.mjs --base http://127.0.0.1:8787; rc=$?; \
  docker compose -f infra/docker-compose.yml down; exit $rc
```
Pass: exit code 0 and every smoke check prints `OK`. If Docker is unavailable on the execution host, the unit is `BLOCKED`, not passed.

---

# Phase 2 — Web App & Chrome Extension

### U-023 — ui-web: package scaffold, design tokens, player controls

**Unit ID & Title:** U-023 — ui-web: package scaffold, design tokens, player controls

**Inputs & Dependencies**
- Depends on: U-013, U-015
- Reads: F§5.7, F§10.1 (player bar), F§6 (`Voice`)
- Uses: `@lectern/core` (`PlayerSnapshot`, `PlayerCommand`, `RATE_MIN`, `RATE_MAX`, `RATE_STEP`, `RATE_PRESETS`), `@lectern/core-tts` (`Voice`)
- Installs (`packages/ui-web`, exact): `react`, `react-dom`; devDependencies `@vitejs/plugin-react`, `@testing-library/react`, `happy-dom`, `@types/react`, `@types/react-dom`; workspace dependencies `@lectern/core`, `@lectern/core-tts`

**REA Inspection Target & Method**
- Target: `T-WEB`, probe document open.
- Tools: `list_browser_targets`, `inspect_web_page`, `capture_web_screenshot`.
- Method: `inspect_web_page` with accessibility text for the reader tab; one screenshot with the player visible; the operator opens the voice menu, then a second `inspect_web_page` and screenshot.
- Questions: Where is the player placed (edge, floating, full width)? Which control groups exist, in what order, at roughly what sizes? Is speed a slider, a menu, presets, or a combination? How is the voice list organized (grouping, search, preview)? What is shown while audio is loading?

**Forbidden Actions**
- Do not add a component library, CSS framework, icon package, or web font (no MUI, Chakra, Radix, Tailwind, Bootstrap, lucide, Font Awesome, Google Fonts).
- Do not reuse the reference product's colours, icon shapes, control arrangement, or wording; choose a different arrangement and record it as `DESIGN`.
- Do not hold player state inside components; they render a `PlayerSnapshot` and emit `PlayerCommand`s.
- Do not ship a control without an accessible name and keyboard operation.

**Required File Outputs**
- `packages/ui-web/package.json` — name `@lectern/ui-web`; exports `"."` and `"./styles.css"`.
- `packages/ui-web/tsconfig.json` — extends the base config, DOM libs, `jsx: "react-jsx"`.
- `packages/ui-web/vitest.config.ts` — `happy-dom` environment, includes `src/**/*.test.{ts,tsx}`.
- `packages/ui-web/src/index.ts` — re-exports.
- `packages/ui-web/src/styles.css` — CSS custom properties for an original light and dark theme (`--lectern-ink`, `--lectern-paper`, `--lectern-accent`, `--lectern-sentence`, `--lectern-word`, spacing and radius scales) using system font stacks, plus component styles.
- `packages/ui-web/src/format.ts` — `formatRate(1.5) → "1.5×"`, `formatRemaining(ms) → "12 min"`, `formatWpm(rate, baseWpm)`.
- `packages/ui-web/src/components/icons.tsx` — original inline SVG icons built from basic shapes: play, pause, previous, next, speed, voice, timer, close, bookmark.
- `packages/ui-web/src/components/SpeedControl.tsx` — slider from `RATE_MIN` to `RATE_MAX` in `RATE_STEP` steps plus `RATE_PRESETS` buttons; shows multiplier and words per minute.
- `packages/ui-web/src/components/VoicePicker.tsx` — voices grouped by language then engine, with a text filter.
- `packages/ui-web/src/components/SleepTimerMenu.tsx` — off, 5, 15, 30, 60 minutes; shows remaining time.
- `packages/ui-web/src/components/PlayerBar.tsx` — props `{ snapshot, voices, progressFraction, remainingMs, baseWpm, variant: 'full' | 'compact', onCommand }`; play/pause, previous and next sentence, speed, voice, sleep timer, progress; a spinner in `loading` and `buffering`; the error message in `error`.
- `packages/ui-web/src/components/__tests__/player-bar.test.tsx` — play emits `{ type: 'play' }` when paused and `{ type: 'pause' }` when playing; skip buttons emit `skip` ±1; choosing preset 4.5 emits `setRate` 4.5; the slider cannot exceed 5.0; choosing a voice emits `setVoice`; the timer emits `setSleep`; every button has an accessible name; `buffering` shows the spinner.
- `packages/ui-web/src/__tests__/format.test.ts` — formatting cases.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/ui-web exec vitest run \
  && pnpm --filter @lectern/ui-web run typecheck \
  && node scripts/check-forbidden.mjs
```
Pass: exit code 0.

---

### U-024 — ui-web: HTML audio queue sink

**Unit ID & Title:** U-024 — ui-web: HTML audio queue sink

**Inputs & Dependencies**
- Depends on: U-023
- Reads: F§5.8, F§5.6 (e)
- Uses: `@lectern/core` (`AudioQueueSink`), `@lectern/core/testing` (`runAudioQueueSinkConformance`), `@lectern/core-tts` (`createMockEngine` for test audio)
- Installs (`packages/ui-web`, exact, devDependencies): `@playwright/test`, `vite`

**REA Inspection Target & Method**
- Target: `T-WEB`, probe document playing.
- Tools: `list_browser_targets`, `inspect_web_page`.
- Method: two `inspect_web_page` captures of the DOM while the operator has playback running, one at normal speed and one at the highest speed.
- Questions: Are media elements present in the page, and how many? Does a media element's playback-rate attribute change with the speed setting? Is there an audible or measurable gap between sentences (`UNKNOWN` if not observable)?

**Forbidden Actions**
- Do not use the Web Audio API, `MediaSource`, or an audio library; use two `HTMLAudioElement`s.
- Do not set `preservesPitch` to `false`.
- Do not attach the audio elements to the document or mutate the host page's DOM.
- Do not start playback outside `play()`; never autoplay on `enqueue`.

**Required File Outputs**
- `packages/ui-web/src/audio/html-audio-queue-sink.ts` — `createHtmlAudioQueueSink(): AudioQueueSink` with `maxRate = 16`. Two alternating elements; the next chunk is preloaded on the idle element; `chunk-end` and `chunk-start` fire on hand-over; `preservesPitch = true` on both; `setRate` applies to both immediately.
- `packages/ui-web/playwright.config.ts` — Chromium only, headless, launch argument `--autoplay-policy=no-user-gesture-required`, a `webServer` running Vite on the harness.
- `packages/ui-web/e2e/vite.config.ts` — serves `e2e/harness`.
- `packages/ui-web/e2e/harness/index.html` — empty page loading `main.ts`.
- `packages/ui-web/e2e/harness/main.ts` — exposes `window.runSinkConformance()`, which builds mock-engine WAV chunks as blob URLs and runs the conformance suite against the sink, and `window.sinkProbe()` returning `{ preservesPitch, playbackRate }` of the active element.
- `packages/ui-web/e2e/sink.spec.ts` — every conformance case is `ok`; after `setRate(4.5)` the probe reports `playbackRate: 4.5` and `preservesPitch: true`; three 600 ms chunks at rate 2 finish in 700–1 400 ms of wall time.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/ui-web exec playwright install chromium \
  && pnpm --filter @lectern/ui-web exec playwright test e2e/sink.spec.ts \
  && pnpm --filter @lectern/ui-web run typecheck
```
Pass: exit code 0.

---

### U-025 — ui-web: reader view with synchronized highlighting

**Unit ID & Title:** U-025 — ui-web: reader view with synchronized highlighting

**Inputs & Dependencies**
- Depends on: U-024
- Reads: F§5.1, F§5.6 (c) and (d), F§10.1 (reader)
- Uses: `@lectern/core` (`DocumentModel`), `packages/ui-web/playwright.config.ts`, `packages/ui-web/e2e/vite.config.ts`
- Patch scope: `packages/ui-web/e2e/harness/main.ts`
- Patch notes: add a `window.mountReader(documentJson)` helper for the reader test; leave the sink helpers unchanged.

**REA Inspection Target & Method**
- Target: `T-WEB`, probe document open.
- Tools: `list_browser_targets`, `capture_browser_scenario`, `capture_web_screenshot`.
- Method: one connect-mode scenario: click play, wait 4 s, scroll the page down by one viewport, wait 6 s, capture accessibility text; two screenshots (during play; after the manual scroll).
- Questions: How do the sentence highlight and word highlight differ visually (describe relatively, no colour values)? Where in the viewport is the active line kept? Does manual scrolling suspend auto-scroll, and how does it resume (timeout, button)? Does clicking text during playback seek?

**Forbidden Actions**
- Do not wrap words or sentences in elements; each block renders as one element containing one text node, and highlights use the CSS Custom Highlight API.
- Do not re-render the document when the active word changes; update highlight ranges only.
- Do not copy the reference product's highlight colours.
- Do not render skipped blocks as playable; show them dimmed, and hide them when `showSkipped` is false.

**Required File Outputs**
- `packages/ui-web/src/highlight/highlight-registry.ts` — `setHighlight(name, ranges: Range[])`, `clearHighlight(name)`, `isHighlightSupported()`; names `lectern-sentence` and `lectern-word`.
- `packages/ui-web/src/highlight/locate.ts` — `rangeForWord(blockEl, sentence, word)`, `rangeForSentence(blockEl, sentence)`, and `positionFromPoint(root, doc, x, y): { sentenceIndex, wordIndex } | null` using the caret-from-point API.
- `packages/ui-web/src/scroll/auto-scroll.ts` — pure policy `createAutoScroll({ clock, suspendMs: 4000 })` with `onUserScroll()` and `target(rect, viewportHeight): number | null` (keeps the active line between 30% and 60% of the viewport).
- `packages/ui-web/src/components/ReaderView.tsx` — props `{ document, active: { sentenceIndex, wordIndex } | null, showSkipped, onSeek }`; headings, paragraphs, list items, and quotes as semantic elements with `data-block`; highlights updated in an effect; click seeks.
- `packages/ui-web/src/__tests__/auto-scroll.test.ts` — no scroll inside the band; scroll when outside; suspended for 4 s after user scroll, then resumes.
- `packages/ui-web/e2e/reader.spec.ts` — in Chromium: after setting an active position, `CSS.highlights.get('lectern-word')` holds one range whose text equals the word and `lectern-sentence` one range whose text equals the sentence; clicking the centre of a later word calls `onSeek` with that word's indexes; the number of elements in the reader is identical before and after 50 position changes.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/ui-web exec vitest run \
  && pnpm --filter @lectern/ui-web exec playwright test \
  && pnpm --filter @lectern/ui-web run typecheck
```
Pass: exit code 0, including the unchanged U-024 sink test.

---

### U-026 — ui-web: IndexedDB library store and blob cache

**Unit ID & Title:** U-026 — ui-web: IndexedDB library store and blob cache

**Inputs & Dependencies**
- Depends on: U-014, U-023
- Reads: F§5.9
- Uses: `@lectern/core` (`LibraryStore`, `BlobCache`, `isNewer`), `@lectern/core/testing` (both conformance suites)
- Installs (`packages/ui-web`, exact): `idb`; devDependency `fake-indexeddb`

**REA Inspection Target & Method**
- Target: N/A — client storage is a Lectern design; reading the reference product's stored data is forbidden. Do not call REA.

**Forbidden Actions**
- Do not use `localStorage`, cookies, the Cache API, or the File System Access API for library data.
- Do not store the hub token in IndexedDB.
- Do not add tables or fields for users or accounts.
- Do not change database structure without incrementing the database version and writing an upgrade step.

**Required File Outputs**
- `packages/ui-web/src/stores/idb-schema.ts` — database `lectern`, version 1; object stores `documents`, `models`, `folders`, `bookmarks`, `progress`, `settings`, `outbox`, `meta`, `blobs`, `blobMeta`; `openLecternDb(name?)`.
- `packages/ui-web/src/stores/idb-library-store.ts` — `createIdbLibraryStore({ db, deviceId, now, newId }): LibraryStore`; each mutation and its outbox entry commit in one transaction.
- `packages/ui-web/src/stores/idb-blob-cache.ts` — `createIdbBlobCache({ db, now }): BlobCache`; `uri` returns an object URL created once per key and revoked on `delete` and eviction; `blobMeta` tracks size and last access.
- `packages/ui-web/src/stores/device-id.ts` — `getDeviceId(db)`: a random identifier created once and kept in `meta`.
- `packages/ui-web/src/stores/__tests__/idb-stores.test.ts` — with `fake-indexeddb`: both stores pass their conformance suites with every case `ok`; data survives closing and reopening the database; `getDeviceId` is stable.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/ui-web exec vitest run src/stores \
  && pnpm --filter @lectern/ui-web run typecheck
```
Pass: exit code 0.

---

### U-027 — Web: application scaffold, router, settings, services

**Unit ID & Title:** U-027 — Web: application scaffold, router, settings, services

**Inputs & Dependencies**
- Depends on: U-021, U-026
- Reads: F§10.1, F§11
- Uses: `@lectern/ui-web`, `@lectern/api-client`, `@lectern/server` `buildApp` (end-to-end tests only)
- Installs (`apps/web`, exact): `react`, `react-dom`, `zustand`; devDependencies `vite`, `@vitejs/plugin-react`, `@playwright/test`, `happy-dom`, `@types/react`, `@types/react-dom`; workspace dependencies `@lectern/core`, `@lectern/core-tts`, `@lectern/api-client`, `@lectern/api-contract`, `@lectern/ui-web`; devDependencies `@lectern/server`, `@lectern/fixtures`

**REA Inspection Target & Method**
- Target: `T-WEB`.
- Tools: `list_browser_targets`, `inspect_web_page`, `capture_web_screenshot`.
- Method: one `inspect_web_page` with accessibility text and one screenshot of the reference web app's main screen; the operator opens the playback settings, then a second capture.
- Questions: What are the primary navigation areas? Which playback and reading settings are offered (ignore every account, plan, and billing setting)? How is the main layout divided (navigation, content, player)?

**Forbidden Actions**
- Do not add a router package; implement the hash router in this unit.
- Do not add login, sign-up, profile, plan, or upgrade screens; the only credentials are the hub URL and token in settings.
- Do not send the token anywhere except the configured hub origin.
- Do not hard-code a hub URL; the default is empty and the app opens settings until one is saved.
- Do not use absolute asset paths; the build must work from `file://` (Vite `base: './'`).

**Required File Outputs**
- `apps/web/package.json` — name `@lectern/web`; scripts `dev`, `build` (`vite build`), `test`, `typecheck`, `e2e` (`playwright test`).
- `apps/web/tsconfig.json` — extends the base config.
- `apps/web/vite.config.ts` — React plugin, `base: './'`, output `dist/`.
- `apps/web/vitest.config.ts` — `happy-dom`, includes `src/**/*.test.{ts,tsx}`.
- `apps/web/index.html` — root element, title `Lectern`.
- `apps/web/src/main.tsx` — loads settings, runs every boot feature, mounts `App`.
- `apps/web/src/boot.ts` (registry) — `bootFeatures: ((services: Services) => void | Promise<void>)[]`, run once at start-up; empty in this unit.
- `apps/web/src/App.tsx` — shell layout (navigation, content outlet); redirects to `#/settings` when no hub is configured.
- `apps/web/src/router.ts` — `matchRoute(pattern, hash)` (supports `:param` and query strings), `useHashRoute()`, `navigate(hash)`.
- `apps/web/src/routes.ts` (registry) — `routes: { pattern: string; component: ComponentType }[]`; this unit registers `#/settings`.
- `apps/web/src/settings/settings.ts` — typed settings: connection (`hubUrl`, `token`, kept in `localStorage` under `lectern.connection`) and preferences (`voiceId`, `rate`, `skipFurniture`, `skipCitations`, `lookaheadMs`, `theme`, `cacheLimitBytes`, kept in the `LibraryStore`); a zustand store with `load()` and `update()`.
- `apps/web/src/settings/sections.ts` (registry) — `sections: { id: string; title: string; component: ComponentType }[]`.
- `apps/web/src/settings/SettingsPage.tsx` — connection form with a "Test connection" button calling `health()`, playback preferences, and every registered section.
- `apps/web/src/services.ts` — composition root: `getServices()` returns `{ db, store, cache, client, chunks }`, rebuilt when the connection changes.
- `apps/web/src/app.css` — imports `@lectern/ui-web/styles.css` and lays out the shell.
- `apps/web/src/__tests__/router.test.ts` — pattern matching, parameters, query strings, unknown routes.
- `apps/web/src/__tests__/settings.test.ts` — defaults, persistence, and validation (rate clamped, URL normalized without a trailing slash).
- `apps/web/playwright.config.ts` — Chromium, headless, `--autoplay-policy=no-user-gesture-required`, `globalSetup`, a `webServer` serving the production build with `vite preview`.
- `apps/web/e2e/global-setup.ts` — starts a hub (`buildApp` with the mock engine, a temporary data directory, token `e2e-token-0123456789abcdef0123456789`) on a free port and writes `{ baseUrl, token }` to `apps/web/e2e/.hub.local`.
- `apps/web/e2e/helpers.ts` — `connect(page)` fills and saves the connection from `.hub.local`; `importText(page, title, text)` is added by U-028.
- `apps/web/e2e/settings.spec.ts` — first load lands on settings; a correct URL and token show a connected state and survive a reload; a wrong token shows an error and stays on settings.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/web exec vitest run \
  && pnpm --filter @lectern/web run typecheck \
  && pnpm --filter @lectern/web run build \
  && pnpm --filter @lectern/web exec playwright install chromium \
  && pnpm --filter @lectern/web exec playwright test e2e/settings.spec.ts
```
Pass: exit code 0.

---

### U-028 — Web: import flows and library

**Unit ID & Title:** U-028 — Web: import flows and library

**Inputs & Dependencies**
- Depends on: U-027
- Reads: F§10.1 (import), F§5.9, F§7.2 (`POST /v1/parse`)
- Uses: `apps/web/src/services.ts`, `apps/web/src/routes.ts`, `apps/web/src/router.ts`, `packages/fixtures/generated/text.pdf`, `packages/fixtures/generated/sample.txt`
- Patch scope: `apps/web/e2e/helpers.ts`
- Patch notes: add the `importText` helper; leave `connect` unchanged.

**REA Inspection Target & Method**
- Target: `T-WEB`, library screen.
- Tools: `list_browser_targets`, `inspect_web_page`, `capture_web_screenshot`.
- Method: one `inspect_web_page` with accessibility text and one screenshot of the library; the operator opens the add or import control, then a second capture.
- Questions: Which fields does a library item show (title, progress, date, type, length)? Can folders nest? What sorting and search exist? Which import entry points are offered (file, link, text, others)?

**Forbidden Actions**
- Do not parse documents in the browser; every file, URL, and text import goes through the hub's `POST /v1/parse`.
- Do not add cloud-drive connectors, browser-extension installers, or sharing links.
- Do not upload anything except to the configured hub.
- Do not delete a document's model without writing the tombstone through the `LibraryStore`.

**Required File Outputs**
- `apps/web/src/import/import-service.ts` — `importFile(file)`, `importUrl(url)`, `importText(text, title?)`: call the hub, store metadata and model with `putDocument`, store the original bytes under blob key `orig/<docId>` and PDF anchors under `anchors/<docId>`, and return `{ docId, duplicate }` (an existing non-deleted `docId` is not re-added).
- `apps/web/src/import/ImportPage.tsx` — routes `#/import` and `#/import?url=…`: drop zone, file input (`.pdf,.epub,.docx,.txt,.md,.html,.png,.jpg,.jpeg,.webp`), URL field, text area, per-item progress and error display.
- `packages/core/src/library-model.ts` — pure, isomorphic functions shared with Android: `buildFolderTree`, `filterDocuments` (text, folder), `sortDocuments` (`addedAt`, `title`, `progress`).
- `apps/web/src/library/LibraryPage.tsx` — route `#/library`: folder tree (create, rename, delete, nesting), document list with title, progress percentage, added date, and length; search; sort; move to folder; delete with confirmation; empty state linking to import.
- `packages/core/src/__tests__/library-model.test.ts` — tree building with nesting and orphans, filtering, each sort order.
- `apps/web/e2e/import-library.spec.ts` — uploading `text.pdf` adds an item titled as `expected.json` says; uploading it again reports a duplicate and adds nothing; pasted text imports; create a folder, move a document into it, filter by folder, search by title, delete; after a reload the library is unchanged.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/core exec vitest run src/__tests__/library-model.test.ts \
  && node scripts/check-isomorphic.mjs \
  && pnpm --filter @lectern/web exec vitest run \
  && pnpm --filter @lectern/web run typecheck \
  && pnpm --filter @lectern/web run build \
  && pnpm --filter @lectern/web exec playwright test e2e/settings.spec.ts e2e/import-library.spec.ts
```
Pass: exit code 0.

---

### U-029 — Web: reader page, playback loop, PlayerBus

**Unit ID & Title:** U-029 — Web: reader page, playback loop, PlayerBus

**Inputs & Dependencies**
- Depends on: U-025, U-028
- Reads: F§5.7, F§5.6 (d) and (f), F§10.1 (reader, keyboard, PlayerBus), F§10.3 (bridge member list)
- Uses: `@lectern/core` (`createPlayerController`), `@lectern/api-client` (`createCachingChunkSource`), `@lectern/ui-web` (`ReaderView`, `PlayerBar`, `createHtmlAudioQueueSink`), `apps/web/src/services.ts`, `apps/web/src/routes.ts`, `apps/web/e2e/helpers.ts`

**REA Inspection Target & Method**
- Target: `T-WEB`, probe document open.
- Tools: `list_browser_targets`, `capture_browser_scenario`.
- Method: two connect-mode scenarios with accessibility-text capture. (A) press the Space key, wait 4 s, press the right-arrow key twice, wait 2 s. (B) click play, wait 6 s, pause, reload the page (`start_url` again), wait 3 s.
- Questions: Which keys control playback, if any? After a reload, is the reading position restored, and to the word or the sentence? Where are bookmarks or notes reached from the reader?

**Forbidden Actions**
- Do not create a second player implementation; use `createPlayerController` unchanged.
- Do not write progress more than once every 2 s while playing; always write on pause, stop, and page hide.
- Do not use `SharedWorker`, a service worker, or `localStorage` events for the bus; use the two transports specified.
- Do not import Electron; the desktop bridge is reached only through the typed `window.lecternDesktop` accessor.

**Required File Outputs**
- `packages/ui-web/src/desktop-bridge.ts` — the `LecternDesktopBridge` interface with exactly the members listed in F§10.3, and `getDesktopBridge(): LecternDesktopBridge | null`.
- `packages/ui-web/src/player/player-bus.ts` — `PlayerBusTransport` (`post`, `subscribe`), `createBroadcastChannelTransport('lectern-player')`, `createDesktopBridgeTransport(bridge)`, and `createPlayerBus(transport, role: 'host' | 'remote')`: the host publishes snapshots (with active word and document title) and executes received commands; a remote sends commands and receives snapshots. All messages are zod-validated.
- `packages/ui-web/src/player/__tests__/player-bus.test.ts` — over an in-memory transport: a remote receives host snapshots; a remote command reaches the host; malformed messages are dropped; two remotes work together.
- `apps/web/src/reader/use-player.ts` — hook building the controller from services and settings; exposes snapshot, active word, voices, progress, `baseWpm`, and `dispatch`; restores and persists progress; hosts the `PlayerBus`.
- `apps/web/src/reader/keyboard.ts` — `commandForKey(event, snapshot): PlayerCommand | null` per F§10.1; ignores keys while typing in a form field.
- `apps/web/src/reader/BookmarksPanel.tsx` — add a bookmark at the current position with a note, list, jump, delete.
- `apps/web/src/reader/ReaderPage.tsx` — route `#/read/:docId`: `ReaderView`, `PlayerBar`, bookmarks panel, auto-scroll, toggles for `skipFurniture` and `skipCitations`, a not-found state; `?autoplay=1` starts playback once the document has loaded.
- `apps/web/src/mini/MiniPage.tsx` — route `#/mini`: compact `PlayerBar` and document title driven as a bus remote.
- `apps/web/src/__tests__/keyboard.test.ts` — each shortcut; no command when the target is an input.
- `apps/web/e2e/reader.spec.ts` — import text, open, click play: within 10 s a `lectern-word` highlight exists and the sentence index advances past 1; choosing 4.5× makes the active audio element report `playbackRate` 4.5 with `preservesPitch` true; clicking a later word moves the position there; `Space` pauses; after a reload the position is restored and playback is paused; switching to the second mock voice keeps playing; a second tab on `#/mini` shows the title, follows the snapshot, and its pause button pauses the first tab; adding and jumping to a bookmark works.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/ui-web exec vitest run src/player \
  && pnpm --filter @lectern/web exec vitest run \
  && pnpm --filter @lectern/web run typecheck \
  && pnpm --filter @lectern/web run build \
  && pnpm --filter @lectern/web exec playwright test
```
Pass: exit code 0 for the whole web end-to-end suite.

---

### U-030 — Web: PDF page view with anchored highlights

**Unit ID & Title:** U-030 — Web: PDF page view with anchored highlights

**Inputs & Dependencies**
- Depends on: U-029
- Reads: F§5.1 (`PdfAnchor`), F§10.1 (PDF page view)
- Uses: blob keys `orig/<docId>` and `anchors/<docId>` written by `apps/web/src/import/import-service.ts`, `packages/fixtures/generated/text.pdf`
- Installs (`apps/web`, exact, the same version as `packages/core`): `pdfjs-dist`
- Patch scope: `apps/web/src/reader/ReaderPage.tsx`
- Patch notes: add a "Text / Pages" view switch that renders the PDF page view when the document is a PDF with stored anchors; change nothing else.

**REA Inspection Target & Method**
- Target: `T-WEB`, with `text.pdf` open in the reference reader's original-page view.
- Tools: `list_browser_targets`, `capture_browser_scenario`, `capture_web_screenshot`.
- Method: one connect-mode scenario: click play, wait 6 s, capture accessibility text; two screenshots (playing on page 1; after the operator zooms in).
- Questions: Is the highlight drawn over the original page rendering or on a separate text rendering? Does it follow zoom? How are pages navigated (continuous scroll, paging)? Does the view scroll to keep the active word visible?

**Forbidden Actions**
- Do not load `pdfjs-dist` or its worker from a CDN; bundle both.
- Do not call `getTextContent` with options that differ from the hub parser's (U-007); `PdfAnchor.itemIndex` must index the same item list.
- Do not render more than the visible pages plus one on each side.
- Do not re-parse the PDF into a second `DocumentModel`; playback always uses the model from the hub.

**Required File Outputs**
- `apps/web/src/reader/pdf-anchors.ts` — `indexAnchors(anchors): Map<string, PdfAnchor>` keyed by `sentenceIndex:wordIndex`; `rectsForAnchor(textLayerSpans, anchor): DOMRect[]` (a range inside the span for `itemIndex`, limited to `charStart…charEnd`); `sentenceAnchors(anchors, sentenceIndex)`.
- `apps/web/src/reader/PdfPageView.tsx` — props `{ pdfBytes, anchors, active, scale, onSeek }`; virtualized pages with canvas and text layer; word and sentence highlights through the highlight registry on the text layer; scrolls the active word into view; clicking a text-layer word seeks.
- `apps/web/src/__tests__/pdf-anchors.test.ts` — index lookup; anchors for a sentence; a missing anchor returns no rectangles.
- `apps/web/e2e/pdf-view.spec.ts` — import `text.pdf`, switch to Pages, click play: within 10 s the `lectern-word` highlight range lies inside the page-1 text layer and its text equals the active word reported by the player; with furniture skipping on, no highlight ever lands on the running header during the first 5 sentences; switching back to Text keeps the position.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/web exec vitest run \
  && pnpm --filter @lectern/web run typecheck \
  && pnpm --filter @lectern/web run build \
  && pnpm --filter @lectern/web exec playwright test
```
Pass: exit code 0.

---

### U-031 — Web: offline packs and service worker

**Unit ID & Title:** U-031 — Web: offline packs and service worker

**Inputs & Dependencies**
- Depends on: U-030
- Reads: F§10.1 (offline), F§5.9 (`BlobCache.evictLru`)
- Uses: `@lectern/api-client` (`prefetchDocument`, `isCached`), `apps/web/src/services.ts`, `apps/web/src/settings/sections.ts`
- Patch scope: `apps/web/vite.config.ts`, `apps/web/src/main.tsx`, `apps/web/src/library/LibraryPage.tsx`
- Patch notes: `vite.config.ts` gains an inline plugin that writes `dist/precache-manifest.json` (every emitted file path) after the bundle closes. `main.tsx` registers `./sw.js` only when the protocol is `http:` or `https:` and the build is production. `LibraryPage.tsx` shows the offline button and state on each document row.

**REA Inspection Target & Method**
- Target: N/A — offline behaviour on the web is a Lectern design; the mobile reference is inspected in U-053. Do not call REA.

**Forbidden Actions**
- Do not add `vite-plugin-pwa`, Workbox, or any service-worker library.
- Do not let the service worker intercept requests to other origins or any path starting with `/v1/`; hub traffic is never cached by it.
- Do not cache `index.html` without revalidation; fetch it network-first with a cache fallback.
- Do not evict pinned blobs.

**Required File Outputs**
- `apps/web/public/sw.js` — plain JavaScript service worker: on install, fetch `./precache-manifest.json` and cache every listed file under a versioned cache name; on activate, delete old caches; on fetch, serve same-origin precached GETs cache-first and `index.html` network-first.
- `apps/web/src/offline/offline-service.ts` — `downloadForOffline(docId, onProgress)`, `removeOffline(docId)`, `offlineState(docId): 'none' | 'partial' | 'complete'`, `pinnedPredicate()`; pins are kept as the setting `offline:<docId>` with the voice and `synthSpeed` used; `enforceCacheLimit()` calls `evictLru` with the pinned predicate.
- `apps/web/src/offline/OfflineButton.tsx` — download, progress, complete, and remove states.
- `apps/web/src/offline/OfflineSection.tsx` — settings section (registered in `sections.ts`): cache size, limit, and a "clear unpinned audio" action.
- `apps/web/src/__tests__/offline-service.test.ts` — with memory stores and a fake chunk source: download pins and reports progress to completion; removing unpins; eviction keeps pinned blobs and removes others.
- `apps/web/e2e/offline.spec.ts` — import text, download for offline, wait for the complete state; then set the browser context offline and abort every request to the hub; reload: the app shell loads, the document opens, and playback advances through at least 3 sentences.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/web exec vitest run \
  && pnpm --filter @lectern/web run typecheck \
  && pnpm --filter @lectern/web run build \
  && test -s apps/web/dist/precache-manifest.json \
  && pnpm --filter @lectern/web exec playwright test
```
Pass: exit code 0.

---

### U-032 — Extension: WXT scaffold, manifest, settings, message protocol

**Unit ID & Title:** U-032 — Extension: WXT scaffold, manifest, settings, message protocol

**Inputs & Dependencies**
- Depends on: U-021, U-026
- Reads: F§10.2, F§11
- Uses: `@lectern/core` (`PlayerCommand`, `PlayerSnapshot`, `DocumentModelSchema`), `@lectern/api-client`, `packages/fixtures/make-icons.mjs`
- Installs (`apps/extension`, exact): `wxt`, `@wxt-dev/module-react`, `react`, `react-dom`, `zod`; devDependencies `vitest`, `jsdom`, `@playwright/test`, `@types/chrome`; workspace dependencies `@lectern/core`, `@lectern/core-tts`, `@lectern/api-client`, `@lectern/api-contract`, `@lectern/ui-web`; devDependencies `@lectern/server`, `@lectern/fixtures`

**REA Inspection Target & Method**
- Target: `T-EXT-PKG` (`targets/extension/`).
- Tools: `analyze_javascript_application` with `detail: "summary"`; direct read of `targets/extension/manifest.json` (declarations only).
- Method: read the manifest; run one summary analysis of the directory. Do not page into module contents.
- Questions: Which extension contexts are declared (service worker, content scripts, popup, options, side panel, offscreen)? Which permission categories are requested? On which pages do content scripts run, and at what load stage? Are keyboard commands declared, and how many?

**Forbidden Actions**
- Do not copy any entry, key order, description text, or identifier from the reference manifest.
- Do not request `tabs`, `webRequest`, `cookies`, `history`, `identity`, `debugger`, or `<all_urls>` in `host_permissions`; the hub origin is an optional host permission requested at run time.
- Do not load remote code or use `eval`, `new Function`, or inline scripts.
- Do not add a browser other than Chrome, a store listing, an update URL, or analytics.
- Do not register message handlers or features inside `background.ts`; use the two registries.

**Required File Outputs**
- `apps/extension/package.json` — name `@lectern/extension`; scripts `dev`, `build` (`wxt build`), `test`, `typecheck`, `e2e`.
- `apps/extension/tsconfig.json` — extends the config WXT generates.
- `apps/extension/vitest.config.ts` — `jsdom` environment, includes `src/**/*.test.{ts,tsx}`.
- `apps/extension/wxt.config.ts` — React module; manifest: name `Lectern`, a one-line original description, `permissions: ['activeTab', 'scripting', 'storage', 'offscreen', 'contextMenus']`, `optional_host_permissions: ['http://*/*', 'https://*/*']`, and four `commands`: `toggle-play` (`Alt+Shift+P`), `read-page` (`Alt+Shift+R`), `next-sentence` (`Alt+Shift+Right`), `previous-sentence` (`Alt+Shift+Left`).
- `apps/extension/public/icon/16.png` — generated icon.
- `apps/extension/public/icon/32.png` — generated icon.
- `apps/extension/public/icon/48.png` — generated icon.
- `apps/extension/public/icon/128.png` — generated icon.
- `apps/extension/src/messages.ts` — zod-validated union `ExtMessage`: `ext/read-active-tab`, `ext/read-document` (`{ document, startSentence? }`), `ext/read-selection`, `ext/command` (`{ command }`), `ext/snapshot` (`{ snapshot, title }`), `ext/stop`, `ext/open-pdf`, `ext/get-status`; typed `sendMessage`, `sendToTab`, and `onMessage` helpers; replies are `{ ok: true, data? } | { ok: false, code, message }`.
- `apps/extension/src/settings.ts` — `ExtSettings` (`hubUrl`, `token`, `webAppUrl`, `voiceId`, `rate`, `autoShowWidget`, `disabledSites`, `skipFurniture`) in `chrome.storage.local`, with `getSettings`, `setSettings`, `onSettingsChanged`.
- `apps/extension/src/background/handlers.ts` (registry) — `handlers: Partial<Record<ExtMessage['type'], Handler>>`; this unit registers `ext/get-status`.
- `apps/extension/src/background/features.ts` (registry) — `features: (() => void)[]`, each run once at service-worker start.
- `apps/extension/src/background/router.ts` — validates incoming messages, dispatches to `handlers`, replies `{ ok: false, code: 'NO_HANDLER' }` when none is registered.
- `apps/extension/entrypoints/background.ts` — `defineBackground`: installs the router and runs every feature.
- `apps/extension/entrypoints/popup/index.html` — popup document.
- `apps/extension/entrypoints/popup/main.tsx` — mounts `Popup`.
- `apps/extension/entrypoints/popup/Popup.tsx` — connection form (requests the hub origin permission on save, then tests `health()`), voice and speed, widget auto-show, and the buttons "Read this page" (`ext/read-active-tab`) and "Open this PDF in Lectern" (`ext/open-pdf`), which show the reply's message on failure.
- `apps/extension/src/__tests__/messages.test.ts` — every message type validates; malformed messages are rejected; the router replies `NO_HANDLER` for an unregistered type.
- `apps/extension/src/__tests__/settings.test.ts` — defaults, round trip, and change notification against an in-memory `chrome.storage` double.

**Pass/Fail Verification Test**
```sh
node packages/fixtures/make-icons.mjs --out apps/extension/public/icon --sizes 16,32,48,128 \
  && pnpm --filter @lectern/extension exec vitest run \
  && pnpm --filter @lectern/extension run typecheck \
  && pnpm --filter @lectern/extension run build \
  && node -e "const m=require('./apps/extension/.output/chrome-mv3/manifest.json');const p=[...m.permissions].sort().join();if(m.manifest_version!==3||m.name!=='Lectern'||p!=='activeTab,contextMenus,offscreen,scripting,storage'||(m.host_permissions||[]).length||Object.keys(m.commands).length!==4)process.exit(1)" \
  && node scripts/check-forbidden.mjs
```
Pass: exit code 0.

---

### U-033 — Extension: DOM text extraction and TextMap

**Unit ID & Title:** U-033 — Extension: DOM text extraction and TextMap

**Inputs & Dependencies**
- Depends on: U-032
- Reads: F§10.2 (text extraction, TextMap), F§5.2, F§5.3
- Uses: `@lectern/core` (`buildDocument`, `normalizeText`, `RawBlock`)
- Installs (`apps/extension`, exact): `@mozilla/readability`

**REA Inspection Target & Method**
- Target: `T-EXT-RUN` — the reference extension active on `http://127.0.0.1:4173/article.html` (served by `node targets/probe/serve.mjs`).
- Tools: `list_browser_targets`, `capture_browser_scenario`, `capture_web_screenshot`.
- Method: one connect-mode scenario with `start_url` set to the probe page: wait 3 s, click the extension's in-page play control, wait 10 s, capture accessibility text and DOM; one screenshot.
- Questions: Which page regions are read, and are the header, navigation, aside, and footer skipped? Where does reading start? Compared with the unmodified probe page, are elements inserted into or wrapped around the article text for highlighting (count them), or is the page text untouched?

**Forbidden Actions**
- Do not mutate the live page: no attributes, wrappers, class names, or style changes. Index attributes go only on the cloned document given to Readability.
- Do not read form fields, password inputs, `contenteditable` regions, or cross-origin frames.
- Do not send page text anywhere in this unit; extraction is pure.
- Do not use `innerText` (layout-dependent and absent in the test environment); walk text nodes.

**Required File Outputs**
- `apps/extension/src/content/visibility.ts` — `isReadableElement(el, env: { hasLayout: boolean })` applying the exclusion list in F§10.2; the zero-size check runs only when `env.hasLayout` is true.
- `apps/extension/src/content/article-root.ts` — `findArticleRoot(doc): Element`: clone the document, tag each cloned element with its pre-order index, run Readability on the clone, take the lowest common ancestor of the surviving indexes, and return the live element at that index; fall back to `main`, then `body`.
- `apps/extension/src/content/text-map.ts` — `buildTextMap(root, env): TextMap` with `blocks: { element, kind, level?, text }[]`, `entries: { node, blockIndex, start, end }[]`, and `rangeFor(blockIndex, charStart, charEnd): Range | null`. Tracks the mapping between raw text-node offsets and normalized block text so ranges are exact across inline elements and collapsed whitespace.
- `apps/extension/src/content/page-document.ts` — `extractPageDocument(doc, env): { document: DocumentModel, textMap: TextMap }` with `source.kind = 'html'` and `source.uri = location.href`; `extractSelectionDocument(selection, env)` with `source.kind = 'selection'`.
- `apps/extension/src/content/__tests__/text-map.test.ts` — on inline HTML fixtures in `jsdom`: an article with navigation, aside, and footer yields only article text; `hidden` and `aria-hidden` content is excluded; for **every word of every sentence**, `rangeFor(...)` returns a range whose text equals the word, including paragraphs with nested inline elements, line breaks, and runs of whitespace; a page without article structure falls back to `body`; the live document's serialized HTML is byte-identical before and after extraction.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/extension exec vitest run src/content/__tests__/text-map.test.ts \
  && pnpm --filter @lectern/extension run typecheck
```
Pass: exit code 0.

---

### U-034 — Extension: offscreen audio host

**Unit ID & Title:** U-034 — Extension: offscreen audio host

**Inputs & Dependencies**
- Depends on: U-032
- Reads: F§10.2 (contexts table), F§5.7, F§5.8
- Uses: `@lectern/core` (`createPlayerController`), `@lectern/api-client` (`createHubClient`, `createCachingChunkSource`), `@lectern/ui-web` (`createHtmlAudioQueueSink`, `createIdbBlobCache`, `openLecternDb`), `apps/extension/src/messages.ts`, `apps/extension/src/settings.ts`, both background registries

**REA Inspection Target & Method**
- Target: `T-EXT-PKG` (`targets/extension/`).
- Tools: direct read of `targets/extension/manifest.json`; `analyze_javascript_application` with `detail: "summary"`.
- Method: read the manifest for offscreen, audio, and background declarations; one summary analysis for the list of HTML entry documents.
- Questions: Is an offscreen-document permission declared? Which HTML documents ship in the package besides the popup? Which context is the likely owner of audio playback (`INFERRED` or `UNKNOWN`; static evidence cannot prove it)?

**Forbidden Actions**
- Do not play audio or call the hub from the service worker or a content script.
- Do not create more than one offscreen document; check for an existing one first.
- Do not keep the offscreen document alive when nothing is loaded; close it 30 s after `stop` or `ended`.
- Do not persist page documents; they live in memory for the session.

**Required File Outputs**
- `apps/extension/entrypoints/offscreen/index.html` — offscreen document.
- `apps/extension/entrypoints/offscreen/main.ts` — builds the hub client from settings, the IndexedDB blob cache, the caching chunk source, the HTML audio sink, and a `PlayerController` with an in-memory `DocumentProvider`; handles `ext/read-document`, `ext/command`, and `ext/stop`; posts `ext/snapshot` on every state change and at most every 50 ms while playing; rebuilds the client when settings change.
- `apps/extension/src/background/offscreen.ts` — `ensureOffscreen()` (creates the document with reason `AUDIO_PLAYBACK` if `chrome.runtime.getContexts` shows none) and `closeOffscreenLater()`.
- `apps/extension/src/background/session.ts` — `ReadingSession`: the active tab ID; relays `ext/read-document` and `ext/command` to the offscreen document and `ext/snapshot` to the active tab and popup; stops when the tab closes or navigates; starting in another tab stops the previous session.
- `apps/extension/src/background/__tests__/session.test.ts` — with a fake `chrome` API: relays in both directions; tab close and navigation stop the session; a second tab takes over; commands with no session reply `{ ok: false, code: 'NO_SESSION' }`.
- `apps/extension/playwright.config.ts` — one worker, `globalSetup` starting a mock-engine hub and a static server for test pages.
- `apps/extension/e2e/global-setup.ts` — starts the hub (as in U-027) and serves `apps/extension/e2e/pages/` on a free port; writes `apps/extension/e2e/.env.local`.
- `apps/extension/e2e/fixtures.ts` — a Playwright fixture launching Playwright's bundled Chromium with a persistent context, `--load-extension` and `--disable-extensions-except` pointing at `.output/chrome-mv3`; exposes `serviceWorker`, `extensionId`, and `configure()` (writes hub settings into `chrome.storage.local` and grants the origin).
- `apps/extension/e2e/pages/article.html` — original test article with navigation, aside, and footer furniture.
- `apps/extension/e2e/offscreen.spec.ts` — after `ext/read-document` with a three-sentence document is sent from the service worker: exactly one offscreen context exists; snapshots reach the service worker with state `playing` and an advancing sentence index; `ext/command` pause yields `paused`; `ext/stop` yields `idle`.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/extension exec vitest run \
  && pnpm --filter @lectern/extension run typecheck \
  && pnpm --filter @lectern/extension run build \
  && pnpm --filter @lectern/extension exec playwright install chromium \
  && pnpm --filter @lectern/extension exec playwright test e2e/offscreen.spec.ts
```
Pass: exit code 0.

---

### U-035 — Extension: in-page highlighting, click-to-read, auto-scroll

**Unit ID & Title:** U-035 — Extension: in-page highlighting, click-to-read, auto-scroll

**Inputs & Dependencies**
- Depends on: U-033, U-034
- Reads: F§10.2 (highlights), F§5.6 (c) and (d)
- Uses: `apps/extension/src/content/page-document.ts`, `apps/extension/src/content/text-map.ts`, `apps/extension/src/messages.ts`, `apps/extension/src/background/session.ts`, `@lectern/ui-web` (`createAutoScroll`), `apps/extension/e2e/fixtures.ts`, `apps/extension/e2e/pages/article.html`

**REA Inspection Target & Method**
- Target: `T-EXT-RUN` on the probe page.
- Tools: `list_browser_targets`, `capture_browser_scenario`, `capture_web_screenshot`.
- Method: one connect-mode scenario on the probe page: start reading, wait 6 s, scroll down one viewport, wait 6 s, capture accessibility text; two screenshots (reading; after the manual scroll).
- Questions: How do the sentence and word highlights differ visually (relative description only)? Does the page auto-scroll to follow reading, and what happens after a manual scroll? How does the user start reading from a chosen paragraph (hover control, click, modifier key)?

**Forbidden Actions**
- Do not insert, wrap, or restyle page elements; highlights use the CSS Custom Highlight API with rules added through `document.adoptedStyleSheets`.
- Do not hijack plain clicks; read-from-here is `Alt`+click only, and the event is consumed only when it maps to a readable word.
- Do not run in frames other than the top frame.
- Do not start reading automatically on page load.

**Required File Outputs**
- `apps/extension/src/content/highlighter.ts` — `createHighlighter(textMap)` with `show(sentenceIndex, wordIndex)` and `clear()`; registers `lectern-sentence` and `lectern-word`; adds one constructed stylesheet to `adoptedStyleSheets` and removes it on `clear`.
- `apps/extension/src/content/click-to-read.ts` — maps an `Alt`+click point to `{ sentenceIndex, wordIndex }` through the caret-from-point API and the TextMap entries.
- `apps/extension/src/content/reading-session.ts` — `startPageReading(startSentence?)`, `startSelectionReading()`, `stop()`; extracts the document, sends `ext/read-document`, applies incoming `ext/snapshot` to the highlighter and auto-scroll, and stops on `pagehide`.
- `apps/extension/src/content/features.ts` (registry) — `contentFeatures: ((ctx: ContentContext) => void)[]`; this unit registers the reading session.
- `apps/extension/entrypoints/content/index.ts` — `defineContentScript` (`matches: ['<all_urls>']`, `runAt: 'document_idle'`, top frame only); builds the `ContentContext`, runs every content feature, and answers `ext/read-active-tab`.
- `apps/extension/src/background/read-active-tab.ts` — handler for `ext/read-active-tab` and the `read-page` command: asks the active tab's content script to start reading; registered in `handlers.ts` and `features.ts`.
- `apps/extension/src/content/__tests__/click-to-read.test.ts` — point-to-position mapping with a stubbed caret API; unreadable targets return null.
- `apps/extension/e2e/highlight.spec.ts` — on the test article: after `ext/read-active-tab`, within 10 s `CSS.highlights.has('lectern-word')` is true and the highlighted text is a word of the article body (never of the navigation or footer); the highlighted word changes at least 5 times in 10 s; `document.querySelectorAll('*').length` and the article's `innerHTML` are identical before reading and during reading; `Alt`+click on a word in the last paragraph moves the sentence index there.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/extension exec vitest run \
  && pnpm --filter @lectern/extension run typecheck \
  && pnpm --filter @lectern/extension run build \
  && pnpm --filter @lectern/extension exec playwright test e2e/offscreen.spec.ts e2e/highlight.spec.ts
```
Pass: exit code 0.

---

### U-036 — Extension: floating widget

**Unit ID & Title:** U-036 — Extension: floating widget

**Inputs & Dependencies**
- Depends on: U-035
- Reads: F§10.2 (content script row), F§10.1 (player bar)
- Uses: `@lectern/ui-web` (`PlayerBar` compact variant, `styles.css`), `apps/extension/src/content/features.ts`, `apps/extension/src/content/reading-session.ts`, `apps/extension/src/settings.ts`, `apps/extension/e2e/fixtures.ts`

**REA Inspection Target & Method**
- Target: `T-EXT-RUN` on the probe page.
- Tools: `list_browser_targets`, `inspect_web_page`, `capture_browser_scenario`, `capture_web_screenshot`.
- Method: `inspect_web_page` with accessibility text right after the probe page loads; one connect-mode scenario that clicks the in-page player's main control and waits 3 s; three screenshots (idle, expanded or playing, after the operator drags it).
- Questions: Does the in-page player appear automatically on load? What are its idle and active forms, their approximate sizes, and default position? Which controls does it expose? Can it be moved, and is the position remembered? How is it dismissed, per page or per site?

**Forbidden Actions**
- Do not render the widget in the page's light DOM; it lives in a shadow root on a single host element appended to `document.documentElement`.
- Do not let page styles in or widget styles out; all widget CSS is inside the shadow root.
- Do not mount on sites in `disabledSites`, in frames, or on pages with no readable text.
- Do not imitate the reference widget's shape, position, or control arrangement; pick a different default corner and form and record them as `DESIGN`.

**Required File Outputs**
- `apps/extension/src/content/widget/drag.ts` — pure `clampToViewport(position, size, viewport)` and `nextPosition(start, delta)`.
- `apps/extension/src/content/widget/Widget.tsx` — collapsed pill (play/pause and expand) and expanded bar (compact `PlayerBar`, close, "disable on this site"); pointer-drag handle; keyboard reachable.
- `apps/extension/src/content/widget/mount.ts` — creates the host element `lectern-widget` with an open shadow root, injects styles, renders the widget, restores the per-origin position from settings, and unmounts cleanly; registered in `contentFeatures` when `autoShowWidget` is on, and always mounted once reading starts.
- `apps/extension/src/content/widget/widget.css` — widget styles using the `--lectern-*` tokens.
- `apps/extension/src/content/widget/__tests__/drag.test.ts` — clamping at each viewport edge and after a resize.
- `apps/extension/e2e/widget.spec.ts` — on the test article with auto-show on: exactly one `lectern-widget` host exists and the article HTML is unchanged; clicking play in the widget starts reading (word highlight appears); pause freezes the sentence index; choosing 3× is reflected in the next snapshot's `rate`; dragging moves the host and the position persists after a reload; "disable on this site" removes the widget and it stays absent after a reload.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/extension exec vitest run \
  && pnpm --filter @lectern/extension run typecheck \
  && pnpm --filter @lectern/extension run build \
  && pnpm --filter @lectern/extension exec playwright test e2e/highlight.spec.ts e2e/widget.spec.ts
```
Pass: exit code 0.

---

### U-037 — Extension: context menu, commands, PDF hand-off, full end-to-end suite

**Unit ID & Title:** U-037 — Extension: context menu, commands, PDF hand-off, full end-to-end suite

**Inputs & Dependencies**
- Depends on: U-036
- Reads: F§10.2 (background row, PDF tabs, permissions)
- Uses: both background registries, `apps/extension/src/background/session.ts`, `apps/extension/src/content/reading-session.ts`, `apps/extension/src/content/features.ts`, `apps/extension/e2e/fixtures.ts`

**REA Inspection Target & Method**
- Target: `T-EXT-PKG` (`targets/extension/`).
- Tools: direct read of `targets/extension/manifest.json`.
- Method: read the `commands` and permission declarations only.
- Questions: How many keyboard commands are declared and for which generic actions? Is a context-menu permission declared? Is there any declaration that indicates special handling of PDF pages (`UNKNOWN` if none)?

**Forbidden Actions**
- Do not add permissions beyond those set in U-032.
- Do not fetch or parse PDFs in the extension; hand the URL to the web app.
- Do not hand off `file:` URLs or URLs from private browsing windows; show an explanatory message instead.
- Do not weaken or delete earlier end-to-end specs to make the full suite pass.

**Required File Outputs**
- `apps/extension/src/background/context-menu.ts` — creates the menu items "Read selection" (selection context) and "Read from here" (page context) on install; routes clicks to the active tab's content script; registered in `features.ts`.
- `apps/extension/src/background/commands.ts` — maps the four manifest commands to `ext/command` messages or `read-page`; registered in `features.ts`.
- `apps/extension/src/background/pdf-handoff.ts` — `isPdfUrl(url)`, `handoffUrl(webAppUrl, pdfUrl)` (`{webAppUrl}/#/import?url=<encoded>`), and the `ext/open-pdf` handler, which opens the hand-off URL in a new tab or replies with code `NO_WEB_APP`, `NOT_A_PDF`, or `LOCAL_FILE`; registered in `handlers.ts`.
- `apps/extension/src/content/selection-feature.ts` — answers `ext/read-selection` by calling `startSelectionReading()`; registered in `contentFeatures`.
- `apps/extension/src/background/__tests__/pdf-handoff.test.ts` — URL detection (extension, query strings, case), encoding, and each refusal code.
- `apps/extension/e2e/full.spec.ts` — (1) the `read-page` command path reads the article across at least 2 sentences; (2) with a paragraph selected, the "Read selection" handler reads only that paragraph and then reaches `ended`; (3) `toggle-play`, `next-sentence`, and `previous-sentence` command handlers change the snapshot accordingly; (4) `ext/open-pdf` for an `https` PDF URL opens a tab at the expected hand-off URL; (5) navigating the reading tab away produces state `idle` and closes the offscreen document within 35 s; (6) with a wrong token, starting reading surfaces an error state in the widget and no audio plays.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/extension exec vitest run \
  && pnpm --filter @lectern/extension run typecheck \
  && pnpm --filter @lectern/extension run build \
  && pnpm --filter @lectern/extension exec playwright test \
  && node scripts/check-forbidden.mjs
```
Pass: exit code 0 for the entire extension end-to-end suite.

---

# Phase 3 — Desktop App (Windows, Linux)

### U-038 — Desktop: Electron shell, secure defaults, bridge, web integration

**Unit ID & Title:** U-038 — Desktop: Electron shell, secure defaults, bridge, web integration

**Inputs & Dependencies**
- Depends on: U-031
- Reads: F§10.3, F§11
- Uses: the `apps/web` production build, `packages/ui-web/src/desktop-bridge.ts` (`LecternDesktopBridge`), `apps/web/src/boot.ts`, `apps/web/src/import/import-service.ts`, `apps/web/src/router.ts`, `packages/fixtures/make-icons.mjs`; `node scripts/preflight.mjs --phase 3` must pass
- Installs (`apps/desktop`, exact): `electron`, `electron-vite`, `electron-builder`, `zod`; devDependencies `@playwright/test`, `vitest`; workspace dependencies `@lectern/core`, `@lectern/ui-web`; devDependencies `@lectern/server`, `@lectern/fixtures`

**REA Inspection Target & Method**
- Target: `T-WIN` (`targets/desktop-win/`).
- Tools: `open_binary`, `inspect_artifact`, `inspect_electron_fuses`, `analyze_javascript_application` with `detail: "summary"`, `close_binary`.
- Method: open the package or main executable; take the member inventory summary. Only if the inventory contains an `app.asar` or a JavaScript application tree, run `inspect_electron_fuses` and one summary analysis. Close the session.
- Questions: Is the reference Windows application a JavaScript-shell application, a managed application, or native code (state the inventory facts this rests on)? Is a web UI bundled? Are local model files bundled (list by file extension and size class only; do not open them)? Which top-level components exist (main program, helpers, services)?

**Forbidden Actions**
- Do not enable `nodeIntegration`, disable `contextIsolation` or `sandbox`, use the `remote` module, or disable web security.
- Do not expose `ipcRenderer`, `require`, or file-system access to the renderer; expose only the bridge members in F§10.3.
- Do not load remote URLs in any window; windows load packaged files only, and `http(s)` links open in the system browser.
- Do not add auto-update, crash reporting, telemetry, protocol handlers, or auto-start.
- Do not copy the web source into the desktop app; consume the built `apps/web/dist`.
- Do not add macOS code paths, menu roles, or build targets.

**Required File Outputs**
- `apps/desktop/package.json` — name `@lectern/desktop`; `main: "out/main/index.js"`; `desktopName: "dev.lectern.desktop.desktop"`; scripts `build` (`node scripts/copy-web.mjs && electron-vite build`), `dev`, `test`, `typecheck`, `e2e`, `dist:linux` (`electron-builder --linux AppImage deb`), `dist:win` (`electron-builder --win nsis`).
- `apps/desktop/tsconfig.json` — extends the base config, Node and DOM libs.
- `apps/desktop/electron.vite.config.ts` — main and preload builds (no bundled renderer; the renderer is the copied web build).
- `apps/desktop/vitest.config.ts` — Node environment, includes `src/**/*.test.ts`.
- `apps/desktop/scripts/copy-web.mjs` — copies `apps/web/dist` to `apps/desktop/resources/web`; exits 1 if the web build is missing.
- `apps/desktop/resources/icons/512.png` — application icon from `make-icons.mjs`.
- `apps/desktop/resources/icons/32.png` — tray icon from `make-icons.mjs`.
- `apps/desktop/src/main/ipc.ts` — channel names and zod schemas for every bridge message; `handle` and `send` helpers that validate payloads in both directions.
- `apps/desktop/src/main/settings-store.ts` — `DesktopSettings` (`hotkeys`, `watchFolders`, `miniBounds`, `processedFiles`) with defaults from F§10.3; JSON file in the user-data directory (`LECTERN_USER_DATA` overrides the directory); atomic writes; zod validation with fallback to defaults on a corrupt file; change events.
- `apps/desktop/src/main/actions.ts` — the action bus: `DesktopAction` (`readSelection`, `readRegion`, `togglePlay`, `nextSentence`, `previousSentence`, `faster`, `slower`, `toggleMini`, `showMain`); every trigger (hotkey, tray, test) calls `app.emit('lectern:action', action)`; `onAction(action, handler)` registers handlers.
- `apps/desktop/src/main/context.ts` — `MainContext` (`settings`, `actions`, `windows`, `status`, `sendToMain(channel, payload)`), plus a `DesktopStatus` object published to renderers through `settings.onStatus`.
- `apps/desktop/src/main/windows/main-window.ts` — creates the main window with the security settings in F§10.3 and `autoplayPolicy: 'no-user-gesture-required'`; loads `resources/web/index.html`; hides instead of closing; blocks navigation away from the app files; opens external links with `shell.openExternal` for `http:` and `https:` only.
- `apps/desktop/src/main/features.ts` (registry) — `features: ((ctx: MainContext) => void)[]`, run after the app is ready.
- `apps/desktop/src/main/index.ts` — single-instance lock (a second launch shows the first instance's main window), application lifecycle, builds the context, creates the main window, runs every feature.
- `apps/desktop/src/preload/index.ts` — exposes `window.lecternDesktop` implementing `LecternDesktopBridge` over the validated IPC channels.
- `apps/web/src/desktop/desktop-integration.ts` — boot feature, active only when the bridge exists: handles `onImportRequest` (imports each file through `import-service`, moves results into the named folder, creating it if needed, and opens the last one with `?autoplay=1` when `play` is true) and `onReadText` (imports the text into the folder `Quick reads`, keeps only its 50 newest documents, opens it with `?autoplay=1`); registered in `apps/web/src/boot.ts`.
- `apps/desktop/src/main/__tests__/settings-store.test.ts` — defaults, round trip, corrupt-file recovery, atomic write, change events.
- `apps/desktop/src/main/__tests__/ipc.test.ts` — each channel's valid payload passes and an invalid payload is rejected.
- `apps/desktop/playwright.config.ts` — one worker, `globalSetup` starting a mock-engine hub.
- `apps/desktop/e2e/global-setup.ts` — starts the hub (as in U-027) and writes `apps/desktop/e2e/.hub.local`.
- `apps/desktop/e2e/launch.ts` — `launchApp()` using Playwright `_electron` on `out/main/index.js` with a temporary `LECTERN_USER_DATA`; passes `--no-sandbox` only when `LECTERN_E2E_NO_SANDBOX=1`; `connect(page)` saves the hub connection in the renderer; `emitAction(app, action)` evaluates `app.emit('lectern:action', action)` in the main process.
- `apps/desktop/e2e/shell.spec.ts` — the window title is `Lectern`; `window.lecternDesktop.platform` is `linux` or `win32`; `typeof require` and `typeof process` are `undefined` in the renderer; a navigation to `https://example.org` is blocked; after `connect`, importing text through the UI and pressing play reaches state `playing`; closing the main window leaves it hidden, not destroyed; a second launch exits and the first window becomes visible.

**Pass/Fail Verification Test**
```sh
node scripts/preflight.mjs --phase 3 \
  && node packages/fixtures/make-icons.mjs --out apps/desktop/resources/icons --sizes 32,512 \
  && pnpm --filter @lectern/web run build \
  && pnpm --filter @lectern/web exec playwright test \
  && pnpm --filter @lectern/desktop exec vitest run \
  && pnpm --filter @lectern/desktop run typecheck \
  && pnpm --filter @lectern/desktop run build \
  && xvfb-run -a pnpm --filter @lectern/desktop exec playwright test e2e/shell.spec.ts
```
Pass: exit code 0. The web end-to-end suite still passes with the new boot feature present.

---

### U-039 — Desktop: tray and always-on-top mini-player

**Unit ID & Title:** U-039 — Desktop: tray and always-on-top mini-player

**Inputs & Dependencies**
- Depends on: U-038
- Reads: F§10.3 (mini-player, bridge), F§10.1 (`PlayerBus`, `#/mini`)
- Uses: `apps/desktop/src/main/features.ts`, `apps/desktop/src/main/context.ts`, `apps/desktop/src/main/actions.ts`, `apps/desktop/src/main/ipc.ts`, `apps/desktop/e2e/launch.ts`, the web route `#/mini`

**REA Inspection Target & Method**
- Target: `T-SHOTS` (`targets/shots/desktop/`), operator screenshots of the reference desktop application's compact player and tray or notification-area menu.
- Tools: none; view the images directly.
- Method: examine each image in the directory.
- Questions: Does the reference offer a compact always-visible player? What are its approximate size, position, and controls? What entries does its tray or notification-area menu have? Does closing the main window end playback?

**Forbidden Actions**
- Do not give the mini-player its own player logic or audio; it is a `PlayerBus` remote, and all audio stays in the main window.
- Do not make the mini-player focus-stealing; show it without activating it.
- Do not add tray entries for accounts, upgrades, or updates.
- Do not quit the app when all windows are hidden; quit only from the tray menu's Quit entry.

**Required File Outputs**
- `apps/desktop/src/main/player-relay.ts` — relays `player:command` from the mini window, tray, and action bus to the main window, and `player:snapshot` from the main window to the mini window and tray; caches the last snapshot; maps `togglePlay`, `nextSentence`, `previousSentence`, `faster`, and `slower` actions to `PlayerCommand`s (`faster` and `slower` change the rate by 0.1 within the allowed range).
- `apps/desktop/src/main/windows/mini-window.ts` — frameless, always-on-top, skip-taskbar, non-resizable 360×72 window loading `resources/web/index.html#/mini`; shown inactive; position restored from and saved to `miniBounds`, clamped to a visible display.
- `apps/desktop/src/main/tray.ts` — tray icon with menu: Play or Pause (label follows the snapshot), Next sentence, Show Lectern, Show or Hide mini-player, Quit.
- `apps/desktop/src/main/features/shell-features.ts` — registers the relay, mini window (`toggleMini`, `showMain` actions), and tray in `features.ts`.
- `apps/desktop/src/main/__tests__/player-relay.test.ts` — action-to-command mapping including rate clamping at 0.5 and 5.0; snapshot caching.
- `apps/desktop/e2e/mini.spec.ts` — after `emitAction(app, 'toggleMini')` two windows exist; the mini window reports `isAlwaysOnTop()` true and a 360×72 content size; with a document playing in the main window, the mini window shows the playing state; clicking pause in the mini window pauses the main player; `emitAction(app, 'togglePlay')` resumes; after the main window is closed, the sentence index still advances for 5 s; the mini position persists across an app restart.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/desktop exec vitest run \
  && pnpm --filter @lectern/desktop run typecheck \
  && pnpm --filter @lectern/web run build \
  && pnpm --filter @lectern/desktop run build \
  && xvfb-run -a pnpm --filter @lectern/desktop exec playwright test e2e/shell.spec.ts e2e/mini.spec.ts
```
Pass: exit code 0.

---

### U-040 — Desktop: global hotkeys

**Unit ID & Title:** U-040 — Desktop: global hotkeys

**Inputs & Dependencies**
- Depends on: U-039
- Reads: F§10.3 (global hotkeys)
- Uses: `apps/desktop/src/main/actions.ts`, `apps/desktop/src/main/settings-store.ts`, `apps/desktop/src/main/context.ts`, `apps/desktop/src/main/features.ts`, `apps/web/src/settings/sections.ts`, `apps/desktop/e2e/launch.ts`

**REA Inspection Target & Method**
- Target: `T-WIN` (`targets/desktop-win/`).
- Tools: `open_binary`, `inspect_pe_imports`, `inspect_pe_resources`, `close_binary`.
- Method: open the main executable; list imported functions; list resource types. Record API *families* only.
- Questions: Does the main executable import a system-wide hotkey registration API, a low-level keyboard hook API, or neither (`UNKNOWN` if the logic may live in another module)? Do resources include an accelerator table?

**Forbidden Actions**
- Do not use a native keyboard-hook module, `iohook`, `uiohook-napi`, `robotjs`, or `nut-js`; use Electron `globalShortcut` only.
- Do not register a shortcut the user did not configure, and do not register single keys without a modifier.
- Do not treat the boolean returned by `register` as final on Wayland; use the asynchronous resolution described in the installed Electron documentation.
- Do not leave shortcuts registered after quit.

**Required File Outputs**
- `apps/desktop/src/main/hotkey-model.ts` — pure: `DEFAULT_HOTKEYS` (F§10.3), `validateAccelerator(s)` (requires a modifier and a key), `findConflicts(map)` (duplicates), `diffHotkeys(previous, next)` (which to unregister and register).
- `apps/desktop/src/main/hotkeys.ts` — registers all configured accelerators; each fires its `DesktopAction` on the action bus; publishes per-action status `registered | failed | pending` in `DesktopStatus`; re-registers on settings change using the diff; unregisters everything on `will-quit`; handles the Wayland portal resolution event; registered in `features.ts`.
- `apps/web/src/desktop/HotkeysSection.tsx` — settings section (rendered only when the bridge exists): one row per action with the accelerator, a capture-keys control, the live status, and a reset-to-defaults button; rejects invalid and duplicate accelerators before saving; registered in `sections.ts`.
- `apps/desktop/src/main/__tests__/hotkey-model.test.ts` — defaults are valid and conflict-free; invalid strings rejected; duplicate detection; diff results.
- `apps/desktop/e2e/hotkeys.spec.ts` — after start, `globalShortcut.isRegistered` is true for each default (evaluated in the main process); changing "play/pause" to `Control+Alt+P` through the settings section unregisters the old accelerator and registers the new one, and the change survives a restart; an accelerator already held by another action is rejected in the UI; status values are shown.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/desktop exec vitest run \
  && pnpm --filter @lectern/web exec vitest run \
  && pnpm --filter @lectern/web run typecheck \
  && pnpm --filter @lectern/desktop run typecheck \
  && pnpm --filter @lectern/web run build \
  && pnpm --filter @lectern/desktop run build \
  && xvfb-run -a pnpm --filter @lectern/desktop exec playwright test e2e/hotkeys.spec.ts
```
Pass: exit code 0. Wayland behaviour is not verified by this test; note `wayland: unverified` in the status line.

---

### U-041 — Desktop: OS selection capture and read-selection flow

**Unit ID & Title:** U-041 — Desktop: OS selection capture and read-selection flow

**Inputs & Dependencies**
- Depends on: U-040
- Reads: F§10.3 (selection capture table)
- Uses: `apps/desktop/src/main/actions.ts`, `apps/desktop/src/main/context.ts`, `apps/desktop/src/main/features.ts`, `apps/desktop/src/main/ipc.ts`, `apps/web/src/desktop/desktop-integration.ts` (`onReadText`), `apps/desktop/e2e/launch.ts`

**REA Inspection Target & Method**
- Target: `T-WIN` (`targets/desktop-win/`).
- Tools: `open_binary`, `inspect_pe_imports`, `inspect_artifact`, `close_binary`.
- Method: open the main executable and list imports; take the package inventory summary to see which other executable modules ship. Record API families only.
- Questions: Which API families that could obtain text from other applications are imported (accessibility or UI-automation, clipboard, synthetic input)? Is a separate helper module shipped that could own this function? Everything about run-time behaviour is `UNKNOWN`.

**Forbidden Actions**
- Do not add native modules, accessibility hooks, key loggers, or a background clipboard monitor; capture happens only when the user triggers the action.
- Do not leave the user's clipboard modified on Windows; restore the saved text on every path, including errors and timeouts.
- Do not store or log captured text outside the document that is created from it.
- Do not run shell strings; call executables with argument arrays and a 2-second timeout.

**Required File Outputs**
- `apps/desktop/src/main/selection/provider.ts` — `SelectionProvider` (`id`, `capture(): Promise<string>`), `detectEnvironment(platform, env): 'linux-x11' | 'linux-wayland' | 'windows'`, `SelectionError` with codes `TOOL_MISSING`, `TIMEOUT`, `EMPTY`.
- `apps/desktop/src/main/selection/linux.ts` — X11: read the primary selection with the injected clipboard reader, then fall back to `xclip -o -selection primary`, then `xsel -o -p`. Wayland: `wl-paste --primary --no-newline`, then the injected clipboard reader. `TOOL_MISSING` names the packages to install.
- `apps/desktop/src/main/selection/windows.ts` — the clipboard round trip in F§10.3 using injected clipboard, `exec` (PowerShell with `-NoProfile -NonInteractive`), and `sleep`.
- `apps/desktop/src/main/selection/read-selection.ts` — handler for the `readSelection` action: capture, trim, cap at 100 000 characters, send `reader:read-text` (title = first 60 characters) to the main window, and show the mini-player; on `EMPTY` or an error, show a desktop notification with the reason; publishes the provider ID in `DesktopStatus`; registered in `features.ts`.
- `apps/desktop/src/main/selection/__tests__/selection.test.ts` — with fake `exec`, clipboard, and `sleep`: environment detection for the three cases; X11 native success; fallback order when a tool is missing; both tools missing → `TOOL_MISSING`; Wayland path; Windows restores the clipboard after success, after timeout, and after `exec` failure; unchanged clipboard → `EMPTY`; argument arrays never pass through a shell.
- `apps/desktop/e2e/selection.spec.ts` — under X11: write three sentences to the primary selection from the main process (`clipboard.writeText(text, 'selection')`), `emitAction(app, 'readSelection')`; within 15 s the main window is on a `#/read/` route, the player state is `playing`, the mini window is visible, and the library shows the document in the folder `Quick reads`; with an empty selection, no document is created.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/desktop exec vitest run \
  && pnpm --filter @lectern/desktop run typecheck \
  && pnpm --filter @lectern/web run build \
  && pnpm --filter @lectern/desktop run build \
  && xvfb-run -a pnpm --filter @lectern/desktop exec playwright test e2e/selection.spec.ts
```
Pass: exit code 0. The Windows and Wayland providers are verified by unit tests only; note `windows: unit-tested, wayland: unit-tested` in the status line.

---

### U-042 — Desktop: screen-region OCR reader

**Unit ID & Title:** U-042 — Desktop: screen-region OCR reader

**Inputs & Dependencies**
- Depends on: U-041
- Reads: F§10.3 (screen-region reader), F§5.5
- Uses: `apps/desktop/src/main/actions.ts`, `apps/desktop/src/main/features.ts`, `apps/desktop/src/main/ipc.ts`, `apps/web/src/desktop/desktop-integration.ts` (`onImportRequest`), `apps/desktop/e2e/launch.ts`, the hub's image parsing (U-020)

**REA Inspection Target & Method**
- Target: `T-WIN` (`targets/desktop-win/`).
- Tools: `open_binary`, `inspect_pe_imports`, `close_binary`.
- Method: open the main executable and list imports. Record API families only.
- Questions: Are screen-capture or graphics-capture API families imported? Are OCR-related system API families imported, or is OCR likely bundled or remote (`UNKNOWN` unless imports decide it)?

**Forbidden Actions**
- Do not capture the screen except in direct response to the `readRegion` action or the bridge's `captureRegion()` call.
- Do not save screenshots to disk or keep them after the import request is sent.
- Do not run OCR in the desktop app; send the PNG through the import pipeline to the hub.
- Do not bundle the overlay with a framework; it is one static HTML file and one script.

**Required File Outputs**
- `apps/desktop/src/main/capture/region-math.ts` — pure: `normalizeRect(start, end)`, `toDevicePixels(rect, scaleFactor)`, `clampToDisplay(rect, displaySize)`, `isTooSmall(rect)` (under 8×8).
- `apps/desktop/src/main/capture/overlay-window.ts` — transparent, frameless, always-on-top, full-display window on the display under the cursor, loading the overlay page; resolves with the selected rectangle or `null` on `Esc`.
- `apps/desktop/resources/overlay/index.html` — static overlay page with a crosshair cursor and a dimmed background.
- `apps/desktop/resources/overlay/overlay.js` — plain script: drag to draw the rectangle, `Esc` to cancel, submits through the overlay preload.
- `apps/desktop/src/preload/overlay.ts` — exposes only `submit(rect)` and `cancel()`.
- `apps/desktop/src/main/capture/capture-region.ts` — handler for `readRegion` and `captureRegion()`: hide the mini-player, show the overlay, capture the display with `desktopCapturer`, crop with `nativeImage`, send an import request `{ files: [screen-region.png], play: true, folderName: 'Quick reads' }`, restore the mini-player; a too-small or cancelled selection does nothing; registered in `features.ts`.
- `apps/desktop/src/main/capture/__tests__/region-math.test.ts` — drags in all four directions normalize identically; scale factors 1, 1.25, and 2; clamping; minimum size.
- `apps/desktop/e2e/region.spec.ts` — with the main window maximized on a reader page whose heading is the fixture title in large type: `emitAction(app, 'readRegion')` opens the overlay window; a mouse drag across the heading area closes it; within 60 s the library's `Quick reads` folder contains a new document whose text includes at least one word of the fixture title; pressing `Esc` instead creates no document.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/desktop exec vitest run \
  && pnpm --filter @lectern/desktop run typecheck \
  && pnpm --filter @lectern/web run build \
  && pnpm --filter @lectern/desktop run build \
  && xvfb-run -a pnpm --filter @lectern/desktop exec playwright test e2e/region.spec.ts
```
Pass: exit code 0. Screen capture on Wayland goes through a system picker and is not verified here; note `wayland: unverified` in the status line.

---

### U-043 — Desktop: watched folders and automatic import

**Unit ID & Title:** U-043 — Desktop: watched folders and automatic import

**Inputs & Dependencies**
- Depends on: U-038
- Reads: F§10.3 (file watcher)
- Uses: `apps/desktop/src/main/settings-store.ts`, `apps/desktop/src/main/features.ts`, `apps/desktop/src/main/ipc.ts`, `apps/web/src/desktop/desktop-integration.ts` (`onImportRequest`), `apps/web/src/settings/sections.ts`, `apps/desktop/e2e/launch.ts`, files in `packages/fixtures/generated/`
- Installs (`apps/desktop`, exact): `chokidar`

**REA Inspection Target & Method**
- Target: N/A — the watched folder is a Lectern substitute for cloud-drive import (F§4) with no reference counterpart. Do not call REA.

**Forbidden Actions**
- Do not watch the home directory, a drive root, or any folder the user did not add; the only default is `~/Lectern/Inbox`, created on first run.
- Do not delete, move, rename, or modify files in a watched folder.
- Do not follow symbolic links out of a watched folder or descend more than 3 levels.
- Do not import files larger than 100 MB, hidden files, or partial downloads (`.crdownload`, `.part`, `.tmp`, names starting with `~$` or `.`).
- Do not add cloud-drive, network-share credential, or sync-service integrations.

**Required File Outputs**
- `apps/desktop/src/main/watcher/watch-model.ts` — pure: `isImportable(path, sizeBytes)`, `fileKey(path, size, mtimeMs)`, `shouldProcess(key, processed)`, `mimeForExtension(ext)`.
- `apps/desktop/src/main/watcher/file-watcher.ts` — watches `settings.watchFolders` with chokidar (waits for writes to finish, depth 3, no symlink following); processes files one at a time; sends an import request `{ files, play: false, folderName: 'Inbox' }`; records processed keys in `settings.processedFiles` (keeps the newest 5 000); reacts to settings changes by adding and removing watchers; publishes per-folder state in `DesktopStatus`; registered in `features.ts`.
- `apps/web/src/desktop/WatchFoldersSection.tsx` — settings section (bridge only): lists folders with state, adds one through `settings.pickFolder()`, removes one; registered in `sections.ts`.
- `apps/desktop/src/main/watcher/__tests__/watch-model.test.ts` — each accepted extension; each rejected pattern; the size limit; processed-key logic.
- `apps/desktop/e2e/watcher.spec.ts` — with user data pre-seeded to watch a temporary folder: copying `sample.txt` and `text.pdf` into it makes both appear in the library folder `Inbox` within 30 s; copying `sample.txt` again adds nothing; a file named `x.pdf.part` is ignored; after a restart nothing is re-imported; the source files are byte-identical afterwards.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/desktop exec vitest run \
  && pnpm --filter @lectern/web exec vitest run \
  && pnpm --filter @lectern/desktop run typecheck \
  && pnpm --filter @lectern/web run build \
  && pnpm --filter @lectern/desktop run build \
  && xvfb-run -a pnpm --filter @lectern/desktop exec playwright test e2e/watcher.spec.ts
```
Pass: exit code 0.

---

### U-044 — Desktop: packaging for Linux and Windows

**Unit ID & Title:** U-044 — Desktop: packaging for Linux and Windows

**Inputs & Dependencies**
- Depends on: U-042, U-043
- Reads: F§10.3 (packaging), F§11
- Uses: `apps/desktop/package.json` scripts `dist:linux` and `dist:win`, `apps/desktop/resources/`, `apps/desktop/e2e/launch.ts`

**REA Inspection Target & Method**
- Target: `T-WIN` (`targets/desktop-win/`).
- Tools: `open_binary`, `inspect_artifact`, `close_binary`.
- Method: one inventory summary of the package.
- Questions: What packaging format does the reference use? Does the package declare auto-start, protocol handlers, file associations, or background services (declarations only)? These inform the `DESIGN` note that Lectern declares none of them.

**Forbidden Actions**
- Do not configure code signing, notarization, a publish provider, an update feed, or store submission.
- Do not add macOS, Snap, or Flatpak targets.
- Do not register auto-start, file associations, or protocol handlers.
- Do not include `apps/web/src`, source maps, tests, or `targets/` in the package.
- Do not claim Windows artifacts are verified unless the Windows steps were actually run on Windows.

**Required File Outputs**
- `apps/desktop/electron-builder.yml` — `appId: dev.lectern.desktop`, `productName: Lectern`, files `out/**`, extra resources `resources/web`, `resources/overlay`, `resources/icons`; Linux targets `AppImage` and `deb` (category `Utility`, desktop file name matching `desktopName`); Windows target `nsis` (per-user install, no elevation); output directory `dist`; no `publish` entry.
- `apps/desktop/scripts/verify-package.mjs` — checks that `dist/linux-unpacked/` contains the executable, `resources/app.asar`, `resources/web/index.html`, and `resources/overlay/index.html`; that an `.AppImage` and a `.deb` exist in `dist/`; and that no path in the unpacked tree contains `targets`, `.map`, or `__tests__`.
- `apps/desktop/e2e/packaged.spec.ts` — launches `dist/linux-unpacked/` with Playwright `_electron` (`executablePath`); the window title is `Lectern` and the bridge reports `linux`.
- `docs/desktop-windows-build.md` — operator steps for building on Windows (`pnpm install`, `pnpm --filter @lectern/web run build`, `pnpm --filter @lectern/desktop run build`, `pnpm --filter @lectern/desktop run dist:win`) and a manual checklist: install, launch, each default hotkey, read selection from a browser and a text editor with clipboard restored, region OCR, mini-player, watched folder, tray quit.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/web run build \
  && pnpm --filter @lectern/desktop run build \
  && pnpm --filter @lectern/desktop run dist:linux \
  && node apps/desktop/scripts/verify-package.mjs \
  && xvfb-run -a pnpm --filter @lectern/desktop exec playwright test \
  && node scripts/check-forbidden.mjs
```
Pass: exit code 0 for packaging and the full desktop end-to-end suite. Record `windows: unverified` in the status line unless `docs/desktop-windows-build.md` was executed on Windows by the operator.

---

# Phase 4 — Android Mobile App

Phase 4 needs `node scripts/preflight.mjs --phase 4` to pass (JDK 17+, Android SDK, `adb`). Units U-052 and U-053 also need a running emulator or attached device with Google Play services; on a host without one they are `BLOCKED`, never passed.
- Patch scope: apps/desktop/package.json

### U-045 — Android: Expo scaffold, connection settings, diagnostics

**Unit ID & Title:** U-045 — Android: Expo scaffold, connection settings, diagnostics

**Inputs & Dependencies**
- Depends on: U-021
- Reads: F§10.4, F§5.2, F§5.3, F§11
- Uses: `@lectern/core`, `@lectern/api-client`, `packages/fixtures/make-icons.mjs`
- Installs (`apps/android`): `expo` at the ledger version with `pnpm add -E`; then with `npx expo install`: `react`, `react-native`, `expo-router`, `expo-linking`, `expo-constants`, `expo-status-bar`, `react-native-safe-area-context`, `react-native-screens`, `expo-secure-store`, `expo-build-properties`; devDependencies `vitest`, `typescript`, `@types/react`; workspace dependencies `@lectern/core`, `@lectern/core-tts`, `@lectern/api-client`, `@lectern/api-contract`

**REA Inspection Target & Method**
- Target: `T-APK` (`targets/android/base.apk`).
- Tools: `inspect_android_package`, `inspect_apk_signature`, `search_android_classes`.
- Method: one `inspect_android_package` for identity and manifest declarations; one `inspect_apk_signature` summary; up to five `search_android_classes` queries for well-known framework package prefixes (cross-platform runtimes, media libraries). Do not inspect any class or method.
- Questions: What are the minimum and target SDK levels? Which permission categories are declared? Which exported components exist, by category (launcher, share target, deep link, media service)? Which application framework family is indicated by class-name prefixes (`INFERRED`)?

**Forbidden Actions**
- Do not run `create-expo-app` or any template generator; create the listed files by hand.
- Do not create an `ios` directory, an `ios` key in `app.json`, or any iOS-only dependency; `platforms` is exactly `["android"]`.
- Do not commit `apps/android/android/`; it is generated by prebuild.
- Do not hand-edit Gradle files, `AndroidManifest.xml`, or any Java or Kotlin file; native configuration goes through config plugins in `app.json`.
- Do not add Expo Application Services (EAS) configuration, over-the-air updates, push notifications, or any Expo account requirement.
- Do not store the hub token outside `expo-secure-store`.

**Required File Outputs**
- `apps/android/package.json` — name `@lectern/android`; `main: "expo-router/entry"`; scripts `start`, `android` (`expo run:android`), `prebuild` (`expo prebuild --platform android --clean`), `test` (`vitest run`), `typecheck` (`tsc --noEmit`).
- `apps/android/app.json` — `name: "Lectern"`, `slug: "lectern"`, `scheme: "lectern"`, `platforms: ["android"]`, `android.package: "dev.lectern.app"`, `android.blockedPermissions` listing `RECORD_AUDIO`, `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`, and `SYSTEM_ALERT_WINDOW`, icon and adaptive icon paths, plugins `expo-router`, `expo-secure-store`, and `expo-build-properties` with `android.usesCleartextTraffic: true` (the hub is reached over a private network).
- `apps/android/tsconfig.json` — extends `expo/tsconfig.base`, `strict`.
- `apps/android/metro.config.js` — Expo default config; add monorepo settings only if the installed Expo version's documentation requires them.
- `apps/android/vitest.config.ts` — Node environment, includes `src/**/*.test.ts`; excludes anything importing React Native.
- `apps/android/assets/1024.png` — application icon from `make-icons.mjs`.
- `apps/android/assets/432.png` — adaptive-icon foreground from `make-icons.mjs`.
- `apps/android/scripts/check-android-only.mjs` — exits 1 if `apps/android/ios` exists, `app.json` has an `ios` key or `platforms` differs from `["android"]`, `eas.json` exists, or `package.json` lists `expo-updates`, `expo-notifications`, or a package whose name contains `-ios`.
- `apps/android/src/theme.ts` — colour, spacing, and type tokens with the same values as `@lectern/ui-web` styles.
- `apps/android/src/connection.ts` — `getConnection()`, `setConnection({ hubUrl, token })`, `onConnectionChanged(cb)`; token in `expo-secure-store`; `createClient()` returns a hub client using `fetch` from `expo/fetch`.
- `apps/android/src/selftest.ts` — pure `runCoreSelfTest(): { name: string; ok: boolean }[]` asserting the F§5.2 `docId` goldens, the six F§5.3 tokenizer goldens, and the F§5.6 timing and speed goldens.
- `apps/android/src/diagnostics/checks.ts` (registry) — `checks: { id: string; title: string; run(): Promise<{ ok: boolean; detail: string }> }[]`; this unit registers `core-selftest` and `hub-health`.
- `apps/android/app/_layout.tsx` — root stack with safe-area and theme providers.
- `apps/android/app/index.tsx` — redirects to the settings tab.
- `apps/android/app/(tabs)/_layout.tsx` — tab navigator that lists every screen file in the group without per-screen entries; each screen sets its own title and icon.
- `apps/android/app/(tabs)/settings.tsx` — hub URL and token form with a "Test connection" button, playback preferences, and a link to diagnostics.
- `apps/android/app/setup.tsx` — deep link `lectern://setup?hubUrl=…&token=…`: shows the hub URL and a "Connect" button; nothing is saved until the user confirms.
- `apps/android/app/diagnostics.tsx` — runs every registered check; shows one row per check with `testID` and text `PASS <id>` or `FAIL <id>`; `?autorun=1` starts immediately.
- `apps/android/src/__tests__/selftest.test.ts` — every self-test case is `ok` under Node.

**Pass/Fail Verification Test**
```sh
node scripts/preflight.mjs --phase 4 \
  && node packages/fixtures/make-icons.mjs --out apps/android/assets --sizes 432,1024 \
  && pnpm --filter @lectern/android exec vitest run \
  && pnpm --filter @lectern/android run typecheck \
  && node apps/android/scripts/check-android-only.mjs \
  && pnpm --filter @lectern/android exec expo export --platform android --output-dir dist \
  && test -n "$(find apps/android/dist -name '*.hbc' | head -n 1)" \
  && (cd apps/android && npx expo prebuild --platform android --clean --no-install) \
  && (cd apps/android/android && ./gradlew :app:assembleDebug -q) \
  && test ! -e apps/android/ios
```
Pass: exit code 0. The Hermes bundle proves `@lectern/core` resolves and compiles for the device runtime.

---

### U-046 — Android: SQL library store and file blob cache

**Unit ID & Title:** U-046 — Android: SQL library store and file blob cache

**Inputs & Dependencies**
- Depends on: U-014, U-045
- Reads: F§5.9
- Uses: `@lectern/core` (`LibraryStore`, `BlobCache`, `isNewer`), `@lectern/core/testing` (both conformance suites), `apps/android/src/diagnostics/checks.ts`
- Installs: `packages/store-sql` (exact): `zod`, devDependency `better-sqlite3`, workspace dependency `@lectern/core`; `apps/android` with `npx expo install`: `expo-sqlite`, `expo-file-system`, `expo-crypto`; workspace dependency `@lectern/store-sql`

**REA Inspection Target & Method**
- Target: N/A — on-device storage is a Lectern design; reading another application's private data is forbidden. Do not call REA.

**Forbidden Actions**
- Do not import `expo-*`, `react-native`, or `better-sqlite3` from `packages/store-sql/src` outside its `testing` directory; the store talks only to the `SqlDriver` and `BlobFs` interfaces.
- Do not build SQL by string concatenation with values; use parameters.
- Do not store blobs in SQLite; files hold bytes, the database holds metadata.
- Do not use external storage or request storage permissions; use the app's private document directory.

**Required File Outputs**
- `packages/store-sql/package.json` — name `@lectern/store-sql`; exports `"."` and `"./testing"`.
- `packages/store-sql/tsconfig.json` — extends the base config.
- `packages/store-sql/vitest.config.ts` — Node environment.
- `packages/store-sql/src/index.ts` — re-exports.
- `packages/store-sql/src/driver.ts` — `SqlDriver` (`exec(sql)`, `run(sql, params)`, `all<T>(sql, params)`, `transaction<T>(fn)`; all asynchronous) and `BlobFs` (`write(key, bytes)`, `read(key)`, `remove(key)`, `exists(key)`, `uri(key)`).
- `packages/store-sql/src/migrations.ts` — `migrate(driver)`: version table and schema version 1 (`documents`, `models`, `folders`, `bookmarks`, `progress`, `settings`, `outbox`, `meta`, `blob_meta`); idempotent.
- `packages/store-sql/src/sql-library-store.ts` — `createSqlLibraryStore({ driver, deviceId, now, newId }): LibraryStore`; each mutation and its outbox row commit in one transaction.
- `packages/store-sql/src/fs-blob-cache.ts` — `createFsBlobCache({ fs, driver, now }): BlobCache`; metadata (size, MIME type, last access) in `blob_meta`.
- `packages/store-sql/src/testing/index.ts` — re-exports the test doubles.
- `packages/store-sql/src/testing/better-sqlite3-driver.ts` — `SqlDriver` over an in-memory `better-sqlite3` database.
- `packages/store-sql/src/testing/memory-blob-fs.ts` — in-memory `BlobFs`.
- `packages/store-sql/src/__tests__/store-sql.test.ts` — the SQL store and the file blob cache pass their conformance suites with every case `ok`; migrations run twice without error; data survives re-creating the store on the same database.
- `apps/android/src/stores/expo-sqlite-driver.ts` — `SqlDriver` over the `expo-sqlite` asynchronous API.
- `apps/android/src/stores/expo-blob-fs.ts` — `BlobFs` over `expo-file-system` in the document directory under `blobs/`; keys are mapped to safe file names.
- `apps/android/src/stores/index.ts` — `getStores(): Promise<{ store, cache, deviceId }>`; opens `lectern.db`, migrates, creates a device ID once with `expo-crypto`.
- `apps/android/src/stores/diagnostics.ts` — registers checks `library-store` and `blob-cache`, which run the conformance suites on-device against a scratch database and directory and delete them afterwards.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/store-sql exec vitest run \
  && pnpm --filter @lectern/store-sql run typecheck \
  && pnpm --filter @lectern/android exec vitest run \
  && pnpm --filter @lectern/android run typecheck \
  && node apps/android/scripts/check-android-only.mjs \
  && pnpm --filter @lectern/android exec expo export --platform android --output-dir dist \
  && test -n "$(find apps/android/dist -name '*.hbc' | head -n 1)"
```
Pass: exit code 0. On-device conformance runs in U-052.

---

### U-047 — Android: playlist audio sink and background playback

**Unit ID & Title:** U-047 — Android: playlist audio sink and background playback

**Inputs & Dependencies**
- Depends on: U-046
- Reads: F§5.8, F§5.6 (e), F§10.4 (playback)
- Uses: `@lectern/core` (`AudioQueueSink`), `@lectern/core/testing` (`runAudioQueueSinkConformance`), `@lectern/core-tts` (`createMockEngine`), `apps/android/src/stores/index.ts`, `apps/android/src/diagnostics/checks.ts`
- Installs (`apps/android`, with `npx expo install`): `expo-audio`
- Patch scope: `apps/android/app.json`
- Patch notes: add the `expo-audio` plugin entry with background playback enabled and background recording disabled; add nothing else.

**REA Inspection Target & Method**
- Target: `T-APK` (`targets/android/base.apk`).
- Tools: `inspect_android_package`, `search_android_classes`.
- Method: one `inspect_android_package`; read the service and permission declarations. Up to three `search_android_classes` queries for media-session and player library package prefixes. Do not inspect any class or method.
- Questions: Which foreground-service types are declared? Is a media-session or media-browser service declared? Which media-playback library family is indicated by class-name prefixes (`INFERRED`)? Is a notification permission declared?

**Forbidden Actions**
- Do not use `expo-av`, `react-native-track-player`, `@rntp/player`, `react-native-sound`, or `expo-speech`.
- Do not request the microphone permission or enable background recording.
- Do not drive sentence-to-sentence advance from JavaScript timers; enqueue ahead into the native playlist.
- Do not start playback without a user action in the app (Android background-audio rules).
- Do not write a config plugin or native module.

**Required File Outputs**
- `apps/android/src/audio/queue-map.ts` — pure bookkeeping between playlist indexes and chunk IDs: `append(chunkId)`, `onTrackChanged(previousIndex, currentIndex)` → events to emit, `reset()`, `currentChunk()`.
- `apps/android/src/audio/expo-queue-sink.ts` — `createExpoQueueSink({ maxRate }): AudioQueueSink` over an `expo-audio` `AudioPlaylist`: `enqueue` adds a source; track-change and finish events become `chunk-end`, `chunk-start`, and `queue-empty`; `clear` empties the playlist; `setRate` sets the playlist rate with pitch correction left on; `current()` reads the playlist position. Default `maxRate` is 2.0, read from the setting `sinkMaxRate`.
- `apps/android/src/audio/audio-session.ts` — `configureAudioSession()` (background playback, do-not-mix interruption mode) and `setNowPlaying(sink, { title, subtitle })` enabling lock-screen controls with previous and next enabled and seek controls disabled; `clearNowPlaying()`.
- `apps/android/src/audio/diagnostics.ts` — registers the check `audio-sink`: writes mock-engine WAV chunks to the blob cache, runs `runAudioQueueSinkConformance` against the real sink, and reports the accepted rate at 2.0.
- `apps/android/src/audio/__tests__/queue-map.test.ts` — sequential advance, skip ahead, reset, and the final-track finish event.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/android exec vitest run \
  && pnpm --filter @lectern/android run typecheck \
  && node apps/android/scripts/check-android-only.mjs \
  && pnpm --filter @lectern/android exec expo export --platform android --output-dir dist \
  && (cd apps/android && npx expo prebuild --platform android --clean --no-install) \
  && grep -q "FOREGROUND_SERVICE_MEDIA_PLAYBACK" apps/android/android/app/src/main/AndroidManifest.xml \
  && ! grep -q "RECORD_AUDIO" apps/android/android/app/src/main/AndroidManifest.xml \
  && (cd apps/android/android && ./gradlew :app:assembleDebug -q)
```
Pass: exit code 0. Record the `AudioPlaylist` members used, copied from the installed `.d.ts`, in the evidence file. On-device conformance runs in U-052.

---

### U-048 — Android: reader screen and player UI

**Unit ID & Title:** U-048 — Android: reader screen and player UI

**Inputs & Dependencies**
- Depends on: U-047
- Reads: F§5.7, F§5.6 (c), (d), (f), F§10.4 (reader UI)
- Uses: `@lectern/core` (`createPlayerController`, `playableSentences`, `planSpeed`), `@lectern/api-client` (`createCachingChunkSource`), `apps/android/src/audio/expo-queue-sink.ts`, `apps/android/src/audio/audio-session.ts`, `apps/android/src/stores/index.ts`, `apps/android/src/connection.ts`, `apps/android/src/theme.ts`

**REA Inspection Target & Method**
- Target: `T-SHOTS` (`targets/shots/android/`), operator screenshots of the reference app's reading screen, speed control, and voice list.
- Tools: none; view the images directly.
- Method: examine each image.
- Questions: Where are the playback controls placed, and which controls are present? How is the active sentence or word marked (relative description)? How are speed and voice chosen (sheet, full screen, inline)? Is progress shown as time, percentage, or both?

**Forbidden Actions**
- Do not render every word as its own pressable element for the whole document; only the active block is split into highlight segments.
- Do not update highlight state more often than 20 times per second.
- Do not use a WebView, a UI kit, an icon font package, or animation libraries beyond React Native's built-ins.
- Do not copy the reference app's layout; choose a different control arrangement and record it as `DESIGN`.
- Do not add `Platform.OS` branches.

**Required File Outputs**
- `apps/android/src/reader/highlight-model.ts` — pure `segmentsForBlock(block, active): { text: string; role: 'plain' | 'sentence' | 'word' }[]` and `blockIndexForSentence(doc, sentenceIndex)`.
- `apps/android/src/player/player-context.tsx` — provider building the controller (sink, caching chunk source over the hub client and blob cache, store-backed document provider); exposes snapshot, `dispatch`, voices, progress; persists progress at most every 2 s and on pause; keeps lock-screen metadata current; `lookaheadMs` defaults to 80.
- `apps/android/src/player/use-active-word.ts` — active position sampled at most every 50 ms while playing.
- `apps/android/src/reader/BlockList.tsx` — virtualized list of blocks; the active block uses `segmentsForBlock`; tapping a sentence seeks to it; follows the active block unless the user scrolled in the last 4 s; skipped blocks dimmed.
- `apps/android/src/reader/PlayerBarNative.tsx` — play/pause, previous and next sentence, speed, voice, sleep timer, progress, and time remaining; a spinner while `loading` or `buffering`; the error message with a retry button.
- `apps/android/src/reader/SpeedSheet.tsx` — 0.5×–5.0× in 0.05 steps with the presets from `RATE_PRESETS`.
- `apps/android/src/reader/VoiceSheet.tsx` — voices grouped by language with a text filter.
- `apps/android/app/read/[docId].tsx` — reader screen; `?autoplay=1` starts playback after load; a not-found state.
- `apps/android/src/reader/__tests__/highlight-model.test.ts` — segments concatenate to the block text for every position; the word segment equals the active word; blocks without the active sentence are one plain segment.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/android exec vitest run \
  && pnpm --filter @lectern/android run typecheck \
  && node apps/android/scripts/check-android-only.mjs \
  && pnpm --filter @lectern/android exec expo export --platform android --output-dir dist \
  && test -n "$(find apps/android/dist -name '*.hbc' | head -n 1)" \
  && node scripts/check-forbidden.mjs
```
Pass: exit code 0. On-device playback is verified in U-052.

---

### U-049 — Android: library and import

**Unit ID & Title:** U-049 — Android: library and import

**Inputs & Dependencies**
- Depends on: U-048
- Reads: F§10.4 (import), F§5.9, F§7.2 (`POST /v1/parse`)
- Uses: `@lectern/core` (`buildDocument`, `parseText`, `buildFolderTree`, `filterDocuments`, `sortDocuments`), `apps/android/src/stores/index.ts`, `apps/android/src/connection.ts`
- Installs (`apps/android`, with `npx expo install`): `expo-document-picker`, `expo-clipboard`
- Patch scope: `apps/android/app/index.tsx`
- Patch notes: redirect to the library tab when a hub connection is saved, otherwise to the settings tab.

**REA Inspection Target & Method**
- Target: `T-SHOTS` (`targets/shots/android/`), operator screenshots of the reference app's library and its add or import screen.
- Tools: none; view the images directly.
- Method: examine each image.
- Questions: Which fields does a library row show? Which import sources are offered (ignore cloud-drive and account-linked sources)? How are folders presented?

**Forbidden Actions**
- Do not add cloud-drive pickers, account linking, or a built-in web browser.
- Do not parse PDF, EPUB, DOCX, or HTML on the device; send them to the hub. Plain text is built locally so it works offline.
- Do not request broad storage permissions; use the system document picker.
- Do not block the UI thread while uploading; show progress and allow cancel.

**Required File Outputs**
- `apps/android/src/import/import-service.ts` — `importPickedFile({ uri, name, mime })` (reads bytes, calls the hub, stores the document), `importUrl(url)`, `importTextLocal(text, title?)` (`parseText` → `buildDocument`, no network), `importDocumentModel(model, sourceUri?)`; duplicates by `docId` are not re-added; every function returns `{ docId, duplicate }`.
- `apps/android/src/import/classify-input.ts` — pure `classifyPastedInput(s): { kind: 'url'; url } | { kind: 'text'; text }` (a single `http(s)` URL with no other text is a URL).
- `apps/android/app/import.tsx` — "Choose file" (document picker limited to the supported types), "Paste" (clipboard → URL or text), a text box, and per-item progress and errors.
- `apps/android/app/(tabs)/library.tsx` — library tab: folder chips, document rows (title, progress percentage, length), search, sort, long-press actions (move, delete), an empty state, and an import button.
- `apps/android/src/import/__tests__/classify-input.test.ts` — URL only, URL with surrounding whitespace, URL inside prose (text), plain text, empty input.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/android exec vitest run \
  && pnpm --filter @lectern/android run typecheck \
  && node apps/android/scripts/check-android-only.mjs \
  && pnpm --filter @lectern/android exec expo export --platform android --output-dir dist \
  && test -n "$(find apps/android/dist -name '*.hbc' | head -n 1)"
```
Pass: exit code 0.

---

### U-050 — Android: Share-sheet intent ingestion

**Unit ID & Title:** U-050 — Android: Share-sheet intent ingestion

**Inputs & Dependencies**
- Depends on: U-049
- Reads: F§10.4 (share sheet)
- Uses: `apps/android/src/import/import-service.ts`, `apps/android/src/import/classify-input.ts`
- Installs (`apps/android`, with `npx expo install`): `expo-sharing`
- Patch scope: `apps/android/app.json`
- Patch notes: add the `expo-sharing` plugin entry with Android share receiving enabled, single-share MIME types `text/plain`, `application/pdf`, `application/epub+zip`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `image/*`, and multiple-share MIME type `image/*`. Do not add an iOS block.

**REA Inspection Target & Method**
- Target: `T-APK` (`targets/android/base.apk`).
- Tools: `inspect_android_package`.
- Method: one `inspect_android_package`; read intent-filter declarations of exported activities only.
- Questions: Which activities accept single and multiple share actions, and for which MIME-type categories (text, PDF, images, other)? Is sharing handled by the main activity or a separate one? Are view actions declared for web links or document types?

**Forbidden Actions**
- Do not hand-write intent filters or edit `AndroidManifest.xml`; use the `expo-sharing` config plugin.
- Do not use `expo-share-intent`, `react-native-receive-sharing-intent`, or a custom native module.
- Do not accept audio or video shares.
- Do not import a shared item without showing the user what will be imported; the handler screen lists items and imports on confirmation (text and single URLs may import immediately).
- Do not keep copies of shared files after import; clear the shared payloads.

**Required File Outputs**
- `apps/android/src/share/route-share.ts` — pure `planShare(payloads): ShareAction[]` over the resolved share payload type from the installed `expo-sharing` typings: text → `{ kind: 'text' }` or `{ kind: 'url' }` through `classifyPastedInput`; website → `url`; file with a supported MIME type or extension → `file`; one or more images → a single `{ kind: 'images', uris }` in the shared order; anything else → `{ kind: 'unsupported', reason }`.
- `apps/android/app/+native-intent.ts` — redirects system paths whose host is the `expo-sharing` host to `/handle-share`; passes every other path through.
- `apps/android/app/handle-share.tsx` — reads incoming payloads with the hook from `expo-sharing`; shows a spinner while resolving; lists planned actions; runs them through `import-service` (images go to the hub's OCR parse until U-051 replaces that path); opens the reader for a single result or the library for several; shows unsupported items with their reason.
- `apps/android/src/share/__tests__/route-share.test.ts` — plain text, a lone URL, a PDF file, three images in order, a mixed share, and an unsupported audio item.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/android exec vitest run \
  && pnpm --filter @lectern/android run typecheck \
  && node apps/android/scripts/check-android-only.mjs \
  && pnpm --filter @lectern/android exec expo export --platform android --output-dir dist \
  && (cd apps/android && npx expo prebuild --platform android --clean --no-install) \
  && grep -q "android.intent.action.SEND" apps/android/android/app/src/main/AndroidManifest.xml \
  && grep -q "android.intent.action.SEND_MULTIPLE" apps/android/android/app/src/main/AndroidManifest.xml \
  && grep -q "application/pdf" apps/android/android/app/src/main/AndroidManifest.xml \
  && (cd apps/android/android && ./gradlew :app:assembleDebug -q)
```
Pass: exit code 0. The live share flow is verified on a device in U-052.

---

### U-051 — Android: multi-page camera scanner with on-device OCR

**Unit ID & Title:** U-051 — Android: multi-page camera scanner with on-device OCR

**Inputs & Dependencies**
- Depends on: U-050
- Reads: F§10.4 (camera scanner), F§5.5
- Uses: `@lectern/core` (`groupOcrLines`, `buildDocument`, `RawBlock`), `apps/android/src/import/import-service.ts` (`importDocumentModel`)
- Installs (`apps/android`): `react-native-document-scanner-plugin` and `@react-native-ml-kit/text-recognition` at the ledger versions with `pnpm add -E`; `expo-image-picker` with `npx expo install`
- Patch scope: `apps/android/app.json`, `apps/android/app/handle-share.tsx`
- Patch notes: `app.json` gains the camera permission configuration required by the installed scanner and image-picker packages (camera only; no microphone, no media-library write). `handle-share.tsx` routes `images` actions to the on-device OCR path instead of the hub.

**REA Inspection Target & Method**
- Target: `T-APK` (`targets/android/base.apk`).
- Tools: `inspect_android_package`, `search_android_classes`.
- Method: one `inspect_android_package` for camera-related permissions and features; up to four `search_android_classes` queries for document-scanner and text-recognition library package prefixes. Do not inspect any class or method.
- Questions: Is the camera permission declared, and is the camera feature marked required? Which scanning and text-recognition library families are indicated by class-name prefixes (`INFERRED`)? Is there evidence for on-device recognition versus none (`UNKNOWN` if absent)?

**Forbidden Actions**
- Do not send scanned images to the hub or anywhere else; recognition is on-device.
- Do not use `expo-camera` frame processing, `react-native-vision-camera`, OpenCV, or tesseract on the device.
- Do not save scans to the photo gallery or request media-library permissions.
- Do not keep page images after the document is saved; delete the temporary files.
- If `react-native-document-scanner-plugin` fails to compile in this unit's Gradle build, stop and write `BLOCKED` naming the compiler error; do not swap libraries without a patched contract.

**Required File Outputs**
- `apps/android/src/scan/mlkit-lines.ts` — pure `linesFromRecognition(result, pageHeight): { text, bbox, confidence }[]` mapping the text-recognition result's lines and frames to the `OcrEngine` line shape (confidence 100 when the library reports none).
- `apps/android/src/scan/assemble.ts` — pure `assembleScan(pages: RawBlock[][], now: Date): DocumentModel` using `buildDocument` with `source.kind = 'ocr'`, 1-based page numbers, and the title `Scan YYYY-MM-DD HH:mm` unless the first block is a short heading.
- `apps/android/src/scan/scan-service.ts` — `scanPages(): Promise<string[]>` (document scanner, up to 20 pages; if the scanner is unavailable, repeated single captures with `expo-image-picker` until the user finishes), `recognizePages(uris)` (text recognition per page → `linesFromRecognition` → `groupOcrLines`), `saveScan(pages)` (`assembleScan` → `importDocumentModel` → delete temporary images).
- `apps/android/app/(tabs)/scan.tsx` — scan tab: start scan, per-page recognition progress, page count and text preview, "Add pages", "Save and listen", and a clear message when no text was found.
- `apps/android/src/scan/__tests__/scan.test.ts` — line mapping from a recorded recognition result fixture (hand-written JSON in the test); page order and page numbers in the assembled document; title rule; an all-empty scan yields no document.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/android exec vitest run \
  && pnpm --filter @lectern/android run typecheck \
  && node apps/android/scripts/check-android-only.mjs \
  && pnpm --filter @lectern/android exec expo export --platform android --output-dir dist \
  && (cd apps/android && npx expo prebuild --platform android --clean --no-install) \
  && grep -q "android.permission.CAMERA" apps/android/android/app/src/main/AndroidManifest.xml \
  && ! grep -q "RECORD_AUDIO" apps/android/android/app/src/main/AndroidManifest.xml \
  && (cd apps/android/android && ./gradlew :app:assembleDebug -q)
```
Pass: exit code 0. Camera capture itself needs a physical page and is a manual check listed in U-053's report.

---

### U-052 — Android: device verification of playback, lock-screen controls, and share intents

**Unit ID & Title:** U-052 — Android: device verification of playback, lock-screen controls, and share intents

**Inputs & Dependencies**
- Depends on: U-051
- Reads: F§10.4, F§14 (Android rows)
- Uses: `apps/android/app/diagnostics.tsx`, `apps/android/app/setup.tsx`, `apps/android/app/read/[docId].tsx`, `apps/android/app/handle-share.tsx`, `@lectern/server` (run with the mock engine), `adb`, a running emulator or attached device

**REA Inspection Target & Method**
- Target: `T-SHOTS` (`targets/shots/android/`), operator screenshots of the reference app's lock-screen and notification media controls.
- Tools: none; view the images directly.
- Method: examine each image.
- Questions: Which transport controls appear on the lock screen and in the notification (play/pause, previous/next, seek)? Which metadata is shown (title, source, artwork)?

**Forbidden Actions**
- Do not change application source in this unit; it adds scripts only. A failing check is reported as `BLOCKED` with the script output, to be fixed by a patched contract.
- Do not use a UI-automation framework (no Appium, Maestro, or Detox); use `adb` and `uiautomator dump`.
- Do not disable the lock screen, battery optimization, or any system protection to make a check pass.
- Do not leave the hub process, port forwards, or the emulator's network state changed after the scripts exit.

**Required File Outputs**
- `apps/android/scripts/device/lib.sh` — POSIX functions: `require_device`, `build_release_apk` (prebuild and `./gradlew :app:assembleRelease`), `install_apk`, `start_hub` (mock engine on port 8787 with a fixed test token; `adb reverse tcp:8787 tcp:8787`), `stop_hub`, `open_link <url>`, `ui_dump`, `ui_has_text <text>`, `tap_text <text>`, `wait_for_text <text> <seconds>`, `media_state` (parses `dumpsys media_session` for package `dev.lectern.app`; prints `playing`, `paused`, or `none`; accepts both the numeric and the named state formats), `media_dispatch <play|pause|next|previous>` (uses `cmd media_session dispatch`, falling back to `media dispatch`).
- `apps/android/scripts/device/verify-diagnostics.sh` — provisions the connection through `lectern://setup` and the Connect button; opens `lectern://diagnostics?autorun=1`; waits up to 180 s; passes only if `PASS core-selftest`, `PASS hub-health`, `PASS library-store`, `PASS blob-cache`, and `PASS audio-sink` are all present and no `FAIL` text exists.
- `apps/android/scripts/device/verify-share-intent.sh` — sends `am start -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT "<12 sentences>"` to the package; passes when the reader opens with the first words of the text visible.
- `apps/android/scripts/device/verify-media-session.sh` — with the shared document open, taps play; requires `playing` within 20 s; sends the app to the background with the Home key and requires `playing` after 30 s; `media_dispatch pause` → `paused`; `media_dispatch play` → `playing`; `media_dispatch next` keeps `playing`; turns the screen off with the Sleep key and requires `playing` after 20 s; wakes the device and requires that the visible sentence has advanced.
- `apps/android/scripts/device/run-all.sh` — `build_release_apk`, `install_apk`, `start_hub`, runs the three verify scripts in order, always runs `stop_hub` and removes the port reverse, and exits non-zero if any script failed.

**Pass/Fail Verification Test**
```sh
node scripts/preflight.mjs --phase 4 \
  && adb get-state | grep -q device \
  && sh apps/android/scripts/device/run-all.sh
```
Pass: exit code 0 with the full output pasted into the evidence file. No device or emulator means `BLOCKED`.

---

### U-053 — Android: offline download and release APK audit

**Unit ID & Title:** U-053 — Android: offline download and release APK audit

**Inputs & Dependencies**
- Depends on: U-052
- Reads: F§10.4, F§4 (listen offline), F§11
- Uses: `@lectern/api-client` (`prefetchDocument`, `isCached`), `apps/android/src/stores/index.ts`, `apps/android/src/player/player-context.tsx`, `apps/android/scripts/device/lib.sh`
- Patch scope: `apps/android/app/(tabs)/library.tsx`
- Patch notes: add the offline button and state to each library row; change nothing else.

**REA Inspection Target & Method**
- Target: `T-APK` (`targets/android/base.apk`).
- Tools: `inspect_android_package`.
- Method: one `inspect_android_package`; list every declared permission by category.
- Questions: Which permission categories does the reference declare (network, media playback, camera, microphone, notifications, storage, billing, advertising identifier, location, contacts)? This list is compared with Lectern's minimal set in the evidence file as a `DESIGN` note.

**Forbidden Actions**
- Do not add background download services, work managers, or boot receivers; downloads run while the app is open.
- Do not sign with a production key, create a keystore, or produce a store bundle (AAB); the release build uses the default debug keystore for sideloading.
- Do not add permissions to make a check pass; the allowlist below is fixed.
- Do not evict pinned audio.

**Required File Outputs**
- `apps/android/src/offline/offline-service.ts` — `downloadForOffline(docId, onProgress, signal)`, `removeOffline(docId)`, `offlineState(docId)`, `pinnedPredicate()`, `enforceCacheLimit()`; pins kept as settings `offline:<docId>` (same semantics as the web app, F§10.1).
- `apps/android/src/offline/OfflineButton.tsx` — download, progress with cancel, complete, and remove states.
- `apps/android/src/offline/__tests__/offline-service.test.ts` — with memory stores and a fake chunk source: completes and pins; cancel leaves a `partial` state; remove unpins; eviction spares pinned blobs.
- `apps/android/scripts/audit-apk.mjs` — reads the release APK's manifest with the SDK's `aapt2 dump badging` (or `apkanalyzer manifest permissions`); passes only if the package is `dev.lectern.app` and every `uses-permission` is in the allowlist `INTERNET`, `ACCESS_NETWORK_STATE`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, `POST_NOTIFICATIONS`, `WAKE_LOCK`, `CAMERA`, `VIBRATE`, plus the app's own signature-level permissions; fails on any other permission, and specifically on `RECORD_AUDIO`, billing, advertising-identifier, location, contacts, and external-storage permissions.
- `apps/android/scripts/device/verify-offline.sh` — downloads the document created by the share-intent check for offline use and waits for the complete state; enables airplane mode (`cmd connectivity airplane-mode enable`) and stops the hub; force-stops and reopens the app; plays the document and requires `playing` for 20 s with the visible sentence advancing; always disables airplane mode on exit.
- `docs/android-manual-checks.md` — manual checklist with expected results: scan a 3-page printed document and listen; share a web page from the browser; share a PDF from a file manager; lock-screen controls on a physical device; headset button play/pause; an incoming call pauses playback; playback at 4.5×.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/android exec vitest run \
  && pnpm --filter @lectern/android run typecheck \
  && node apps/android/scripts/check-android-only.mjs \
  && (cd apps/android && npx expo prebuild --platform android --clean --no-install) \
  && (cd apps/android/android && ./gradlew :app:assembleRelease -q) \
  && node apps/android/scripts/audit-apk.mjs apps/android/android/app/build/outputs/apk/release/app-release.apk \
  && adb get-state | grep -q device \
  && sh apps/android/scripts/device/run-all.sh \
  && sh apps/android/scripts/device/verify-offline.sh \
  && node scripts/check-forbidden.mjs
```
Pass: exit code 0. If the build declares a permission outside the allowlist, the unit is `BLOCKED` with the permission named; the allowlist is changed only by a patched contract.

---

# Phase 5 — Self-Hosted Personal Sync & AI Summaries

### U-054 — api-contract: library, sync, and AI route schemas

**Unit ID & Title:** U-054 — api-contract: library, sync, and AI route schemas

**Inputs & Dependencies**
- Depends on: U-018
- Reads: F§7.2 (phase 5 routes), F§8, F§9
- Uses: `@lectern/core` (`OpSchema`, record schemas, `DocumentModelSchema`), `packages/api-contract/src/common.ts`

**REA Inspection Target & Method**
- Target: N/A — the sync and AI protocols are Lectern designs. Inspecting the reference product's network protocol is forbidden. Do not call REA.

**Forbidden Actions**
- Do not add user, account, device-registration, or permission fields; `deviceId` is an opaque client-generated string.
- Do not put the token in any schema.
- Do not add CRDT, vector-clock, or operational-transform structures; sync is record-level LWW (F§5.9).
- Do not define chat, quiz, translation, or voice-cloning routes.

**Required File Outputs**
- `packages/api-contract/src/sync-api.ts` — `PushRequestSchema` (`{ deviceId, ops }`, 1–200 ops), `PushResponseSchema` (`{ accepted: string[], rev }`), `PullQuerySchema` (`since` ≥ 0, `limit` 1–500 default 500), `PullResponseSchema` (`{ changes: Op[], nextRev, more }`), `WsClientMessageSchema` (`auth`, `pong`), `WsServerMessageSchema` (`ready`, `changed`, `ping`), `SyncErrorCode` (`MODEL_MISSING`, `TOO_MANY_OPS`).
- `packages/api-contract/src/library-api.ts` — `DocIdParamSchema` (32 lowercase hex characters) and size limits for model and original uploads.
- `packages/api-contract/src/ai-api.ts` — `SummaryModeSchema` (`brief | detailed`), `SummaryRequestSchema` (`{ docId, mode, document? }`), `SummaryResultSchema` (`{ summary, keyTakeaways, model, promptVersion, createdAt }`; brief: summary ≤ 1 200 characters and 3–6 takeaways; detailed: ≤ 4 000 characters and 6–12 takeaways), `SummaryStatusSchema` (`{ status: 'none' | 'running' | 'done' | 'error', result?, error? }`), `AiErrorCode` (`AI_DISABLED`, `LLM_UNAVAILABLE`, `LLM_INVALID_OUTPUT`, `INTERRUPTED`, `MODEL_MISSING`).
- `packages/api-contract/src/__tests__/phase5-api.test.ts` — one valid and two invalid examples per schema; 201 ops rejected; a brief result with 7 takeaways rejected.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/api-contract exec vitest run \
  && pnpm --filter @lectern/api-contract run typecheck
```
Pass: exit code 0, including the unchanged U-018 tests.

---

### U-055 — Hub: SQLite database, migrations, record repository, document files

**Unit ID & Title:** U-055 — Hub: SQLite database, migrations, record repository, document files

**Inputs & Dependencies**
- Depends on: U-054, U-020
- Reads: F§8.1, F§8.2, F§8.4, F§5.9 (LWW rule)
- Uses: `@lectern/core` (`isNewer`, `OpSchema`), `apps/server/src/context.ts`, `apps/server/src/app.ts`
- Installs (`apps/server`, exact): `better-sqlite3`; devDependency `@types/better-sqlite3`
- Patch scope: `apps/server/src/context.ts`, `apps/server/src/app.ts`
- Patch notes: add `db`, `records`, and `files` members to the context; open the database and run migrations when the app is built; close the database in the app's close hook. Change nothing else.

**REA Inspection Target & Method**
- Target: N/A — hub storage is a Lectern design. Do not call REA.

**Forbidden Actions**
- Do not add an ORM, a query builder, a separate database server, or a second database file.
- Do not add tables or columns for users, accounts, devices-as-identities, sessions, or permissions.
- Do not build SQL by concatenating values; use prepared statements.
- Do not store document models or originals inside SQLite; they are files (F§8.4).
- Do not edit an applied migration; add a new numbered one.

**Required File Outputs**
- `apps/server/src/db/database.ts` — `openDatabase(dataDir)`: `{DATA_DIR}/lectern.db`, WAL mode, foreign keys on, 5-second busy timeout.
- `apps/server/src/db/migrations.ts` — numbered migrations creating the F§8.4 tables; `migrate(db)` is idempotent and transactional.
- `apps/server/src/db/records-repo.ts` — `applyOps(deviceId, ops): { accepted: string[]; rev: number }` in one transaction (idempotent by `opId`; LWW per `(entity, entityId)`; winners update `records` and append to `changes`); `changesSince(rev, limit): { changes: Op[]; nextRev: number; more: boolean }` (one entry per changed entity, the current winning record, ordered by its latest `rev`); `currentRev()`; `onChange(cb)` called after a commit that increased `rev`.
- `apps/server/src/db/document-files.ts` — `putModel(docId, gzipBytes)`, `getModel(docId)`, `putOriginal(docId, bytes, mime)`, `getOriginal(docId)`, `hasModel(docId)`, `removeDocument(docId)`; atomic writes under `{DATA_DIR}/library/{docId}/`; `docId` validated before any path is built.
- `apps/server/src/db/__tests__/records-repo.test.ts` — migrations run twice; the same `opId` twice changes nothing and is accepted both times; newer wins, older loses but is accepted, a tie breaks by `deviceId`; tombstones follow LWW; `rev` is strictly increasing; `changesSince` pages with `more` and returns an entity changed three times once; `onChange` fires once per committing batch and not for a batch with no winners.
- `apps/server/src/db/__tests__/document-files.test.ts` — round trips; overwrite; `removeDocument`; a `docId` that is not 32 hex characters is rejected before touching the file system.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/server exec vitest run \
  && pnpm --filter @lectern/server run typecheck
```
Pass: exit code 0, including all Phase 1 hub tests.

---

### U-056 — Hub: library document routes and sync push/pull

**Unit ID & Title:** U-056 — Hub: library document routes and sync push/pull

**Inputs & Dependencies**
- Depends on: U-055
- Reads: F§7.2 (phase 5 routes), F§8.2
- Uses: `apps/server/src/routes/index.ts`, `apps/server/src/db/records-repo.ts`, `apps/server/src/db/document-files.ts`, `@lectern/api-contract` (U-054 schemas), `@lectern/core` (`createMemoryLibraryStore`)

**REA Inspection Target & Method**
- Target: N/A — Lectern hub routes. Do not call REA.

**Forbidden Actions**
- Do not accept a model upload whose decompressed `docId` differs from the URL parameter.
- Do not accept unbounded bodies; enforce the size limits from `library-api.ts` while streaming.
- Do not add listing, search, or admin routes for library content; clients learn of documents only through sync.
- Do not delete files on a tombstone op in the request path; removal happens after the transaction commits and only when the delete won LWW.

**Required File Outputs**
- `apps/server/src/routes/library.ts` — `PUT` and `GET /v1/library/documents/:docId/model` (gzip body, validated against `DocumentModelSchema`), `PUT` and `GET /v1/library/documents/:docId/original`; 404 `NOT_FOUND` for missing files; 413 for oversize; registered in the route registry.
- `apps/server/src/routes/sync.ts` — `POST /v1/sync/push` and `GET /v1/sync/pull`; a winning `document` put whose model is absent is still stored (the model may arrive later); a winning `document` delete removes the document's files; registered in the route registry.
- `apps/server/src/__tests__/sync-routes.test.ts` — model and original round trips; a mismatched `docId` returns 400; push then pull returns the change; pulling with the returned `nextRev` returns nothing; pagination with `more`; 201 ops return 400 `TOO_MANY_OPS`; a document delete removes its files; **convergence**: two `MemoryLibraryStore`s with different device IDs each make conflicting and non-conflicting edits to documents, folders, bookmarks, progress, and settings, run push-then-pull rounds through the routes until both outboxes are empty, and end with identical record sets that satisfy the LWW rule.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/server exec vitest run \
  && pnpm --filter @lectern/server run typecheck
```
Pass: exit code 0.

---

### U-057 — Hub: WebSocket change feed

**Unit ID & Title:** U-057 — Hub: WebSocket change feed

**Inputs & Dependencies**
- Depends on: U-056
- Reads: F§8.3
- Uses: `apps/server/src/routes/index.ts`, `apps/server/src/db/records-repo.ts` (`onChange`, `currentRev`), `@lectern/api-contract` (WebSocket message schemas)
- Installs (`apps/server`, exact): `@fastify/websocket`
- Patch scope: `apps/server/src/app.ts`, `apps/server/src/auth.ts`, `apps/server/src/config.ts`
- Patch notes: register the WebSocket plugin in the app; exempt only the path `/v1/sync/ws` from header authentication (it authenticates by first message); add the optional settings `wsAuthTimeoutMs` (default 5000) and `wsPingIntervalMs` (default 30000) to the config.

**REA Inspection Target & Method**
- Target: N/A — Lectern hub protocol. Do not call REA.

**Forbidden Actions**
- Do not send record data, document text, or tokens over the socket; it carries only `ready`, `changed`, and `ping`.
- Do not accept the token in the URL, a cookie, or a subprotocol header.
- Do not keep a socket open that has not authenticated within the timeout or that has missed two pings.
- Do not use socket.io or any library beyond `@fastify/websocket`.

**Required File Outputs**
- `apps/server/src/routes/sync-ws.ts` — `GET /v1/sync/ws` implementing F§8.3: first-message authentication with a constant-time comparison, close code 4401 on failure or timeout, `ready` with the current `rev`, `changed` on every `onChange`, periodic `ping`, close after two unanswered pings, all sockets closed on app shutdown; registered in the route registry.
- `apps/server/src/__tests__/sync-ws.test.ts` — the app listens on an ephemeral port and tests use Node's built-in `WebSocket` client: a correct token receives `ready` with the current `rev`; a wrong token is closed with 4401; no message within a 200 ms test timeout is closed with 4401; a push through HTTP produces `changed` with the new `rev` on two connected sockets; a socket that never answers pings (20 ms test interval) is closed; an HTTP request to the path without an upgrade returns 400 or 426.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/server exec vitest run \
  && pnpm --filter @lectern/server run typecheck
```
Pass: exit code 0, including the unchanged authentication tests from U-019.

---

### U-058 — api-client: sync client and SyncEngine

**Unit ID & Title:** U-058 — api-client: sync client and SyncEngine

**Inputs & Dependencies**
- Depends on: U-057, U-021
- Reads: F§8.2, F§8.3, F§5.9
- Uses: `@lectern/core` (`LibraryStore`, `Clock`, `createMemoryLibraryStore`), `@lectern/api-contract` (U-054 schemas), `packages/api-client/src/errors.ts`, `packages/api-client/src/testing/fastify-fetch.ts`, `@lectern/server` (tests only)

**REA Inspection Target & Method**
- Target: N/A — Lectern client logic. Do not call REA.

**Forbidden Actions**
- Do not read or write platform APIs (`window`, `navigator`, `AppState`, timers); the clock, `fetch`, the socket factory, and the online signal are injected.
- Do not acknowledge ops the hub did not list in `accepted`.
- Do not advance the cursor before `applyRemote` has resolved.
- Do not run two sync rounds concurrently; coalesce requests into one follow-up round.
- Do not sync audio blobs.

**Required File Outputs**
- `packages/api-client/src/sync-client.ts` — `createSyncClient({ baseUrl, token, fetch })` with `push`, `pull`, `putModel` (gzips the JSON), `getModel`, `putOriginal`, `getOriginal`; responses validated with the contract schemas. Compression uses the injected `gzip` and `gunzip` functions.
- `packages/api-client/src/sync-engine.ts` — `createSyncEngine({ store, client, clock, openSocket?, isOnline?, gzip, gunzip, onStatus? })` with `start()`, `stop()`, `syncNow()`, `notifyLocalChange()`, `ensureModel(docId)`, and `status()` (`{ state: 'idle' | 'syncing' | 'offline' | 'error', lastSyncedAt, pending }`). A round follows F§8.2 exactly. Local changes trigger a round after 2 s; a socket `changed` message triggers a pull; a round also runs every 5 minutes and on `start`. The socket reconnects with exponential backoff from 1 s to 60 s. Failures set `offline` or `error` and never drop ops.
- `packages/api-client/src/__tests__/sync-engine.test.ts` — against a real hub app with fake clocks and an in-memory socket pair: two engines with separate memory stores converge after edits on both sides; a document's model is uploaded before its op is pushed; a pulled document without a local model is fetched by `ensureModel`; while fetch rejects, ops stay in the outbox and state is `offline`, and they flush when fetch recovers; replaying a push after a lost response does not duplicate anything; the backoff sequence is 1, 2, 4, 8, 16, 32, 60, 60 s; two `syncNow()` calls during a round cause exactly one follow-up round; `stop()` cancels timers and closes the socket.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/api-client exec vitest run \
  && pnpm --filter @lectern/api-client run typecheck \
  && node scripts/check-forbidden.mjs
```
Pass: exit code 0, including the unchanged U-021 tests.

---

### U-059 — Web (patch): sync wiring

**Unit ID & Title:** U-059 — Web (patch): sync wiring

**Inputs & Dependencies**
- Depends on: U-058, U-031
- Reads: F§8, F§10.1
- Uses: `@lectern/api-client` (`createSyncClient`, `createSyncEngine`), `apps/web/src/services.ts`, `apps/web/src/boot.ts`, `apps/web/src/settings/sections.ts`, `apps/web/e2e/helpers.ts`
- Patch scope: `apps/web/src/reader/use-player.ts`, `apps/web/src/App.tsx`
- Patch notes: `use-player.ts` calls the sync service's `ensureModel(docId)` when a document's model is not stored locally, and `notifyLocalChange()` after writing progress. `App.tsx` renders the sync badge in the navigation. Change nothing else.

**REA Inspection Target & Method**
- Target: N/A — cross-device sync is a Lectern design, and the reference product's sync traffic must not be inspected. Do not call REA.

**Forbidden Actions**
- Do not make sync a requirement: with sync off, or the hub unreachable, every Phase 2 feature still works.
- Do not add account, device-management, or sharing UI.
- Do not call the hub's sync routes from components; go through the sync service.
- Do not modify Phase 2 end-to-end specs.

**Required File Outputs**
- `apps/web/src/sync/sync-service.ts` — boot feature: builds the engine from services (browser `WebSocket`, `navigator.onLine` with `online` and `offline` events, `CompressionStream`-based gzip); starts when a hub is configured and the `syncEnabled` setting is true (default true); calls `syncNow()` when the page becomes visible; exposes `status`, `syncNow`, `ensureModel`, `notifyLocalChange`; registered in `boot.ts`.
- `apps/web/src/sync/SyncBadge.tsx` — small status indicator (synced, syncing, offline, error) with the last-synced time as its title.
- `apps/web/src/sync/SyncSection.tsx` — settings section: enable switch, status, pending count, last synced, "Sync now"; registered in `sections.ts`.
- `apps/web/src/__tests__/sync-service.test.ts` — with fakes: starts only when enabled and configured; visibility triggers a round; disabling stops the engine.
- `apps/web/e2e/sync.spec.ts` — two browser contexts act as two devices on one hub: a document imported in A appears in B's library within 10 s without a reload; after playing and pausing in A, opening the document in B starts at A's sentence; a folder and a bookmark created in B appear in A; deleting the document in B removes it from A; with A offline, a new import and a bookmark made in A reach B within 10 s of A coming back online; with sync disabled in A, a new import in A never reaches B.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/web exec vitest run \
  && pnpm --filter @lectern/web run typecheck \
  && pnpm --filter @lectern/web run build \
  && pnpm --filter @lectern/web exec playwright test
```
Pass: exit code 0 for the entire web end-to-end suite, old and new.

---

### U-060 — Extension (patch): save page to library and progress sync

**Unit ID & Title:** U-060 — Extension (patch): save page to library and progress sync

**Inputs & Dependencies**
- Depends on: U-058, U-037
- Reads: F§8, F§10.2
- Uses: `@lectern/api-client` (`createSyncClient`, `createSyncEngine`), `@lectern/ui-web` (`createIdbLibraryStore`, `openLecternDb`, `getDeviceId`), `apps/extension/e2e/fixtures.ts`
- Patch scope: `apps/extension/src/messages.ts`, `apps/extension/entrypoints/offscreen/main.ts`, `apps/extension/src/content/widget/Widget.tsx`
- Patch notes: `messages.ts` gains the message `ext/save-page` and a `saved: boolean` field on `ext/snapshot`. `offscreen/main.ts` creates an IndexedDB library store and a sync engine, handles `ext/save-page` through the new module, and writes progress for saved documents. `Widget.tsx` gains a Save button that shows the saved state. Change nothing else.

**REA Inspection Target & Method**
- Target: N/A — Lectern feature built on the Lectern hub. Do not call REA.

**Forbidden Actions**
- Do not save pages automatically; saving happens only when the user presses Save.
- Do not save pages from private browsing windows.
- Do not store page HTML, cookies, or screenshots; only the extracted `DocumentModel` and its metadata are saved.
- Do not add permissions.

**Required File Outputs**
- `apps/extension/src/library/save-page.ts` — `savePage({ store, engine, document, now })`: writes metadata (`sourceKind: 'html'`, `sourceUri`) and the model with `putDocument`, then `engine.syncNow()`; returns `{ docId, duplicate }`; `recordProgress(store, engine, snapshot)` writes progress at most every 5 s and on pause for documents present in the store.
- `apps/extension/src/library/__tests__/save-page.test.ts` — with memory stores and a fake engine: a save writes one document and triggers a sync; saving twice reports a duplicate; progress is written only for saved documents and is throttled.
- `apps/extension/e2e/save-page.spec.ts` — read the test article, press Save in the widget: the widget shows the saved state; a direct `GET /v1/sync/pull?since=0` to the test hub contains a `document` change titled like the article, and `GET …/model` returns a valid `DocumentModel` with the same `docId`; after pausing, a `progress` change for that `docId` is present; the earlier extension specs still pass.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/extension exec vitest run \
  && pnpm --filter @lectern/extension run typecheck \
  && pnpm --filter @lectern/extension run build \
  && pnpm --filter @lectern/extension exec playwright test
```
Pass: exit code 0 for the entire extension end-to-end suite.

---

### U-061 — Android (patch): sync wiring

**Unit ID & Title:** U-061 — Android (patch): sync wiring

**Inputs & Dependencies**
- Depends on: U-058, U-053
- Reads: F§8, F§10.4
- Uses: `@lectern/api-client` (`createSyncClient`, `createSyncEngine`), `apps/android/src/stores/index.ts`, `apps/android/src/connection.ts`, `apps/android/scripts/device/lib.sh`
- Installs (`apps/android`, exact): `fflate` (gzip on Hermes)
- Patch scope: `apps/android/app/_layout.tsx`, `apps/android/app/(tabs)/settings.tsx`, `apps/android/src/player/player-context.tsx`
- Patch notes: `_layout.tsx` starts and stops the sync service with the app. `settings.tsx` renders the sync card. `player-context.tsx` calls `ensureModel(docId)` when a model is missing locally and `notifyLocalChange()` after writing progress. Change nothing else.

**REA Inspection Target & Method**
- Target: N/A — Lectern feature built on the Lectern hub. Do not call REA.

**Forbidden Actions**
- Do not add background tasks, background fetch, push notifications, or boot receivers; sync runs while the app is in the foreground and during playback.
- Do not add permissions.
- Do not make sync a requirement for any Phase 4 feature.
- Do not add account or device-management UI.

**Required File Outputs**
- `apps/android/src/sync/sync-service.ts` — builds the engine (React Native `WebSocket`, app-state changes as the online and foreground signal, `fflate` gzip); starts when a hub is configured and `syncEnabled` is true; `syncNow()` on foreground; exposes `status`, `syncNow`, `ensureModel`, `notifyLocalChange`.
- `apps/android/src/sync/SyncCard.tsx` — enable switch, status, pending count, last synced, "Sync now".
- `apps/android/src/sync/diagnostics.ts` — registers the check `sync-roundtrip`: writes a setting, runs `syncNow()`, and confirms the outbox is empty and the cursor advanced.
- `apps/android/src/sync/__tests__/sync-service.test.ts` — with fakes: start conditions; foreground triggers a round; disabling stops the engine.
- `apps/android/scripts/device/push-document.mjs` — host script: parses an original 5-sentence text through the local hub, uploads the model, and pushes a `document` op as a second device; prints the title.
- `apps/android/scripts/device/verify-sync.sh` — with the app connected and in the foreground: runs `push-document.mjs`; passes when the title appears in the library within 30 s; then opens `lectern://diagnostics?autorun=1` and requires `PASS sync-roundtrip`.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/android exec vitest run \
  && pnpm --filter @lectern/android run typecheck \
  && node apps/android/scripts/check-android-only.mjs \
  && pnpm --filter @lectern/android exec expo export --platform android --output-dir dist \
  && (cd apps/android && npx expo prebuild --platform android --clean --no-install) \
  && (cd apps/android/android && ./gradlew :app:assembleRelease -q) \
  && node apps/android/scripts/audit-apk.mjs apps/android/android/app/build/outputs/apk/release/app-release.apk \
  && adb get-state | grep -q device \
  && sh apps/android/scripts/device/run-all.sh \
  && sh apps/android/scripts/device/verify-sync.sh
```
Pass: exit code 0. No device or emulator means `BLOCKED`.

---

### U-062 — Hub: LLM provider and mock LLM server

**Unit ID & Title:** U-062 — Hub: LLM provider and mock LLM server

**Inputs & Dependencies**
- Depends on: U-055
- Reads: F§9, F§7.1 (`LLM_*`)
- Uses: `apps/server/src/config.ts`, `apps/server/src/context.ts`, `apps/server/src/app.ts`, `apps/server/src/index.ts`
- Patch scope: `apps/server/src/context.ts`, `apps/server/src/app.ts`
- Patch notes: add an optional `llm` member to the context, created in the app factory when `LLM_BASE_URL` and `LLM_MODEL` are set. Change nothing else.

**REA Inspection Target & Method**
- Target: N/A — never inspect the reference product's AI prompts, models, or AI network traffic. Do not call REA.

**Forbidden Actions**
- Do not add an LLM SDK (`openai`, `ollama`, `langchain`, `ai`); use `fetch`.
- Do not hard-code a provider URL, model name, or API key; all three come from configuration.
- Do not send anything but the prompt messages to the endpoint; no document identifiers, tokens, or metadata.
- Do not log prompts or completions.
- Do not call a real LLM endpoint in tests.

**Required File Outputs**
- `apps/server/src/ai/provider.ts` — the `LlmProvider` interface (F§9) and `createOpenAiCompatibleProvider({ baseUrl, model, apiKey?, fetch?, timeoutMs? })`: `POST {baseUrl}/chat/completions` with `model`, `messages` (system and user), `max_tokens`, `temperature: 0.2`, and `response_format: { type: 'json_object' }` only when `json` is true; sends an `Authorization` header only when `apiKey` is set; returns the first choice's message content; maps network errors, timeouts, non-2xx responses, and an empty choice list to `LLM_UNAVAILABLE`.
- `apps/server/src/testing/index.ts` (registry) — re-exports test helpers; exported from the package as `@lectern/server/testing`.
- `apps/server/src/testing/mock-llm.ts` — `startMockLlm(): Promise<{ baseUrl, requests, close }>`: a `node:http` server for `POST /chat/completions`. Reply rules, by text found in the user message: contains `FORCE_INVALID` → the reply content is not JSON; contains `FORCE_INVALID_ONCE` → invalid on the first call for that message, valid afterwards; contains `FORCE_ERROR` → HTTP 500; contains `FORCE_SLOW` → replies after 2 s; a map prompt → `{ "notes": [...] }` with 3 notes built from the first words of the segment; a reduce prompt → a valid result for the requested mode with deterministic text.
- `apps/server/src/ai/__tests__/provider.test.ts` — against the mock: request body fields; `response_format` present only for JSON; the authorization header present only with a key; HTTP 500 and a timeout map to `LLM_UNAVAILABLE`; `requests` records each call.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/server exec vitest run \
  && pnpm --filter @lectern/server run typecheck \
  && node scripts/check-forbidden.mjs
```
Pass: exit code 0.

---

### U-063 — Hub: summarization pipeline and AI routes

**Unit ID & Title:** U-063 — Hub: summarization pipeline and AI routes

**Inputs & Dependencies**
- Depends on: U-062, U-056
- Reads: F§9, F§7.2 (AI routes), F§8.4 (`summaries` table)
- Uses: `apps/server/src/ai/provider.ts`, `apps/server/src/testing/mock-llm.ts`, `apps/server/src/db/document-files.ts`, `apps/server/src/db/database.ts`, `apps/server/src/routes/index.ts`, `@lectern/api-contract` (`ai-api.ts`), `@lectern/core` (`DocumentModel`)

**REA Inspection Target & Method**
- Target: N/A — never inspect the reference product's AI prompts or traffic; the summary user interface is inspected in U-064. Do not call REA.

**Forbidden Actions**
- Do not copy prompt wording from any product; write original prompts.
- Do not return model output to clients without validating it against `SummaryResultSchema`.
- Do not include skipped blocks (headers, footers, footnotes) in the text sent to the model.
- Do not split a block across segments or exceed 12 000 characters per segment; a single block longer than the limit is split at sentence boundaries.
- Do not run more than one summary job at a time.
- Do not add chat, quiz, translation, or embedding features.

**Required File Outputs**
- `apps/server/src/ai/prompts.ts` — `PROMPT_VERSION`, and functions building the system and user messages for the map step and for the reduce step in `brief` and `detailed` modes, with the limits from F§9 stated in the prompt and the required JSON shape spelled out.
- `apps/server/src/ai/segment.ts` — pure `segmentDocument(doc, maxChars = 12000): string[]`.
- `apps/server/src/ai/summarize.ts` — `summarize(provider, doc, mode): Promise<SummaryResult>`: map-reduce per F§9; one segment skips the map step; every reply is parsed and validated; up to 2 retries per call with the validation error appended to the user message; then `LLM_INVALID_OUTPUT`.
- `apps/server/src/ai/jobs.ts` — `createSummaryJobs({ db, files, provider, model, now })` with `request(docId, mode): SummaryStatus` (returns a cached `done` result, or the existing `running` state, or enqueues and returns `running`), `status(docId, mode)`, and `recoverInterrupted()` (marks `running` rows as `error` with `INTERRUPTED` at start-up); one job runs at a time; results cached by `(docId, mode, model, PROMPT_VERSION)`.
- `apps/server/src/routes/ai.ts` — `POST /v1/ai/summary` (stores an inline `document` as the model if present; 404 `MODEL_MISSING` when the hub has no model; 503 `AI_DISABLED` when no provider is configured; 202 with the status) and `GET /v1/ai/summary/:docId?mode=`; registered in the route registry.
- `apps/server/src/ai/__tests__/segment.test.ts` — packing to the limit; skipped blocks excluded; an oversize block split at sentence boundaries; an empty document yields no segments.
- `apps/server/src/ai/__tests__/summarize.test.ts` — with the mock LLM: a short document makes exactly 1 call; a 40 000-character document makes 4 map calls and 1 reduce call; `FORCE_INVALID_ONCE` succeeds after one retry; `FORCE_INVALID` fails with `LLM_INVALID_OUTPUT` after 3 attempts; brief and detailed results satisfy their schema limits.
- `apps/server/src/__tests__/ai-routes.test.ts` — no LLM configured → 503; unknown document → 404; a request returns 202 `running` and polling reaches `done`; a second request returns the cached result with no new LLM call; an inline document is stored; `FORCE_ERROR` reaches `error` with `LLM_UNAVAILABLE`; a `running` row present at start-up becomes `error` `INTERRUPTED`; two documents requested together are processed one after the other.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/server exec vitest run \
  && pnpm --filter @lectern/server run typecheck \
  && node scripts/check-forbidden.mjs
```
Pass: exit code 0.

---

### U-064 — Web (patch): summary and key-takeaway panel

**Unit ID & Title:** U-064 — Web (patch): summary and key-takeaway panel

**Inputs & Dependencies**
- Depends on: U-063, U-059
- Reads: F§9 (listen to the summary), F§10.1
- Uses: `@lectern/api-contract` (`ai-api.ts`), `@lectern/core` (`buildDocument`), `@lectern/server/testing` (`startMockLlm`), `apps/web/src/services.ts`, `apps/web/src/import/import-service.ts`
- Patch scope: `apps/web/src/reader/ReaderPage.tsx`, `apps/web/e2e/global-setup.ts`
- Patch notes: `ReaderPage.tsx` gains a "Summarize" button that opens the summary drawer. `global-setup.ts` starts the mock LLM and passes its URL and a model name to the test hub. Change nothing else.

**REA Inspection Target & Method**
- Target: `T-WEB`, probe document open, with the reference summary feature opened by the operator.
- Tools: `list_browser_targets`, `inspect_web_page`, `capture_web_screenshot`.
- Method: one `inspect_web_page` with accessibility text and one screenshot after the operator has opened the summary view for the probe document. Do not trigger AI features yourself.
- Questions: Where is the summary feature reached from the reader? How is the result structured (paragraph, bullet list, sections), and roughly how many key points are shown? Are length or style options offered? Can the summary be listened to? Record structure only; do not record the generated text.

**Forbidden Actions**
- Do not call the LLM endpoint from the browser; only the hub does.
- Do not reuse any generated text, labels, or layout from the reference summary view.
- Do not add chat, quiz, flashcard, or translation UI.
- Do not poll faster than once per second or for longer than 10 minutes.

**Required File Outputs**
- `packages/api-client/src/ai-client.ts` — `createAiClient({ baseUrl, token, fetch })` with `requestSummary(docId, mode, document?)`, `getSummary(docId, mode)`, and `waitForSummary(docId, mode, { clock, signal, onStatus })` (polls at 1, 2, 3, then every 5 s, for at most 10 minutes).
- `packages/api-client/src/__tests__/ai-client.test.ts` — against a hub with the mock LLM: request then wait reaches `done`; the polling schedule with a fake clock; abort stops polling; `AI_DISABLED` surfaces as an error code.
- `packages/ui-web/src/components/SummaryPanel.tsx` — props `{ status, result, error, mode, onModeChange, onGenerate, onListen }`; states: not generated, running, done (summary paragraph, numbered takeaways, model name), error with retry; the listen button is enabled only in `done`.
- `packages/ui-web/src/components/__tests__/summary-panel.test.tsx` — each state renders; the mode switch and buttons emit their callbacks; takeaways are a list.
- `apps/web/src/ai/summary-service.ts` — `generate(docId, mode)` (sends the model inline when the hub may not have it), `summaryDocument(result, title)` (`buildDocument` with `source.kind = 'summary'`, a heading, the summary, and one list item per takeaway), and `listen(docId, mode)` (stores the summary document in the folder `Summaries` and opens it with `?autoplay=1`).
- `apps/web/src/ai/SummaryDrawer.tsx` — drawer hosting `SummaryPanel` for the open document.
- `apps/web/e2e/summary.spec.ts` — open an imported document, press Summarize in brief mode: a running state appears, then a summary and at least 3 takeaways; switching to detailed generates a second result; reopening the drawer shows the cached result without a running state; "Listen" opens a document in `Summaries` and playback starts; a document containing `FORCE_INVALID` ends in the error state with a retry button.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/api-client exec vitest run \
  && pnpm --filter @lectern/ui-web exec vitest run \
  && pnpm --filter @lectern/web exec vitest run \
  && pnpm --filter @lectern/web run typecheck \
  && pnpm --filter @lectern/web run build \
  && pnpm --filter @lectern/web exec playwright test
```
Pass: exit code 0 for the entire web end-to-end suite.

---

### U-065 — Android (patch): summary screen

**Unit ID & Title:** U-065 — Android (patch): summary screen

**Inputs & Dependencies**
- Depends on: U-064, U-061
- Reads: F§9, F§10.4
- Uses: `@lectern/api-client` (`createAiClient`), `@lectern/core` (`buildDocument`), `apps/android/src/connection.ts`, `apps/android/src/import/import-service.ts` (`importDocumentModel`), `apps/android/src/stores/index.ts`
- Patch scope: `apps/android/app/read/[docId].tsx`
- Patch notes: add a "Summarize" button that opens the summary screen for the current document. Change nothing else.

**REA Inspection Target & Method**
- Target: `T-SHOTS` (`targets/shots/android/`), operator screenshots of the reference app's summary view.
- Tools: none; view the images directly.
- Method: examine each image.
- Questions: How is the summary reached from the reading screen? How is it laid out on a phone (sheet, full screen)? Record structure only, not generated text.

**Forbidden Actions**
- Do not call the LLM endpoint from the device; only the hub does.
- Do not run or bundle an on-device language model.
- Do not add chat, quiz, or translation screens.
- Do not add `Platform.OS` branches or permissions.

**Required File Outputs**
- `apps/android/src/ai/summary-service.ts` — `generate(docId, mode)`, `summaryDocument(result, title)`, and `listen(docId, mode)` with the same behaviour as the web service (folder `Summaries`, opens the reader with `?autoplay=1`); the pure part (`summaryDocument`) has no React Native imports.
- `apps/android/app/summary/[docId].tsx` — mode switch, generate button, running state with elapsed time, summary and numbered takeaways, error with retry, and "Listen to summary".
- `apps/android/src/ai/__tests__/summary-service.test.ts` — `summaryDocument` yields a valid `DocumentModel` with a heading, the summary, and one list item per takeaway; its `docId` is stable for the same input.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/android exec vitest run \
  && pnpm --filter @lectern/android run typecheck \
  && node apps/android/scripts/check-android-only.mjs \
  && pnpm --filter @lectern/android exec expo export --platform android --output-dir dist \
  && test -n "$(find apps/android/dist -name '*.hbc' | head -n 1)" \
  && node scripts/check-forbidden.mjs
```
Pass: exit code 0. The on-device summary flow is a manual check recorded in U-067's report.

---

### U-066 — Ops: backup, restore, cache pruning, compose profiles

**Unit ID & Title:** U-066 — Ops: backup, restore, cache pruning, compose profiles

**Inputs & Dependencies**
- Depends on: U-063, U-022
- Reads: F§7.2 (`/v1/admin/backup`), F§7.3, F§12
- Uses: `apps/server/src/routes/index.ts`, `apps/server/src/db/database.ts`, `apps/server/build.mjs`, `infra/docker-compose.yml`, `infra/.env.example`
- Installs (`apps/server`, exact): `tar`
- Patch scope: `infra/docker-compose.yml`, `infra/.env.example`, `apps/server/build.mjs`
- Patch notes: the compose file gains the profile `llm` with a pinned `ollama/ollama` service on the compose network only and the matching `LLM_BASE_URL`; the example environment file gains commented `LLM_*` lines; the build script additionally bundles the two CLI entry points. Change nothing else.

**REA Inspection Target & Method**
- Target: N/A — Lectern operations. Do not call REA.

**Forbidden Actions**
- Do not copy the live SQLite file for a backup; use the database's online backup API to take a consistent snapshot.
- Do not include the token, `infra/.env`, or OCR language data in a backup; do not include the TTS cache unless `includeAudio=1`.
- Do not restore into a non-empty data directory, and never restore automatically.
- Do not add scheduled jobs, cloud upload targets, or remote backup destinations.
- Do not publish the Ollama port on the host.

**Required File Outputs**
- `apps/server/src/routes/admin.ts` — `GET /v1/admin/backup[?includeAudio=1]`: streams a `tar.gz` with `lectern.db` (snapshot), `library/`, and a `manifest.json` (`{ createdAt, schemaVersion, files }`); registered in the route registry.
- `apps/server/src/cli/restore.ts` — `node dist/restore.mjs <archive> <dataDir>`: refuses a non-empty directory, validates the manifest and schema version, extracts with path-traversal protection.
- `apps/server/src/cli/prune-cache.ts` — `node dist/prune-cache.mjs --days <n> [--dry-run]`: removes TTS cache entries (audio and metadata together) not modified in `n` days; prints counts and bytes.
- `apps/server/src/__tests__/ops.test.ts` — a backup of a populated hub contains the database and library files and no cache or secret; restoring it into an empty directory and opening a new app returns the same pull result and model bytes; restore refuses a non-empty directory and an archive with a `../` entry; prune removes only old entries and keeps audio and metadata paired; `--dry-run` deletes nothing.
- `docs/operations.md` — deployment with compose, choosing engines and profiles, reaching the hub over a private network, backup and restore commands, cache pruning, and upgrading.

**Pass/Fail Verification Test**
```sh
pnpm --filter @lectern/server exec vitest run \
  && pnpm --filter @lectern/server run typecheck \
  && node apps/server/build.mjs \
  && test -s apps/server/dist/server.mjs && test -s apps/server/dist/restore.mjs && test -s apps/server/dist/prune-cache.mjs \
  && cp -n infra/.env.example infra/.env \
  && docker compose -f infra/docker-compose.yml --profile piper --profile llm config -q \
  && ! grep -n "latest" infra/docker-compose.yml
```
Pass: exit code 0. If Docker is unavailable, the unit is `BLOCKED`.

---

### U-067 — Release: cross-device verification and parity audit

**Unit ID & Title:** U-067 — Release: cross-device verification and parity audit

**Inputs & Dependencies**
- Depends on: U-044, U-060, U-065, U-066
- Reads: F§4 (every row), F§14; `docs/status.md`; every file in `docs/evidence/`
- Uses: `@lectern/api-client`, `@lectern/core`, `@lectern/server`, `@lectern/server/testing`, every package's test and build scripts

**REA Inspection Target & Method**
- Target: N/A — this unit audits Lectern against `features.md` and the existing evidence files. Do not call REA.

**Forbidden Actions**
- Do not change any application or package source; this unit adds two scripts and two documents. A failing check is reported, not fixed here.
- Do not mark a parity row verified unless its command ran in this session and exited 0.
- Do not describe a skipped, blocked, or manual check as passed.
- Do not include reference-product screenshots, text, or identifiers in the report.

**Required File Outputs**
- `scripts/e2e-cross-device.mjs` — starts a hub in a temporary directory with the mock engine and mock LLM; simulates two devices with `MemoryLibraryStore`, `createCachingChunkSource`, and `createSyncEngine`; device A parses a text, plays 3 sentences through a fake sink (requesting real chunks), bookmarks, and syncs; device B syncs, sees the document, progress, and bookmark, fetches the model, and resumes; B requests a summary and both devices read the same result; a backup is downloaded and listed. Prints one line per step and exits 1 on the first failure.
- `scripts/release-check.mjs` — runs, in order, and records the exit code and duration of: `pnpm -w run lint`; `pnpm -w run typecheck`; `pnpm -w run test`; the four guard scripts; web build and end-to-end suite; extension build and suite; desktop build and suite (under `xvfb-run` on Linux); Android host checks (Vitest, type check, Android-only check, Hermes export); `scripts/e2e-cross-device.mjs`. With `--device` it also runs the Android device scripts; with `--docker` it also runs the U-022 smoke test. Steps whose prerequisites are absent are reported as `SKIPPED` with the reason. Writes `docs/release-check.json`. Exits 1 if any step that ran failed.
- `docs/parity-report.md` — the F§4 table with, for every `IN` row: the verifying units, the command that covers it, and the result from this session's `docs/release-check.json` (`PASS`, `FAIL`, `SKIPPED`, or `MANUAL`). Then: every unit whose status is `BLOCKED`; every unit whose inspection was `UNAVAILABLE`; every open *Deviation proposal* from the evidence files; the manual checklists (`docs/desktop-windows-build.md`, `docs/android-manual-checks.md`) with their recorded state; the known limits from F§14.
- `README.md` — what Lectern is, the architecture in ten lines with a pointer to `features.md`, quick start (hub with compose, web app, loading the extension unpacked, desktop build, Android sideload), and the statement that it is a single-user personal tool with no accounts or telemetry.

**Pass/Fail Verification Test**
```sh
node scripts/e2e-cross-device.mjs \
  && node scripts/release-check.mjs \
  && test -s docs/parity-report.md && test -s README.md \
  && node -e "const r=require('./docs/release-check.json');if(r.steps.some(s=>s.status==='FAIL'))process.exit(1)" \
  && node scripts/check-forbidden.mjs
```
Pass: exit code 0. `SKIPPED` steps do not fail the unit, but each must appear in `docs/parity-report.md` with its reason.
