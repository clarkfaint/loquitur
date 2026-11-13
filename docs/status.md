# Lectern — unit status ledger

`spec.md` defines 68 Unit Contracts. This file is the ledger for them: one row per unit, appended in unit order and never rewritten. `DONE` means the unit's Pass/Fail Verification Test ran in that session, exited 0, and its evidence file is committed. `BLOCKED` means three fix attempts failed, so the failing command and its output are recorded in the note and in the unit's evidence file. Exactly one unit is executed per session, and the next unit is always the lowest-numbered one that is not `DONE`.

| Unit | Status | Date | Commit | Note |
| --- | --- | --- | --- | --- |
| U-000 | DONE | 2026-11-13 | 810df0e | Preflight script, ledgers and probe files; phase-1 checks pass; no inspection targets present (advisory only) |
