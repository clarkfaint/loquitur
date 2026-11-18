# Lectern parity report

What F§4 of `features.md` promises, and what verifies each promise — measured by the commands named beside every
row. The unit contracts in `spec.md` built the product one unit at a time and `docs/status.md` is their ledger;
this report is the release's own statement of what is covered, what is not, and what is still owed. It is U-067's
own report, and every status below comes from a command that ran in one of that unit's two sessions: the closing
session's record (revision `2f57cac`) unless the cell says otherwise, and the same unit's earlier `--device
--docker` run for the steps the closing session did not request.

## 0. How these results were produced

- **Revision:** `2f57cac` on `main` — the commit the closing session's record names (`revision: { commit:
  "2f57cac", branch: "main" }`), and the commit that scopes the desktop suite's library assertions.
- **The record:** `docs/release-check.json`, written by `node scripts/release-check.mjs` — the step table below is
  its own, quoted rather than paraphrased. The closing session's run measured **18 passed, 0 failed, 7 skipped of
  25 steps** in 296 s (`generatedAt 2026-11-18T05:17:52.307Z`). A first attempt in the same session, the identical
  command line with no file changed between the two, measured 17 passed, **1 failed**, 7 skipped in 296 s; its one
  failure was the intermittent web case §7.2 documents, not a parity gap.
- **The phone and the stack:** the four device steps and the three compose steps are `SKIPPED` in the closing
  session's record with the reasons *"not requested (pass --device)"* and *"not requested (pass --docker)"*. They
  were exercised in this unit's earlier session: `node scripts/release-check.mjs --device --docker` (24 passed, 1
  failed, 0 skipped of 25 steps, 1282 s), whose device serial was resolved from `adb devices -l` at run time
  (`192.0.2.57:35403`), never written down. That run's single failure was the `desktop-e2e` case §7.1 has since
  closed.
- **The fixed command:** `node scripts/e2e-cross-device.mjs && node scripts/release-check.mjs && test -s
  docs/parity-report.md && test -s README.md && node -e "const r=require('./docs/release-check.json');if(r.steps.some(s=>s.status==='FAIL'))process.exit(1)" && node scripts/check-forbidden.mjs` — run exactly as the contract
  writes it, unmodified, in the closing session. **It exits 0.** The earlier session's run of the same chain exited
  1, on this unit's then-unclosable `desktop-e2e` failure.
- **Inspection:** this unit's contract names no target and forbids calling REA, so **no REA call was made** in
  either session; §3 is the release-wide state of every unit's inspection field.
- **Reproducing any row:** the step's own command is quoted in §1; `node scripts/release-check.mjs` regenerates the
  whole record, and `--device` / `--docker` regenerate the phone rows and the compose rows. The JSON itself is a run
  artifact — §7.3 records why it does not stay in the tree.

## 1. F§4 parity matrix — every `IN` row, and what verifies it

| Reference capability | Lectern implementation | Units | Verified by | Step statuses (closing session unless marked †) |
|---|---|---|---|---|
| Read PDFs, EPUBs, DOCX, TXT, web articles | Hub parsers → `DocumentModel` | U-004…U-011, U-020 | PASS | test=PASS, web-e2e=PASS, extension-e2e=PASS |
| Scan printed pages and listen | Android camera scanner + ML Kit; hub tesseract for images and scanned PDFs | U-010, U-051 | PASS (+ MANUAL) | android-test=PASS, MANUAL: `docs/android-manual-checks.md` §1 |
| Synchronized word + sentence highlighting | Engine word timestamps, alignment, binary-search lookup | U-012, U-025, U-035, U-048 | PASS | web-e2e=PASS, android-test=PASS |
| Speed control up to 4.5× with pitch preserved | Sink time-stretch + `planSpeed` split-rate fallback | U-012, U-024, U-047 | PASS | test=PASS, web-e2e=PASS, android-test=PASS |
| Many voices, voice picker | Kokoro and Piper voices, namespaced `engine:voice` | U-015…U-017, U-023 | PASS | test=PASS, web-e2e=PASS |
| Click a word to start reading there | Position seek in `PlayerController` | U-013, U-025, U-035 | PASS | web-e2e=PASS |
| Skip headers, footers, footnotes, citations | `skip` classification on blocks; bracketed-citation filter | U-004, U-007 | PASS | test=PASS, web-e2e=PASS |
| Sleep timer, sentence skip, keyboard shortcuts | `PlayerController` commands | U-013, U-029 | PASS | test=PASS, web-e2e=PASS |
| Chrome extension: read any page, floating player | Content script + offscreen audio + shadow-DOM widget | U-032…U-037 | PASS | extension-build=PASS, extension-e2e=PASS |
| PDF reading in the browser | Web app PDF page view; extension hands PDF tabs to the web app | U-030, U-037 | PASS | web-e2e=PASS, extension-e2e=PASS |
| Desktop: read selected text anywhere, hotkeys | Electron global shortcuts + OS selection capture | U-040, U-041 | PASS | desktop-e2e=PASS |
| Desktop: read text from the screen | Region screenshot → hub OCR | U-042 | PASS | desktop-e2e=PASS |
| Desktop: mini-player | Frameless always-on-top window + tray | U-039 | PASS | desktop-e2e=PASS |
| Import from cloud drives *(substitute)* | Replaced by a local watched folder | U-043 | PASS | desktop-e2e=PASS |
| Android: share to app | `expo-sharing` incoming share | U-050 | PASS (+ MANUAL) | device-run-all=PASS †, MANUAL: `docs/android-manual-checks.md` §2–§3 |
| Android: background audio, lock-screen controls | `expo-audio` playlist + media foreground service | U-047, U-052 | PASS (+ MANUAL) | device-run-all=PASS †, MANUAL: `docs/android-manual-checks.md` §4–§6 |
| Listen offline | `BlobCache` + “download for offline” | U-031, U-053 | PASS | web-e2e=PASS, android-test=PASS, device-offline=PASS † |
| Library, folders, bookmarks, progress across devices | Local stores + hub sync | U-014, U-054…U-061 | PASS | web-e2e=PASS, cross-device=PASS, device-sync=PASS † |
| AI summary and key takeaways | Map-reduce over a local LLM, JSON-validated | U-062…U-065 | PASS (+ MANUAL) | web-e2e=PASS, cross-device=PASS, MANUAL: the on-device summary flow |

Read a row like this: the middle column names the capability's own implementation, and the last two columns
the steps that exercise it and what each of those steps reported. Where two steps cover one row, the row is
only as good as the weaker of them. Cells naming `MANUAL:` are human checks — their recorded state is §5.

`†` marks the four device steps and the three compose steps. They are `SKIPPED` in the closing session's record with
the reason *"not requested (pass --device)"* or *"not requested (pass --docker)"* — reported here as `SKIPPED` with
that reason, not as verified — so the `PASS` beside them is this unit's earlier `--device --docker` run (§0), by the
same unit, and is labelled as that session's rather than the closing session's.

The rows F§4 marks out of scope are listed for completeness, with no verification claimed:

| Reference capability | Lectern's position | Units | F§4 status |
|---|---|---|---|
| AI chat with a document, AI quiz | Same `LlmProvider`; no UI in this spec | — | DEFERRED |
| Translation, pronunciation dictionary | Hook points: `Block.lang`, pre-synthesis text filter | — | DEFERRED |
| On-device synthesis without the hub | `TtsEngine` interface allows it | — | DEFERRED |
| Reading inside canvas-rendered editors (e.g. Google Docs) | Not reachable by DOM text extraction | — | EXCLUDED (v1) |
| Voice typing / dictation, meeting notes, AI podcasts | Not reading features | — | EXCLUDED |
| Voice cloning, celebrity voices, dubbing, avatars, studio tools | Not reading features; likeness and licensing risk | — | EXCLUDED |
| Accounts, subscriptions, teams, usage limits, analytics | Single-user personal tool | — | EXCLUDED |
| iOS, iPadOS, macOS, Safari | Out of scope by requirement | — | EXCLUDED |

## 2. Every unit that was `BLOCKED`

A blocked unit is one whose Pass/Fail Verification Test could not exit 0 in its session; each was closed later,
usually by an operator patch. This is the ledger's own history:

The ledger (`docs/status.md`) holds **81 unit rows** with this unit's closing `DONE` row appended — 68 `DONE`, and
**13 rows carrying Status `BLOCKED` across 9 distinct units**: U-001 (2 rows), U-006, U-023, U-044, U-046, U-051
(2 rows), U-052, U-053 (3 rows) and U-067 (1 row — this unit itself). **Every one of the nine units has a later
`DONE` row.** One bullet per unit, in unit order (**9 bullets**).

- **U-001** — failing command `node --test scripts/__tests__/` (commit `ec1a29c`): "Node 24.22.3 resolves the directory argument with its own glob and hands the directory to a child process as its entry module (MODULE_NOT_FOUND); needs the glob form or a listed tests-directory manifest". A second `BLOCKED` row (`c37e850`) records `node scripts/check-scope.mjs U-001`: "the scope gate exits 1 on `spec.md`, which differs from base `8a43abd` only because of the operator's own patch commit `0679d7f`". **Later `DONE` row `559aceb`**: "the fixed verification command and all four standing gates exit 0 under the operator's patched contract (base `0a2fed9`)".
- **U-006** — failing command `pnpm --filter @lectern/core run typecheck` (commit `116bd43`): the program must contain `src/parsers/**`, giving 131 errors inside linkedom 0.18.15's shipped `.d.ts` and 2 `TS2591` for `node:` imports, and "both files that could carry [`skipLibCheck`] … are outside this unit's writable set". **Later `DONE` row `41347d9`**: "closed under the operator's patch … with `skipLibCheck` in `tsconfig.base.json`".
- **U-023** — failing command `pnpm -w run typecheck` (commit `681b4af`): the standing gate "exits 1 in `@lectern/server` on two frozen lines of `packages/core/src/parsers/`" because `happy-dom@21.0.4`'s transitive `@types/node` is hoisted; "all three repairs … live in files this unit may not write". **Later `DONE` row `a20bcce`**: "closed under the operator's `hoistPattern` repair".
- **U-044** — failing command `pnpm --filter @lectern/desktop run dist:linux` (commit `130a7a7`): electron-builder refuses the manifest — "Package "electron" is only allowed in "devDependencies"" — and the manifest "is owned by `U-038`, and outside this unit's scope". **Later `DONE` row `130a7a7`**: "the contract's fixed command exits 0 in this session against the operator's patched manifest `2a9947b`".
- **U-046** — failing command `pnpm --filter @lectern/android exec vitest run` (commit `cd3425b`): U-045's frozen `selftest.test.ts:207` asserts "exactly two ids" while the contract requires registering two more. **Later `DONE` row `cd3425b`**: "Closed on the operator's patch `5871bdf` (the android registry assertion is now `arrayContaining`, repair 2 …)".
- **U-051** — failing command `! grep -q "RECORD_AUDIO" apps/android/android/app/src/main/AndroidManifest.xml` (two `BLOCKED` rows `fbe1801`, `2076cef`): `expo-image-picker`'s auto-applied plugin always writes the string as a `tools:node="remove"` directive, and the operator's first patch "landed in **U-047**'s contract (`spec.md` line 2041) instead of this one's". **Later `DONE` row `fbe1801` (dated 2026-11-16)**: "closed on the operator's contract patch `4724460`, which moved §7 (1)'s repair (a) into *this* unit's step 7".
- **U-052** — failing command `node scripts/preflight.mjs --phase 4 && adb get-state | grep -q device && sh apps/android/scripts/device/run-all.sh` (commit `b6a620c`): the app's own diagnostics report "`FAIL audio-sink`" (5 of 7 cases) and `dumpsys media_session` answers `none`; the sink is U-047's frozen file and the unit "adds scripts only". **Later `DONE` row `b6a620c`**: "closed on the operator's own app repairs (`6fdb73c` … `8670547` …) plus the `2bb2f2a` fixture patch".
- **U-053** — three `BLOCKED` rows: run 1 (`f2baaf5`) `node apps/android/scripts/audit-apk.mjs …` — the release APK declares "three … outside the allowlist" (`MODIFY_AUDIO_SETTINGS`, `USE_BIOMETRIC`, `USE_FINGERPRINT`); run 2 (`6bb3491`) `pnpm --filter @lectern/android exec vitest run && … && node scripts/check-forbidden.mjs` — the audit cleared but `verify-media-session.sh` read `none`; run 3 (`0c8deac`) `sh apps/android/scripts/device/run-all.sh` — the new `pm clear` "erases" the provisioned connection. **Later `DONE` row `95de6b5`**: "closed on the operator's `chore(spec)` `b6a1e27` … plus this session's own repair of the unit's file".
- **U-067** — failing command `node scripts/e2e-cross-device.mjs && node scripts/release-check.mjs && test -s docs/parity-report.md && test -s README.md && node -e "…" && node scripts/check-forbidden.mjs` (commit `37c5259`): the release check's `desktop-e2e` step was a `FAIL`. Two of the desktop suite's 19 cases — `region.spec.ts`'s Esc case and `selection.spec.ts`'s Quick-reads case — demanded an exact library size (`expect(rows).toHaveLength(1)`, `expect(documents).toHaveCount(1)`) while one Playwright run shares one hub, so F§8's sync put an earlier case's document (`mini.spec`'s `Harbour Light`) into the later case's library; each spec passed alone (region 3/3, selection 2/2) and the pair reproduced it in 37 s. The unit has no `Patch scope` — its *Forbidden Actions* say a failing check "is reported, not fixed here" — and both files last changed in U-044 (`130a7a7`), before `apps/web`'s sync wiring landed in U-059 (`d8f90ea`). **Later `DONE` row (2026-11-18)**: closed by the operator's `chore(spec)` `2f57cac`, which scopes both counts to the document the case itself creates — repair (a) of `docs/evidence/U-067.md` §7 (1) — after which the contract's fixed command exits **0** on the four deliverables exactly as `37c5259` left them; the row cites the commit carrying this report and the evidence append.

## 3. Every inspection that was not `DONE`

Of the 68 evidence files, **35 headers read `Inspection: UNAVAILABLE (...)`** and **33 read `Inspection: N/A`** (68 total; none is `DONE`).

**UNAVAILABLE — unit ids (35):** U-003, U-007, U-012, U-013, U-023, U-024, U-025, U-027, U-028, U-029, U-030, U-032, U-033, U-034, U-035, U-036, U-037, U-038, U-039, U-040, U-041, U-042, U-043, U-044, U-045, U-046, U-047, U-048, U-049, U-050, U-051, U-052, U-053, U-064, U-065

**N/A — unit ids (33):** U-000, U-001, U-002, U-004, U-005, U-006, U-008, U-009, U-010, U-011, U-014, U-015, U-016, U-017, U-018, U-019, U-020, U-021, U-022, U-026, U-031, U-054, U-055, U-056, U-057, U-058, U-059, U-060, U-061, U-062, U-063, U-066, U-067

One bullet per unit, in unit order (**68 bullets**: 35 UNAVAILABLE + 33 N/A).

- **U-000** — N/A: no inspection targets present (advisory only).
- **U-001** — N/A: Target none.
- **U-002** — N/A: Target none; no REA call.
- **U-003** — UNAVAILABLE: three named REA tools not in the session's tool list.
- **U-004** — N/A: Target none (`T-` N/A).
- **U-005** — N/A: Target none (`T-` N/A).
- **U-006** — N/A: Target N/A.
- **U-007** — UNAVAILABLE: three named REA tools not in the session's tool list.
- **U-008** — N/A: Target N/A.
- **U-009** — N/A: Target N/A.
- **U-010** — N/A: Target N/A.
- **U-011** — N/A: Target N/A.
- **U-012** — UNAVAILABLE: three named REA tools not in the session's tool list.
- **U-013** — UNAVAILABLE: two named REA tools not in the session's tool list.
- **U-014** — N/A: Target none.
- **U-015** — N/A: Target none.
- **U-016** — N/A: Target none.
- **U-017** — N/A: Target N/A.
- **U-018** — N/A: Target N/A.
- **U-019** — N/A: Target N/A.
- **U-020** — N/A: Target N/A.
- **U-021** — N/A: Target N/A.
- **U-022** — N/A: Target N/A.
- **U-023** — UNAVAILABLE: three named REA tools not in the session's tool list.
- **U-024** — UNAVAILABLE: two named tools absent; no browser target present.
- **U-025** — UNAVAILABLE: three named tools absent; no browser target present.
- **U-026** — N/A: client storage is a Lectern design; reading the reference's stored data is forbidden.
- **U-027** — UNAVAILABLE: three named tools absent; no reachable browser target.
- **U-028** — UNAVAILABLE: three named tools absent; no browser target present.
- **U-029** — UNAVAILABLE: two named tools absent; no browser target present.
- **U-030** — UNAVAILABLE: three named tools absent; no browser target present.
- **U-031** — N/A: Target N/A.
- **U-032** — UNAVAILABLE: targets/extension/ not present on this host.
- **U-033** — UNAVAILABLE: targets/extension/ not present on this host.
- **U-034** — UNAVAILABLE: targets/extension/ not present on this host.
- **U-035** — UNAVAILABLE: targets/extension/ not present on this host.
- **U-036** — UNAVAILABLE: targets/extension/ not present on this host.
- **U-037** — UNAVAILABLE: targets/extension/ not present on this host.
- **U-038** — UNAVAILABLE: targets/desktop-win/ not present on this host.
- **U-039** — UNAVAILABLE: targets/desktop-win/ not present on this host.
- **U-040** — UNAVAILABLE: targets/desktop-win/ not present on this host.
- **U-041** — UNAVAILABLE: targets/desktop-win/ not present on this host.
- **U-042** — UNAVAILABLE: targets/desktop-win/ not present on this host.
- **U-043** — UNAVAILABLE: targets/desktop-win/ not present on this host.
- **U-044** — UNAVAILABLE: targets/desktop-win/ not present on this host.
- **U-045** — UNAVAILABLE: targets/android/base.apk not present on this host.
- **U-046** — UNAVAILABLE: targets/android/base.apk not present on this host.
- **U-047** — UNAVAILABLE: targets/android/base.apk not present on this host.
- **U-048** — UNAVAILABLE: targets/android/base.apk not present on this host.
- **U-049** — UNAVAILABLE: targets/android/base.apk not present on this host.
- **U-050** — UNAVAILABLE: targets/android/base.apk not present on this host.
- **U-051** — UNAVAILABLE: targets/android/base.apk not present on this host.
- **U-052** — UNAVAILABLE: targets/android/base.apk not present on this host.
- **U-053** — UNAVAILABLE: target not present on this host; no REA call made.
- **U-054** — N/A: contract names no target; no REA call.
- **U-055** — N/A: Target N/A.
- **U-056** — N/A: Target N/A.
- **U-057** — N/A: Target N/A.
- **U-058** — N/A: Target none.
- **U-059** — N/A: Target N/A.
- **U-060** — N/A: Target none.
- **U-061** — N/A: Target N/A.
- **U-062** — N/A: Target none.
- **U-063** — N/A: Target N/A.
- **U-064** — UNAVAILABLE: three named tools absent; no reference target present.
- **U-065** — UNAVAILABLE: targets/shots/android/ not present on this host.
- **U-066** — N/A: Target N/A.
- **U-067** — N/A: Target none; contract forbids calling REA.

## 4. Every open *Deviation proposal* from the evidence files

242 open proposals are recorded across the evidence files (of 312 §7 items; 26 are recorded as
resolved, and observations that seek no change are left out here — their unit's §7 carries them verbatim).
Each row names its evidence file, which is where the proposal's full text and its measured context live:

| Unit (§7 item) | Proposal | Evidence |
|---|---|---|
| `U-001 §7 [1]` | state the expectation for build-tool telemetry in a later contract. | `docs/evidence/U-001.md` |
| `U-001 §7 [2]` | extend the scan set to untracked, unignored files. | `docs/evidence/U-001.md` |
| `U-001 §7 [5]` | Declare scripts/__tests__/package.json ({"main": "guards.test.mjs"}) under *Required File Outputs*, so Node resolves the directory the command hands to its child process. | `docs/evidence/U-001.md` |
| `U-001 §7 [9]` | Declare a Patch scope: naming spec.md for the unit (the weakest of the three repairs). | `docs/evidence/U-001.md` |
| `U-002 §7 [1]` | state in the contract that test files may use Node built-ins as oracles. | `docs/evidence/U-002.md` |
| `U-002 §7 [2]` | confirm in U-003 or the first parsers unit that those two entries are the intended target paths. | `docs/evidence/U-002.md` |
| `U-002 §7 [3]` | This repository has no @types/node, and R10 forbids installing one, so no declaration file that mentions Node's ambient types can be in a tsc program: … | `docs/evidence/U-002.md` |
| `U-002 §7 [4]` | state the expected script set for packages/core in a later contract if the turbo tracks are meant to pick the package up. | `docs/evidence/U-002.md` |
| `U-003 §7 [1]` | state the hard-cut fallback in F§5.3, or name the maximum a piece may reach when the break is a punctuation character. | `docs/evidence/U-003.md` |
| `U-003 §7 [2]` | let the unit that owns highlighting (the player or the web reader surface) own this question, and drop it from U-003's *Questions*. | `docs/evidence/U-003.md` |
| `U-004 §7 [1]` | either add a boolean (e.g. | `docs/evidence/U-004.md` |
| `U-004 §7 [2]` | state that furniture detection is geometry-dependent and that geometry-free sources carry no headers or footers. | `docs/evidence/U-004.md` |
| `U-005 §7 [1]` | state the column width (or the requirement that --check assert the break), so the constraint is visible to whoever edits the fixture next. | `docs/evidence/U-005.md` |
| `U-005 §7 [2]` | fold them into the contract so the next unit to touch fixtures is held to the same bar. | `docs/evidence/U-005.md` |
| `U-005 §7 [3]` | either add pnpm-workspace.yaml to the always-allowed set, or record the policy decision once (minimumReleaseAge relaxed for this workspace, or verifyDepsBeforeRun … | `docs/evidence/U-005.md` |
| `U-005 §7 [4]` | record 200 DPI, so page.png (1240 × 1754, A4 at 150 DPI) and scanned.pdf are visibly two different regimes rather than two arbitrary sizes. | `docs/evidence/U-005.md` |
| `U-005 §7 [5]` | @napi-rs/canvas adds four platform binary packages to pnpm-lock.yaml (linux x64 gnu/musl, win32 x64/arm64). | `docs/evidence/U-005.md` |
| `U-006 §7 [4]` | state the option's purpose in F§5.4, or move it to the unit that first needs an absolute link (U-032), so a later unit does not … | `docs/evidence/U-006.md` |
| `U-006 §7 [5]` | settle the policy once (relax minimumReleaseAge, set verifyDepsBeforeRun: false, or add pnpm-workspace.yaml to the guard's always-allowed set). | `docs/evidence/U-006.md` |
| `U-007 §7 [1]` | RawBlock has no field for "below a horizontal rule", which F§5.4's footnote rule names as an alternative arm; U-004 recorded the same gap and the … | `docs/evidence/U-007.md` |
| `U-007 §7 [2]` | state the comparison's two operands in F§5.4 (whitespace gap against type size), so a later parser does not have to rediscover which reading works. | `docs/evidence/U-007.md` |
| `U-007 §7 [3]` | either accept that a word's highlight may be partial in one item (state it in F§5.1), or let PdfAnchor carry a short list of item/character … | `docs/evidence/U-007.md` |
| `U-007 §7 [4]` | wrap the footnote in the generator, and have --check read the footnote's full text back, so a later unit can assert on a complete footnote. | `docs/evidence/U-007.md` |
| `U-007 §7 [5]` | name, in the unit that owns reader behaviour (not a parser), the target and the tools that will actually be present when it runs. | `docs/evidence/U-007.md` |
| `U-008 §7 [1]` | name the two markers in F§5.4 so a later parser (or the DOCX parser's cover page, if it has one) does not have to choose … | `docs/evidence/U-008.md` |
| `U-008 §7 [2]` | have U-005's generator put the navigation and cover documents in the fixture's spine, or say in F§5.4 that the fixture pins spine order only. | `docs/evidence/U-008.md` |
| `U-008 §7 [3]` | record both facts in F§5.4's EPUB row, since a later parser of an XML-based format (the DOCX package is a ZIP of XML as well) … | `docs/evidence/U-008.md` |
| `U-008 §7 [4]` | state the assumption in F§5.4 so the dispatcher's later MIME sniffing does not have to guess what the parser does. | `docs/evidence/U-008.md` |
| `U-008 §7 [5]` | name the last one in the contract, because "refuse a DRM book" is easy to implement as "refuse any book with an encrypted resource", and … | `docs/evidence/U-008.md` |
| `U-009 §7 [1]` | name that part in F§5.4's DOCX row, so a later change to the parser (or the dispatcher) does not have to rediscover it. | `docs/evidence/U-009.md` |
| `U-009 §7 [2]` | either say in F§5.4 that a Word Title style is body text, or name a style map (p[style-name='Title'] => h1) as the intended treatment — … | `docs/evidence/U-009.md` |
| `U-009 §7 [3]` | add @types/node to F§2.3, or state the type-check program's boundary (a package program that excludes the tests) as an explicit rule rather than as something … | `docs/evidence/U-009.md` |
| `U-009 §7 [4]` | record the filter as the intended implementation of that action, since the obvious implementation (unzip everything, then look at word/document.xml) reads every image in the … | `docs/evidence/U-009.md` |
| `U-009 §7 [5]` | name the last one, because "read the title from the properties" is easy to implement as "the properties are always there", and a document saved … | `docs/evidence/U-009.md` |
| `U-010 §7 [1]` | state the measure in F§5.5 (whitespace between boxes, median box height over the lines above the floor), so a later adapter or the Android path … | `docs/evidence/U-010.md` |
| `U-010 §7 [2]` | name the hub's OCR language as an operator setting (F§7.1's environment block has LECTERN_DATA_DIR for the cached data but no language), or add a third … | `docs/evidence/U-010.md` |
| `U-010 §7 [3]` | say "one worker per language, reused" in F§5.5 so the contract and the code agree on what is cached. | `docs/evidence/U-010.md` |
| `U-010 §7 [4]` | state it (or state ""), because the two differ for a caller that lists titles before parsing. | `docs/evidence/U-010.md` |
| `U-010 §7 [5]` | leave the signature for the camera path's sake but name the cost, or allow an internal page-taking form in a patched contract. | `docs/evidence/U-010.md` |
| `U-010 §7 [6]` | add the data package to F§2.3 with its version and a note that it is resolved, never imported, so the next unit that needs language … | `docs/evidence/U-010.md` |
| `U-010 §7 [7]` | settle both policies once in the workspace (pnpm-workspace.yaml, which the operator has already added to the scope guard's always-allowed set) — onlyBuiltDependencies … | `docs/evidence/U-010.md` |
| `U-011 §7 [1]` | The markup signature. | `docs/evidence/U-011.md` |
| `U-012 §7 [1]` | state the weighting in F§5.6(f) explicitly (an equal-weight blend, or an exponential average with its coefficient) so a later unit cannot pick a different one … | `docs/evidence/U-012.md` |
| `U-012 §7 [2]` | F§5.6(f) should say which of the two a position on the last word means, and the contract's one-line test description should name the end-of-document position … | `docs/evidence/U-012.md` |
| `U-013 §7 [1]` | state the intended ended → play position. | `docs/evidence/U-013.md` |
| `U-013 §7 [2]` | say whether stop keeps the document. | `docs/evidence/U-013.md` |
| `U-013 §7 [3]` | name the default-voice rule. | `docs/evidence/U-013.md` |
| `U-014 §7 [1]` | add a sentence to F§5.9 that says the pin predicate is the caller's, or add pin(key)/unpin(key) to BlobCache. | `docs/evidence/U-014.md` |
| `U-014 §7 [2]` | state that record is unknown and always present, which is what both the schema and every producer here do. | `docs/evidence/U-014.md` |
| `U-014 §7 [3]` | add interface SettingRecord { key: string; value: unknown; updatedAt: number; deleted: boolean } to the F§5.9 block so every implementation and the hub's repository agree … | `docs/evidence/U-014.md` |
| `U-014 §7 [4]` | say so in F§5.9. | `docs/evidence/U-014.md` |
| `U-014 §7 [5]` | name the quantity in F§5.9. | `docs/evidence/U-014.md` |
| `U-015 §7 [1]` | name the two types in the F§6 block. | `docs/evidence/U-015.md` |
| `U-015 §7 [2]` | state them, or state that an adapter may choose. | `docs/evidence/U-015.md` |
| `U-015 §7 [3]` | leave it to the adapter, as done here; the duration law and the container are what other code can depend on. | `docs/evidence/U-015.md` |
| `U-015 §7 [4]` | state that durationMs must agree with the audio the engine returns. | `docs/evidence/U-015.md` |
| `U-015 §7 [5]` | say in F§6 that an empty array is treated as null by the hub. | `docs/evidence/U-015.md` |
| `U-016 §7 [1]` | lib for this package. | `docs/evidence/U-016.md` |
| `U-016 §7 [2]` | The voice-list envelope. | `docs/evidence/U-016.md` |
| `U-016 §7 [3]` | Voice.lang. | `docs/evidence/U-016.md` |
| `U-017 §7 [1]` | state the program boundary in F§2.3/§7 explicitly, or add @types/node to F§2.3 for the packages whose tests read fixtures and serve stubs. | `docs/evidence/U-017.md` |
| `U-017 §7 [2]` | say which envelope a Piper service is expected to answer, and whether an entry may carry a display label and a language, so name/lang need … | `docs/evidence/U-017.md` |
| `U-017 §7 [3]` | state a floor (or a range) for Piper. | `docs/evidence/U-017.md` |
| `U-018 §7 [1]` | say in F§7.2 whether a bare array is normative, so a later hub that wants a revision or an etag beside the list knows it … | `docs/evidence/U-018.md` |
| `U-018 §7 [2]` | state whether a title with a url is refused with BAD_REQUEST or ignored. | `docs/evidence/U-018.md` |
| `U-018 §7 [3]` | name the layer that refuses a scheme (this is also how section 4's missing url format check should be read). | `docs/evidence/U-018.md` |
| `U-018 §7 [4]` | move the shared code union into the isomorphic entry (@lectern/core) and have both the parsers and the API contract import it. | `docs/evidence/U-018.md` |
| `U-018 §7 [5]` | either add the OCR fault to F§7.2's list or state in F§7.2 which of the thirteen an OCR engine failure is reported as. | `docs/evidence/U-018.md` |
| `U-018 §7 [6]` | set verifyDepsBeforeRun: false (or approve the build script) in the workspace configuration so a fixed command's output carries only its own result. | `docs/evidence/U-018.md` |
| `U-019 §7 [1]` | either name @types/node in this contract's *Installs* line (which would also let the test file into the program), or reword the file's description to "extends … | `docs/evidence/U-019.md` |
| `U-019 §7 [2]` | write "the first two characters of the id" in F§7.3, since the slice notation could equally be read as the first three. | `docs/evidence/U-019.md` |
| `U-019 §7 [3]` | state that order in F§7.3 (audio, then metadata) and that a reader treats a half-written entry as absent, so a later implementation that writes the … | `docs/evidence/U-019.md` |
| `U-019 §7 [4]` | add a status column to F§7.2's table, or state that a client switches on code and treats status as advisory. | `docs/evidence/U-019.md` |
| `U-019 §7 [5]` | say which version F§7.2 means, so a later bump does not leave two hubs answering different things. | `docs/evidence/U-019.md` |
| `U-019 §7 [6]` | state a voice-list refresh policy in F§6 or F§7.2 (a short time-to-live, or a resolution path that does not need the list), so the hub's … | `docs/evidence/U-019.md` |
| `U-019 §7 [7]` | name the limit that applies to a JSON route body (and to the later sync routes) in F§7.2. | `docs/evidence/U-019.md` |
| `U-019 §7 [8]` | set verifyDepsBeforeRun: false (or approve the build scripts) in the workspace configuration, as U-018's evidence proposed. | `docs/evidence/U-019.md` |
| `U-019 §7 [9]` | either pin @fastify/cors in F§2.3 (and choose a version outside the window), name minimumReleaseAge handling in the workspace configuration, or set verifyDepsBeforeRun … | `docs/evidence/U-019.md` |
| `U-020 §7 [1]` | add a status column to F§7.2's error table — or say that a parse's refusals are 422 while the hub's default for PARSE_FAILED stays 500 … | `docs/evidence/U-020.md` |
| `U-020 §7 [2]` | write that reading into F§7.2 — "a redirect is followed to a local address only when the URL the operator supplied already resolved there" — … | `docs/evidence/U-020.md` |
| `U-020 §7 [3]` | state that in F§7.2, and say whether the deadline covers a body that never finishes (this unit's does — the answer is FETCH_REFUSED at the … | `docs/evidence/U-020.md` |
| `U-020 §7 [4]` | either give parseDocument an optional title on its input (the smallest fix, and the one that would remove the stamp) or state in F§5.1/F§7.2 that … | `docs/evidence/U-020.md` |
| `U-020 §7 [5]` | name @types/node in the installs of the units that need it, or state the program boundary in F§2.3 the way U-006's patch stated skipLibCheck. | `docs/evidence/U-020.md` |
| `U-020 §7 [6]` | the same one U-018 and U-019 already made — approve the release, or set verifyDepsBeforeRun: false. | `docs/evidence/U-020.md` |
| `U-021 §7 [1]` | prefetchDocument's options are not specified. | `docs/evidence/U-021.md` |
| `U-021 §7 [2]` | The client does not clamp synthSpeed. | `docs/evidence/U-021.md` |
| `U-021 §7 [3]` | @lectern/server's exports map names a path that does not exist. | `docs/evidence/U-021.md` |
| `U-022 §7 [1]` | name ghcr.io/remsky/kokoro-fastapi-cpu:v0.3.0 (or any release before the object-shaped voice list) as the pinned image, because U-016's frozen adapter reads voice ids … | `docs/evidence/U-022.md` |
| `U-022 §7 [2]` | say so. | `docs/evidence/U-022.md` |
| `U-022 §7 [5]` | pdfjs-dist/* accompanies pdfjs-dist in esbuild's external list. | `docs/evidence/U-022.md` |
| `U-022 §7 [7]` | add LECTERN_TOKEN to turbo.json's globalEnv, or exempt scripts/ from the rule, so a script whose whole interface is the environment does not carry a warning. | `docs/evidence/U-022.md` |
| `U-022 §7 [8]` | make this unit's requirement the Docker check alone, or report phase 5's Docker check separately from the Android phase's. | `docs/evidence/U-022.md` |
| `U-023 §7 [4]` | Accept @types/node and repair the two frozen parser lines (docx.ts:107, ocr-tesseract.ts:143) in a U-009/U-010 patch unit. | `docs/evidence/U-023.md` |
| `U-023 §7 [5]` | The environment package is reachable only through pnpm's hoisted directory. | `docs/evidence/U-023.md` |
| `U-023 §7 [6]` | name it in the contract's install list so the dependency is explicit rather than a resolution side effect. | `docs/evidence/U-023.md` |
| `U-023 §7 [7]` | add those five rows to F§2.3. | `docs/evidence/U-023.md` |
| `U-023 §7 [8]` | The test list names only the buffering spinner while the file output names loading and buffering. | `docs/evidence/U-023.md` |
| `U-023 §7 [9]` | state it in F§10.1. | `docs/evidence/U-023.md` |
| `U-023 §7 [10]` | a later chore(spec) states it. | `docs/evidence/U-023.md` |
| `U-024 §7 [1]` | The harness exposes four window entry points, not two. | `docs/evidence/U-024.md` |
| `U-024 §7 [3]` | playwright.config.ts sets workers: 1 and fullyParallel: false — not in the contract, but the wall-time assertions are timing measurements and a second worker's browser would … | `docs/evidence/U-024.md` |
| `U-025 §7 [1]` | The reader's own stylesheet rules live in the module because styles.css is frozen. | `docs/evidence/U-025.md` |
| `U-025 §7 [2]` | target(rect, viewportHeight): number \| null does not say whether the number is a delta or an absolute scroll position. | `docs/evidence/U-025.md` |
| `U-025 §7 [3]` | The band is judged on the line's top edge, so target reads only rect.top; the parameter type is { top: number } so that a … | `docs/evidence/U-025.md` |
| `U-025 §7 [4]` | F§10.1's "pauses for 4 s after manual scrolling" is silent on how a programmatic scroll is told from a manual one, and on the web … | `docs/evidence/U-025.md` |
| `U-025 §7 [5]` | A click on furniture seeks nowhere. | `docs/evidence/U-025.md` |
| `U-025 §7 [6]` | The harness carries four reader entry points, not one. | `docs/evidence/U-025.md` |
| `U-025 §7 [7]` | The e2e spec carries a fourth case beyond the contract's three (each block kind as its element, and furniture dimmed or hidden), because "semantic elements … | `docs/evidence/U-025.md` |
| `U-026 §7 [1]` | F§5.9 name the field, or add a mime(key) accessor to BlobCache. | `docs/evidence/U-026.md` |
| `U-026 §7 [2]` | F§5.9 name that key space (or the layout gain a versions store) so a later store implementation cannot pick a different key. | `docs/evidence/U-026.md` |
| `U-027 §7 [3]` | say in F§10.1 that the check proves the token as well as the address. | `docs/evidence/U-027.md` |
| `U-027 §7 [4]` | state that ordering in F§10.1, so a later unit that needs services before a connection (the desktop shell applying its own settings) knows to register … | `docs/evidence/U-027.md` |
| `U-027 §7 [5]` | name that attribute in F§10.1's settings list, so the next platform that offers a theme (Android, F§10.4) uses the same name. | `docs/evidence/U-027.md` |
| `U-028 §7 [1]` | F§10.1's import entry points are described, not listed. | `docs/evidence/U-028.md` |
| `U-028 §7 [2]` | "A list may show progress from the counts in DocumentMeta; exact figures come from progressFraction with the model in hand." | `docs/evidence/U-028.md` |
| `U-028 §7 [3]` | "Deleting a folder moves its documents and its child folders to the folder's parent." | `docs/evidence/U-028.md` |
| `U-028 §7 [4]` | F§7.2's { url } form returns a document, not the page's bytes. | `docs/evidence/U-028.md` |
| `U-028 §7 [5]` | pnpm's supply-chain policy prints above every step of the fixed command. | `docs/evidence/U-028.md` |
| `U-029 §7 [1]` | F§10.3's BusSnapshot cannot serve the mini-player F§10.1 asks for. | `docs/evidence/U-029.md` |
| `U-029 §7 [2]` | state that panel handling is the view's own and not a player command. | `docs/evidence/U-029.md` |
| `U-030 §7 [1]` | F§10.1's page view has no zoom control, while the contract asks whether the reference product's highlight follows one. | `docs/evidence/U-030.md` |
| `U-030 §7 [2]` | apps/web/src/reader/pdf-anchors.ts exports one function beyond the three the contract names. | `docs/evidence/U-030.md` |
| `U-030 §7 [3]` | A sentence highlight cannot cover a page that is not drawn. | `docs/evidence/U-030.md` |
| `U-031 §7 [1]` | F§5.9 has no way to remove a setting. | `docs/evidence/U-031.md` |
| `U-031 §7 [2]` | sections.ts's own doc comment is now stale ("Empty in this unit"), and AGENTS.md §5 makes a registry append-only ("never rewrite existing lines"), so it was … | `docs/evidence/U-031.md` |
| `U-034 §7 [1]` | The offscreen document cannot read chrome.storage. | `docs/evidence/U-034.md` |
| `U-034 §7 [2]` | The service worker cannot send a message to itself, so the e2e's first message cannot originate in the worker; proposes relaying it from an extension page. | `docs/evidence/U-034.md` |
| `U-034 §7 [3]` | configure() cannot grant the hub origin in this rig. | `docs/evidence/U-034.md` |
| `U-034 §7 [5]` | A frozen file carries a defect this unit's work measured, and it was not touched (R6). | `docs/evidence/U-034.md` |
| `U-035 §7 [1]` | the contract's *Required File Outputs* line to read createHighlighter(textMap, document) — no other change. | `docs/evidence/U-035.md` |
| `U-035 §7 [3]` | What @lectern/ui-web supplies. | `docs/evidence/U-035.md` |
| `U-036 §7 [1]` | “Always mounted once reading starts” collides with U-035's frozen element count; proposes wording it “…and mounted the moment a reading is started from the widget.” | `docs/evidence/U-036.md` |
| `U-036 §7 [2]` | name the key in F§10.2's extension list, or add a widgetPositions field to the record. | `docs/evidence/U-036.md` |
| `U-036 §7 [3]` | add the two counts to the snapshot, or document a compact variant that takes neither. | `docs/evidence/U-036.md` |
| `U-036 §7 [4]` | U-035's §2 note on chrome.storage in a content script is contradicted by measurement. | `docs/evidence/U-036.md` |
| `U-037 §7 [1]` | one patched contract either removing U-035's ext/read-selection branch or moving the whole selection path into U-037's file. | `docs/evidence/U-037.md` |
| `U-037 §7 [3]` | a patched contract naming which unit owns the read-page binding. | `docs/evidence/U-037.md` |
| `U-037 §7 [4]` | assign the tab before relaying, or forward to the tab that sent the document. | `docs/evidence/U-037.md` |
| `U-037 §7 [5]` | a message that carries one, in a later contract. | `docs/evidence/U-037.md` |
| `U-037 §7 [6]` | name them in the contract, or record in features.md that the extension exposes them for end-to-end driving. | `docs/evidence/U-037.md` |
| `U-037 §7 [7]` | One F§10.2 wording (carried over from U-036, not acted on): the widget's mount rule is measured to add exactly one element to a page. | `docs/evidence/U-037.md` |
| `U-038 §7 [1]` | The renderer's own navigation is the only hand-off the suite can observe. | `docs/evidence/U-038.md` |
| `U-038 §7 [2]` | name apps/web/src/boot.ts under *Patch scope* for every unit whose output bullet says "registered in boot.ts", so the permission is stated where the edit is. | `docs/evidence/U-038.md` |
| `U-038 §7 [3]` | add docs/preflight.json to AGENTS.md §5's always-writable row, or make preflight.mjs skip the write when --phase output is unchanged. | `docs/evidence/U-038.md` |
| `U-038 §7 [4]` | DEFAULT_HOTKEYS leaves toggleMini and showMain unbound. | `docs/evidence/U-038.md` |
| `U-038 §7 [5]` | name the package in pnpm-workspace.yaml's minimumReleaseAgeExclude as an operator change, or give F§2.3 the toolchain versions the window permits, so the pre-script … | `docs/evidence/U-038.md` |
| `U-039 §7 [1]` | either a patch unit that makes the mini page prefer the bridge the way the reader does — which would retire the adapter — or … | `docs/evidence/U-039.md` |
| `U-039 §7 [2]` | exempt the #/mini route from that redirect in a patched contract, or accept it as the app's own rule. | `docs/evidence/U-039.md` |
| `U-039 §7 [3]` | showMain means "hide the strip" here. | `docs/evidence/U-039.md` |
| `U-040 §7 [1]` | word F§10.3's sentence as the mechanism ("the result arrives asynchronously when the surface reports it") or raise the pinned Electron to a version whose types … | `docs/evidence/U-040.md` |
| `U-040 §7 [2]` | publish the defaults and the status through @lectern/ui-web (or extend the bridge) so both ends read one table. | `docs/evidence/U-040.md` |
| `U-040 §7 [3]` | A late subscriber cannot ask for the current status. | `docs/evidence/U-040.md` |
| `U-040 §7 [4]` | toggleMini and showMain have no default accelerator in F§10.3's list, so they are stored as empty strings and read pending until the operator binds one; … | `docs/evidence/U-040.md` |
| `U-041 §7 [1]` | word F§10.3's row and the case as "the selection clipboard object, or the type parameter where the pinned Electron still takes one". | `docs/evidence/U-041.md` |
| `U-041 §7 [2]` | correct the bullet to lectern:read-text. | `docs/evidence/U-041.md` |
| `U-041 §7 [3]` | an idempotent show on DesktopWindows (or a showMini action) so "show" means show. | `docs/evidence/U-041.md` |
| `U-041 §7 [4]` | detectEnvironment has three answers and the shell can run on two platforms. | `docs/evidence/U-041.md` |
| `U-041 §7 [5]` | if the order ever puts a tool ahead of the shell's own clipboard on X11, that host's empty case reads EMPTY instead, and the wording … | `docs/evidence/U-041.md` |
| `U-041 §7 [6]` | run desktopIntegration unconditionally — it is inert without a bridge and needs no hub to subscribe — or move the subscription to a place that … | `docs/evidence/U-041.md` |
| `U-041 §7 [7]` | F§10.3 could give the read-text hand-off an acknowledgement (or the shell could wait for a renderer-ready signal) so a trigger that fires too early is … | `docs/evidence/U-041.md` |
| `U-042 §7 [1]` | give the preload config an input object ({ index: "src/preload/index.ts", overlay: "src/preload/overlay.ts" }) with build.isolatedEntries, which is what electron-vite's … | `docs/evidence/U-042.md` |
| `U-042 §7 [2]` | add "types": ["electron-vite/node"] to that tsconfig (a U-038 file this unit may not write), so every later unit that ships a file needs no per-file … | `docs/evidence/U-042.md` |
| `U-042 §7 [3]` | an idempotent showMini/hideMini pair on F§10.3's bus (or on DesktopWindows), the same request U-041's evidence already filed for this feature's neighbour. | `docs/evidence/U-042.md` |
| `U-042 §7 [5]` | if the config change in (1) is ever made, this file becomes an ordinary preload entry and can be written as typed ESM like src/preload/index.ts. | `docs/evidence/U-042.md` |
| `U-042 §7 [6]` | name the strip in the contract's case list, so a later unit can tell whether that branch is still covered. | `docs/evidence/U-042.md` |
| `U-043 §7 [1]` | F§10.3 and the contract say which folder is the shell's own, so a later unit can tell whether "the default" means "added to the record … | `docs/evidence/U-043.md` |
| `U-043 §7 [2]` | a removable (or source: 'operator' \| 'shell') field on the status entry, so the section renders what the shell says rather than re-deriving it. | `docs/evidence/U-043.md` |
| `U-043 §7 [3]` | the contract name the behaviour. | `docs/evidence/U-043.md` |
| `U-043 §7 [4]` | the library screen subscribe to the store (it already re-reads after every action), which would also make the screen honest for a document that arrives … | `docs/evidence/U-043.md` |
| `U-043 §7 [5]` | F§10.3's DesktopStatus carry the last hand-off's outcome (or a count of refused files per folder), which the settings section could show beside the folder's state. | `docs/evidence/U-043.md` |
| `U-045 §7 [1]` | The install step is the contract's, executed one level lower. | `docs/evidence/U-045.md` |
| `U-045 §7 [3]` | docs/preflight.json is rewritten by the first step of the fixed command and is not in AGENTS.md §5's always-writable set. | `docs/evidence/U-045.md` |
| `U-045 §7 [5]` | U-053's release audit should expect two extra declarations. | `docs/evidence/U-045.md` |
| `U-046 §7 [2]` | apps/android/src/diagnostics/checks.ts is U-045's file and is marked (registry) in U-045's contract, so this unit appends to it and rewrites nothing: one import line and one … | `docs/evidence/U-046.md` |
| `U-046 §7 [5]` | Repair 1: extend the frozen assertion to the registry's real contents (four ids), with Patch scope on U-045's selftest.test.ts. | `docs/evidence/U-046.md` |
| `U-046 §7 [7]` | (2) The platform modules are loaded when a driver or a cache is built, not when the module is imported. | `docs/evidence/U-046.md` |
| `U-047 §7 [2]` | createExpoQueueSink is asynchronous — the contract writes createExpoQueueSink({ maxRate }): AudioQueueSink, and the value it answers is one; the call itself is async … | `docs/evidence/U-047.md` |
| `U-048 §7 [1]` | F§10.4's reader paragraph ("updates are throttled to 20 Hz") and this contract's Forbidden Action ("Do not update highlight state more often than 20 times per … | `docs/evidence/U-048.md` |
| `U-049 §7 [1]` | npx expo install cannot install into this repository — the substitution U-045 measured and U-047 repeated: its bare pnpm add dies on the committed lockfile … | `docs/evidence/U-049.md` |
| `U-049 §7 [3]` | SUPPORTED_IMPORT_MIME_TYPES is a second copy of a list the repository already has. | `docs/evidence/U-049.md` |
| `U-050 §7 [1]` | A shared .html file is a file, not an address. | `docs/evidence/U-050.md` |
| `U-050 §7 [2]` | The install could not use npx expo install. | `docs/evidence/U-050.md` |
| `U-051 §7 [3]` | (b) Accept the blocking directive, as U-047's §7 proposed: drop the ! grep step and prove the microphone out of the *merged* manifest and the … | `docs/evidence/U-051.md` |
| `U-051 §7 [4]` | (c) Remove expo-image-picker from Installs and from scan-service.ts's fallback, leaving the scanner's own repeated invocation as the only capture path. | `docs/evidence/U-051.md` |
| `U-051 §7 [6]` | saveScan takes the page URIs as well as the page blocks. | `docs/evidence/U-051.md` |
| `U-051 §7 [7]` | A frozen file's comment now describes the old reader of an image action. | `docs/evidence/U-051.md` |
| `U-051 §7 [8]` | @react-native-ml-kit/text-recognition's Gradle build still targets the pre-0.71 React Native coordinate. | `docs/evidence/U-051.md` |
| `U-052 §7 [1]` | The contract's target and the inspection string name different targets. | `docs/evidence/U-052.md` |
| `U-052 §7 [2]` | dumpsys media_session cannot show the notification's own action buttons. | `docs/evidence/U-052.md` |
| `U-053 §7 [3]` | The device was not attached for this session's run, and this session is why. | `docs/evidence/U-053.md` |
| `U-054 §7 [1]` | F§8.3's auth message and "Do not put the token in any schema". | `docs/evidence/U-054.md` |
| `U-054 §7 [2]` | SummaryResultSchema is a builder. | `docs/evidence/U-054.md` |
| `U-055 §7 [1]` | @types/better-sqlite3 cannot enter this package's type program, so the hub declares the API it uses. | `docs/evidence/U-055.md` |
| `U-055 §7 [2]` | better-sqlite3 is 13.2.0, not F§2.3's 13.1.1. | `docs/evidence/U-055.md` |
| `U-055 §7 [3]` | applyOps(deviceId, ops)'s deviceId is the fallback stamp (§4). | `docs/evidence/U-055.md` |
| `U-055 §7 [4]` | The pull's cursor is ascending-by-latest-rev (§3), and nextRev is the page's last rev. | `docs/evidence/U-055.md` |
| `U-055 §7 [5]` | A malformed document id answers BAD_REQUEST. | `docs/evidence/U-055.md` |
| `U-056 §7 [1]` | The library routes' answer shape is not specified, so the PUTs answer 204 and a model is served as application/gzip. | `docs/evidence/U-056.md` |
| `U-056 §7 [2]` | The upload ceiling is min(U-054's limit, LECTERN_MAX_UPLOAD_MB). | `docs/evidence/U-056.md` |
| `U-056 §7 [3]` | A winning delete's files are removed inside the request, after the transaction. | `docs/evidence/U-056.md` |
| `U-056 §7 [4]` | The pull query's values are converted from text. | `docs/evidence/U-056.md` |
| `U-056 §7 [5]` | A malformed document id is BAD_REQUEST (§4), the same code U-055's document files answer with. | `docs/evidence/U-056.md` |
| `U-057 §7 [1]` | The close code for a socket that stopped answering pings is 4408. | `docs/evidence/U-057.md` |
| `U-057 §7 [3]` | “Two unanswered pings” is counted before the next ping; proposes letting two full intervals elapse first. | `docs/evidence/U-057.md` |
| `U-057 §7 [5]` | The plugin is reached through a string-typed dynamic import (§4), because a static import re-breaks the two frozen packages/core parser lines and no writable file … | `docs/evidence/U-057.md` |
| `U-057 §7 [6]` | pnpm --filter @lectern/server run build names a script this package does not have (§2, §6.1). | `docs/evidence/U-057.md` |
| `U-058 §7 [1]` | packages/api-client/src/testing/fastify-fetch.ts cannot carry a null-body status. | `docs/evidence/U-058.md` |
| `U-058 §7 [2]` | move gzip/gunzip out of the engine's option list, or say what the engine is expected to compress. | `docs/evidence/U-058.md` |
| `U-058 §7 [3]` | a store method that writes a model without queuing, or an explicit statement that this re-queue is intended. | `docs/evidence/U-058.md` |
| `U-058 §7 [4]` | say whether pending may be capped at one push (200) instead. | `docs/evidence/U-058.md` |
| `U-059 §7 [1]` | A device that holds documents does not adopt the hub's older records (§3.3). | `docs/evidence/U-059.md` |
| `U-059 §7 [3]` | The library screen is frozen, so "appears in B's library" is observed by re-entering the route. | `docs/evidence/U-059.md` |
| `U-060 §7 [1]` | saved had to be optional on ext/snapshot. | `docs/evidence/U-060.md` |
| `U-060 §7 [2]` | The widget talks to the extension itself. | `docs/evidence/U-060.md` |
| `U-060 §7 [3]` | The worker refuses a save it is not asked to answer. | `docs/evidence/U-060.md` |
| `U-060 §7 [4]` | The private-window rule is enforced in the widget. | `docs/evidence/U-060.md` |
| `U-061 §7 [2]` | The switch's home (the secure store, §4) is a design decision this unit made rather than a place the contract names. | `docs/evidence/U-061.md` |
| `U-062 §7 [1]` | FORCE_INVALID_ONCE should key off its marker, not the exact message, because F§9's retry appends the validation error to that same message. | `docs/evidence/U-062.md` |
| `U-062 §7 [2]` | add both to F§9's adapter line. | `docs/evidence/U-062.md` |
| `U-062 §7 [4]` | HubOverrides.llm is an addition the patch note does not spell out. | `docs/evidence/U-062.md` |
| `U-062 §7 [5]` | The map/reduce classification is made from the prompt's own text. | `docs/evidence/U-062.md` |
| `U-063 §7 [1]` | name the fourth parameter in the contract. | `docs/evidence/U-063.md` |
| `U-063 §7 [2]` | state which of the two the modes apply to. | `docs/evidence/U-063.md` |
| `U-063 §7 [3]` | say whether a disabled hub still reports a stored state. | `docs/evidence/U-063.md` |
| `U-063 §7 [4]` | confirm that reading. | `docs/evidence/U-063.md` |
| `U-063 §7 [5]` | say whether provenance should be recorded while pending. | `docs/evidence/U-063.md` |
| `U-063 §7 [6]` | note that a registry's array literal may be re-wrapped to satisfy the formatter. | `docs/evidence/U-063.md` |
| `U-064 §7 [1]` | ReaderPage.tsx needed one condition beyond "gains a 'Summarize' button" (measured in §6.4). | `docs/evidence/U-064.md` |
| `U-064 §7 [2]` | @lectern/ui-web gains @lectern/api-contract. | `docs/evidence/U-064.md` |
| `U-064 §7 [3]` | ErrorBodySchema.shape.error cannot carry an F§9 code. | `docs/evidence/U-064.md` |
| `U-066 §7 [1]` | infra/Dockerfile is not in this unit's *Patch scope*, and the image ships only the server bundle. | `docs/evidence/U-066.md` |
| `U-066 §7 [2]` | expose it where it belongs — add backup(destination: string): Promise<{ totalPages: number; remainingPages: number }> to HubDatabase, or a snapshotTo(path: string) … | `docs/evidence/U-066.md` |
| `U-066 §7 [3]` | infra/.env.example already carried the commented LLM_* lines. | `docs/evidence/U-066.md` |
| `U-066 §7 [4]` | say which file's timestamp decides. | `docs/evidence/U-066.md` |
| `U-066 §7 [5]` | state that any other value means no. | `docs/evidence/U-066.md` |
| `U-066 §7 [6]` | if a unit ever needs a deterministic manifest, name a clock seam in context.ts's overrides. | `docs/evidence/U-066.md` |
| `U-066 §7 [7]` | say beside the bundle, in the operations document or in build.mjs, that the server bundle is an image artifact and that a checkout runs the … | `docs/evidence/U-066.md` |
| `U-067 §7 [1]` | add - \docs/release-check.json\ to *Required File Outputs* (or to a Patch scope: bullet) so the artifact may stay in the tree the fixed command generates … | `docs/evidence/U-067.md` |
| `U-067 §7 [2]` | A root script's access to the workspace's TypeScript sources is a design decision worth ratifying. | `docs/evidence/U-067.md` |
| `U-067 §7 [3]` | The rehearsal's mirror is the recipe this unit used for a root script, and it is worth keeping. | `docs/evidence/U-067.md` |
| `U-067 §7 [4]` | The 204-vs-Response boundary is U-021's, and this unit only works around it. | `docs/evidence/U-067.md` |
| `U-067 §7 [5]` | No REA call was made, and none could be. | `docs/evidence/U-067.md` |

## 5. The manual checklists, and the on-device summary flow

### `docs/desktop-windows-build.md` — the Windows steps and their ten manual checks

**Recorded state: `UNKNOWN` — not run.** The document is the operator's Windows procedure, and no Windows machine
is part of this host: `targets/desktop-win/` (AGENTS.md §3.1's `T-WIN`, the reference Windows package) is absent,
and no Windows build has ever been produced here. The ledger's own U-044 row says the same thing — *"**windows:
unverified** (the Windows steps have not been run on Windows)"* — and every one of the ten checks in that
document is a line a person must run *on the machine that installed the build*:

| # | Check (as the document names it) | Recorded state |
|---|---|---|
| 1 | Install (per-user, no UAC, Start-menu entry) | `UNKNOWN` — needs Windows |
| 2 | Launch and reload (X hides to tray, `showMain` brings it back) | `UNKNOWN` — needs Windows |
| 3 | Read selection — browser (`Ctrl+Alt+R`) | `UNKNOWN` — needs Windows |
| 4 | Read selection — text editor, clipboard restored | `UNKNOWN` — needs Windows (clipboard round trip) |
| 5 | Screen region (`Ctrl+Alt+S`, `Esc` cancels) | `UNKNOWN` — needs Windows |
| 6 | Each default hotkey, shown as *registered* | `UNKNOWN` — needs Windows |
| 7 | Mini-player (frameless strip, remembered position) | `UNKNOWN` — needs Windows |
| 8 | Watched folder (`%USERPROFILE%\Lectern\Inbox`) | `UNKNOWN` — needs Windows |
| 9 | Tray (play/pause, next/previous, show/hide, quit) | `UNKNOWN` — needs Windows |
| 10 | Uninstall (no elevation, user data left alone) | `UNKNOWN` — needs Windows |

What *is* verified on this host is the **Linux** half of the same application, and it is not a substitute for the
rows above: `node scripts/release-check.mjs`'s `desktop-build` step builds it, `desktop-e2e` drives the built
shell under `xvfb-run` (19 cases: the shell's own page and sandbox, the tray and mini-player, selection capture,
region capture, the watched folder, the packaged application out of `app.asar`), and `dist:linux` produced the
AppImage and the `.deb` in U-044's own session. The Windows-specific mechanisms — the clipboard round trip, the
NSIS installer, the `%USERPROFILE%` folder, the tray's Windows behaviour — are exactly the parts no Linux run can
reach.

### `docs/android-manual-checks.md` — the seven checks, and which half is machine-observable

**Recorded state: the human halves were not performed; the machine-observable halves were run in this unit's
earlier session.** The document's own
framing is the state to record faithfully: `apps/android/scripts/device/run-all.sh` and `verify-offline.sh` drive
the app through `adb` and read the platform's own answers, so they cover what a machine can observe — the
on-device conformance suites, a share intent reaching the app, the media session's state, offline playback with
the hub stopped — and *"the list below is what is left — the checks that need a person's hands, eyes and ears, a
second app, or a call to arrive"*.

| # | Check | Machine half (this unit's earlier session) | Human half (recorded state) |
|---|---|---|---|
| 1 | Scan a three-page printed document and listen | On-device conformance rows — see the device run in §0 | `UNKNOWN` — needs printed pages and a camera in hand |
| 2 | Share a web page from the browser | `verify-share-intent.sh` (part of `run-all.sh`) | `UNKNOWN` — needs a browser share sheet |
| 3 | Share a PDF from a file manager | — | `UNKNOWN` — needs a file manager and a PDF |
| 4 | Lock-screen controls on a physical device | `verify-media-session.sh` (the session's state and its published sentence) | `UNKNOWN` — needs a person at the lock screen |
| 5 | Headset button play/pause | — | `UNKNOWN` — needs a headset with a button |
| 6 | An incoming call pauses playback | — | `UNKNOWN` — needs a call to arrive |
| 7 | Playback at 4.5× | the media-session script's own state readings; the Android host suite's speed cases | `UNKNOWN` — the *audible* claim (pitch preserved) needs ears |

Two further device checks live in the harness rather than in that document, and both ran in this unit's earlier
session as part of `node scripts/release-check.mjs --device` (the closing session requested no device steps): `verify-offline.sh` (a document downloaded for offline use is read
with the hub stopped) and `verify-sync.sh` (F§8's round trip from the device's own side — a document pushed by
another device appears in the library, and the app's own `sync-roundtrip` row reports `PASS`).

### The on-device summary flow (U-065's manual check)

U-065's contract ends *"The on-device summary flow is a manual check recorded in U-067's report"*, so it is
recorded here. **Recorded state: PERFORMED in this unit's earlier session on the physical device** (the closing
session requested no device steps) — the raw screen dumps and
screenshots are kept under `data/device-run/summary/` (gitignored runtime data) and quoted in the evidence file's
§6.6.

**What was observed, in order.** The document was planted on the hub *by another device* (the harness's own
`push-document.mjs`), so the library row the phone drew was a synced record rather than a local import; it
appeared in the library as `A probe document pushed from another device.` with `0% read · 113 words`. Opening it
brought up the reader on the document with its player bar (`0:40`, `0%`, `1×`, `Mock A`, `Sleep`) and — U-065's
patch — the **Summarize** control. Pressing it opened the summary screen, which drew its explanation, the
`Brief`/`Detailed` switch, the state it had just read from the hub (`There is no summary of this document yet.`)
and its own **Summarize** button. Pressing that produced the running state and then, within three seconds, the
finished result: the summary paragraph, **five numbered takeaways** (1–5) and **`Written by
u067-on-device-model`**. Pressing **Listen to summary** filed the summary and opened the reader on it: the screen
read `Summary of A probe document pushed from another device.` with the summary and its five bullet items, and the
player bar showed **`0:03` / `87%`** — the summary was being read aloud, which the hub's own log confirms with
`POST /v1/tts` and its chunk downloads. The hub's log also carries three `GET
/v1/ai/summary/<docId>?mode=brief` calls: the screen's read when it opened, the request, and the poll that found
it done.

**Where the raw record is.** The screen dumps and screenshots this paragraph rests on are kept under
`data/device-run/summary/` (gitignored runtime data): `01-library.png`, `02-reader.png`, `11-summary-screen.png`,
`12-running.png`, `13-summary-done.png` with `13-summary-done.xml`, and `14-after-listen.png` with
`14-after-listen.xml`. The hub and the mock endpoint that served it ran in `data/device-run/summary/` too, on the
harness's own port 8787 and token, with `adb reverse tcp:8787 tcp:8787` in place — the same path the device run
in §0 uses.

**Two facts about the phone this check confirms**, beyond the summary itself: the app *reaches the hub from the
device* (the sync pull that brought the record, the model fetch that opened the reader, the summary job's three
reads) and its **audio really plays** through the platform's own sink (the 87 % progress and the chunk downloads
in the hub's log), which U-047's own diagnostics row and U-052's closing run both measured before.

## 6. F§14's known limits

| Risk | Mitigation |
|---|---|
| Kokoro word timestamps cover only some languages. | Estimated timings (F§5.6a); sentence boundaries stay exact. |
| Pitch-preserved playback above ~3× depends on the platform time-stretcher. | `planSpeed` moves part of the speed-up into synthesis when the sink's maximum is lower. |
| Abbreviation at a true sentence end does not split. | Accepted; affects pause placement only. |
| Windows selection capture briefly replaces the clipboard. | Saved and restored; documented in settings. |
| Wayland hotkeys require portal consent and may be refused. | The settings screen shows the `registration-resolved` result per shortcut. |
| `expo-sharing` receive is marked experimental. | Isolated in U-050; fallback is the in-app picker. |
| Android 17 restricts background audio to user-initiated foreground services. | Playback starts only from user action; verified in U-052. |
| ML Kit document scanner needs Google Play services. | Devices without it get a single-photo capture path (U-051). |
| Tesseract accuracy on photos is lower than ML Kit. | Desktop region OCR captures screen pixels, which OCR well. |
| Reference product changes or is unavailable for inspection. | Inspection is advisory; every contract is buildable from this file alone. |

## 7. What U-067 found, and what it proposes

This unit may not change application or package source — its *Forbidden Actions* say *"A failing check is
reported, not fixed here"* — so what follows is reported, measured, and left for the operator. The blocked
session's diff touched `scripts/e2e-cross-device.mjs`, `scripts/release-check.mjs`, `docs/parity-report.md`,
`README.md`, `docs/evidence/U-067.md` and `docs/status.md`; the closing session that closed §7.1 touched only
`docs/parity-report.md`, `docs/evidence/U-067.md` and `docs/status.md`.

### 7.1 The desktop end-to-end suite could not pass as a single run (closed 2026-11-18 by `2f57cac`)

**Measured (blocked session).** `pnpm --filter @lectern/desktop exec playwright test` failed 2 cases:

| Case | Assertion | Measured |
|---|---|---|
| `e2e/region.spec.ts:275` — "Esc cancels the selection: nothing is captured, and no document is created" | `expect(rows).toHaveLength(1)` (line 301) | received **2** rows: `Region probe`, `Harbour Light` |
| `e2e/selection.spec.ts:134` — "the selection is read, played and filed in Quick reads" | `expect(documents).toHaveCount(1)` (line 156) | received **3** rows |

Four full-suite runs were measured in the blocked session, and those two cases failed in **all four**:

| Run | Result |
|---|---|
| 1 — the session's own baseline pass of the contract's steps | 2 failed, 17 passed (2.1 m) |
| 2 — the core `node scripts/release-check.mjs` run | 2 failed, 17 passed (1.8 m) |
| 3 — the official fixed command's own run | **3 failed**, 16 passed (2.7 m) — the two above plus `e2e/region.spec.ts:310` ("the mini-player is out of the frame while a region is being selected, and back afterwards") |
| 4 — a re-run to classify run 3's extra case | 2 failed, 17 passed (1.8 m) |

So the two exact-count assertions are the deterministic defect (4 of 4 runs); `region.spec.ts:310` failed once in
four and is the third case to watch, most likely the same pollution plus a window-order race.

**Mechanism.** One Playwright run shares one hub (`apps/desktop/e2e/global-setup.ts` starts it once for the whole
run), and each case gets a fresh user-data directory (`launchApp()`), so a document imported in one case is
pushed to the hub by F§8's sync and pulled into the *next* case's library. The failing assertions demand an exact
library size, so any earlier case's document breaks them — `mini.spec.ts`'s own fixture is `Harbour Light`, which
is the extra row the region case sees. Both spec files date from U-044 (last touched in `130a7a7`); `apps/web`'s
sync wiring landed later, in U-059 (`d8f90ea`), which is what changed the behaviour they assume.

**Isolated and reproduced.** `region.spec.ts` alone: **3 passed**. `selection.spec.ts` alone: **2 passed**.
`playwright test e2e/mini.spec.ts e2e/region.spec.ts` — two files, in that order, one run: **1 failed, 6 passed**
in 37 s. Two full-suite runs failed the identical two cases (17 passed, 1.8 m each). A store left over on disk is
ruled out: a globally shared library would make `selection.spec.ts` fail on its own, and it does not.

**Proposed repairs** (either closed it; the operator landed (a)):

- **(a) Assert the *change*, not the absolute count.** In `region.spec.ts`'s Esc case, take the row list before
  the Esc and require the same list after it (and that the new document's title never appears); in
  `selection.spec.ts`, scope the count to the documents the case created — e.g. `rows.filter((row) => row.title
  === TITLE)` — instead of the whole library. Both are strengthenings: they keep asserting what the case is
  about (nothing was captured / the selection became exactly one document) while dropping the assumption that the
  run's hub holds nobody else's records.
- **(b) Give each spec file its own hub.** Playwright runs `globalSetup` once per run, so this means a fixture
  that starts a hub per file (or a `beforeAll` that empties the run's hub through its own API, which does not
  exist today). It restores per-case isolation at the cost of a hub per file.

Until one lands, the release check's `desktop-e2e` step is a `FAIL`, and U-067's fixed command therefore exits 1
— which is why this unit's ledger row is `BLOCKED` rather than `DONE`.

**Closed.** The operator's `chore(spec)` `2f57cac` lands repair (a) in both files — a four-line change scoping each
case's count to the document the case itself creates. Measured afterwards in the closing session: the suite alone
**19 passed (1.5m)**, and `desktop-e2e` exited 0 inside the release check in *both* of that session's runs of the
chain (`exit 0 in 86.9s` and `exit 0 in 89.2s`). The step is a `PASS` in §1, and the contract's fixed command exits
**0**. The blockage measurement above stays as the record of what the defect was.

### 7.2 The web suite's PDF-highlight case is timing-sensitive (intermittent, about one run in ten)

**Measured.** `e2e/pdf-view.spec.ts:245` — "the word being read is painted on the page's own text layer, and only
nearby pages are drawn" — failed once inside a full run (24 passed) with
`expect(painted).toBe(wordAt(model, written))`: expected `"lighthouse"`, received `"A"`. The same case, run alone
ten times, failed once more. Across the blocked session: **2 failures in roughly 15 executions of the case** (and three
full web runs, one of which was the failing one, plus two clean re-runs).

**Mechanism (inferred from the assertion).** The case plays at 4.5×, presses Pause, then reads the painted
highlight and the stored `progress` record and requires them to agree. F§5.9's progress write is throttled while
audio moves (at most once every 2 s) and written once when the player settles; the painted word comes from the
20 Hz reader sample. At 4.5× a single settle can therefore leave the persisted record a sentence behind the
highlight — or ahead of it — and the case's own comment ("pausing settles the position at once, so the word the
player reports and the word painted are read from the same instant") is the assumption that intermittently fails.

**Proposed repairs** (the operator's call; this unit may not touch the case or the writer):

- Have the case read the two facts in one settled instant: after the Pause, wait for the stored record's position
  to be stable across two reads (or poll until the highlight stops changing) before comparing them.
- Or assert the weaker, still-meaningful claim: the painted word is *within* the sentence the record names.
- If the persisted record is the side that is late, the repair belongs in the reader (write once on settle before
  the pause resolves) — which is application source, and a later unit's job.

A release gate that fails one run in ten is worth fixing before the operator trusts it; it did not stop U-067's
other steps from being green, and the run that produced this report's record passed the web suite.

**Re-measured in the closing session (2026-11-18).** The case flaked again, and this time it is why the contract's
fixed command needed a second attempt: attempt 1 exited 1 with `web-e2e` failing (`exit 1 in 76.1s`, its other 24
cases passing) at `expect(painted).toBe(wordAt(model, written))` — the same assertion and the same mechanism — and
attempt 2, with no file changed between them, exited 0 with `web-e2e` green in 75.1 s. Counting both sessions, the
case has now failed in 3 of roughly 17 executions. The repairs above are unchanged and still the operator's call;
this unit reports it and touches neither the case, nor the reader, nor the writer.

### 7.3 `docs/release-check.json` is a generated artifact the scope gate does not carry

The contract's own *Required File Outputs* prose says `scripts/release-check.mjs` writes
`docs/release-check.json`, the fixed command's fourth step requires the file, and this report is specified to
quote it — but the file is not one of the contract's output bullets, so `node scripts/check-scope.mjs U-067`
reports it as out of scope while it exists (measured: exit 1, "1 changed path(s) outside this unit's scope").
AGENTS.md §5's remedy for an out-of-scope change is to revert it, so the run writes and reads the file inside the
fixed command and the file is removed from the tree afterwards — the same shape as the device harness's own run
data under the gitignored `data/device-run/`. **Proposed patch:** list `docs/release-check.json` under *Required
File Outputs* (or a `Patch scope:`) so the artifact may stay where the fixed command generates it.

**Re-measured in the closing session:** with the file in the tree, `node scripts/check-scope.mjs U-067` exits 1 —
`1 changed path(s) outside this unit's scope → docs/release-check.json` — and exits 0 once the file is removed. The
run's *own* `guard-scope` step passes either way, because `release-check.mjs` writes the record only after every step
has been tried (its line 411), which is also why the closing session removed the file the chain had generated before
running the standing gates.

### 7.4 What U-067 did not exercise, and why

- **Seven steps `SKIPPED` with their reason** in the record the fixed command reads: the four device steps
  (*"not requested (pass --device)"*) and the three compose steps (*"not requested (pass --docker)"*). The closing
  session requested neither flag and ran no device or compose command; both sets were exercised in this unit's
  earlier session with `--device --docker`, and that run's own record is quoted in §0.
- **The Windows manual checks** (§5) — no Windows host exists here.
- **The human halves of the Android manual checks** (§5) — no hands, headset, call or printed pages were
  available; the machine-observable halves ran on the physical device in this unit's earlier session.
- **Every inspection** — 35 of the 68 units recorded `Inspection: UNAVAILABLE` and 33 `N/A`; none is `DONE`, and
  this unit made no REA call in either session (§3). The parity above is therefore evidence about Lectern's own
  behaviour, never about the reference product's.

