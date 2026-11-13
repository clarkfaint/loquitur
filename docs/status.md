# Lectern — unit status ledger

`spec.md` defines 68 Unit Contracts. This file is the ledger for them: one row per unit, appended in unit order and never rewritten. `DONE` means the unit's Pass/Fail Verification Test ran in that session, exited 0, and its evidence file is committed. `BLOCKED` means three fix attempts failed, so the failing command and its output are recorded in the note and in the unit's evidence file. Exactly one unit is executed per session, and the next unit is always the lowest-numbered one that is not `DONE`.

| Unit | Status | Date | Commit | Note |
| --- | --- | --- | --- | --- |
| U-000 | DONE | 2026-11-13 | 810df0e | Preflight script, ledgers and probe files; phase-1 checks pass; no inspection targets present (advisory only) |
| U-001 | BLOCKED | 2026-11-13 | ec1a29c | `node --test scripts/__tests__/` — Node 24.22.3 resolves the directory argument with its own glob and hands the directory to a child process as its entry module (MODULE_NOT_FOUND); needs the glob form or a listed tests-directory manifest |
