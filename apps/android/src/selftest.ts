/**
 * The core self-test (F§5.2, F§5.3, F§5.6), as the values this platform's JavaScript engine must reproduce.
 *
 * The goldens in `features.md` are pinned for the whole project, and a device is the one place where a
 * different engine could quietly disagree with them: Hermes ships its own Unicode tables, its own number
 * formatting and its own `String.prototype` implementations, and the document identity (F§5.2) is a SHA-256
 * over text. So the Android app carries the goldens as assertions and runs them on the device — the
 * diagnostics screen's `core-selftest` check — as well as under Node in this package's test run.
 *
 * The module is deliberately pure: it imports `@lectern/core` and nothing else, so it runs in a Node
 * environment, on Hermes, and inside the diagnostics screen without a device service in reach.
 */

import { docIdFor, estimateTimings, findActiveWord, planSpeed, splitSentences } from "@lectern/core";

/** One case's outcome, as the diagnostics screen lists it. */
export interface SelfTestCase {
  /** The golden's name — which section it comes from and what it measures. */
  name: string;
  /** Whether the device's own result equals the committed value. */
  ok: boolean;
}

/** F§5.2's golden `docId` for the single block `Hello, world.`. */
export const DOC_ID_ONE_BLOCK = "f8c3bf62a9aa3e6fc1619c250e48abe7";

/** F§5.2's golden `docId` for the blocks `Title` and `Hello, world. Second sentence here.`. */
export const DOC_ID_TWO_BLOCKS = "684c0459dd47803dec1ee32224195049";

/** A sentence list compared as text, so a failure reports what the engine produced rather than an index. */
function sentenceTexts(blockText: string): string[] {
  return splitSentences(blockText).map((sentence) => sentence.text);
}

/** Whether a block tokenizes into exactly the expected sentences (F§5.3). */
function sentencesAre(blockText: string, expected: readonly string[]): boolean {
  const actual = sentenceTexts(blockText);
  if (actual.length !== expected.length) return false;
  return expected.every((sentence, index) => actual[index] === sentence);
}

/** F§5.6(a)'s golden timing pair, written out so a failure can print both sides. */
const GOLDEN_TIMINGS = [
  { i: 0, s: 0, e: 333 },
  { i: 1, s: 467, e: 800 },
];

/** Whether two timing lists are the same list, field by field. */
function timingsAre(
  actual: readonly { i: number; s: number; e: number }[],
  expected: readonly { i: number; s: number; e: number }[],
): boolean {
  if (actual.length !== expected.length) return false;
  return expected.every((timing, index) => {
    const other = actual[index];
    return other !== undefined && other.i === timing.i && other.s === timing.s && other.e === timing.e;
  });
}

/** Whether F§5.6(e)'s plan for one rate pair is the golden triple. */
function planIs(rate: number, sinkMaxRate: number, expected: readonly [number, number, number]): boolean {
  const plan = planSpeed(rate, sinkMaxRate);
  return plan.synthSpeed === expected[0] && plan.sinkRate === expected[1] && plan.effectiveRate === expected[2];
}

/** One named assertion. A case that throws is a failed case, never an exception out of the self-test. */
interface SelfTestAssertion {
  name: string;
  check: () => boolean;
}

const ASSERTIONS: readonly SelfTestAssertion[] = [
  // F§5.2 — normalization and identifiers.
  { name: "F§5.2 docId of one block", check: () => docIdFor(["Hello, world."]) === DOC_ID_ONE_BLOCK },
  {
    name: "F§5.2 docId of two blocks",
    check: () => docIdFor(["Title", "Hello, world. Second sentence here."]) === DOC_ID_TWO_BLOCKS,
  },

  // F§5.3 — the tokenizer's six golden cases, verbatim from the table.
  {
    name: "F§5.3 abbreviations and decimals",
    check: () =>
      sentencesAre("Dr. Smith went to Washington. He arrived at 3.15 p.m. on Jan. 5.", [
        "Dr. Smith went to Washington.",
        "He arrived at 3.15 p.m. on Jan. 5.",
      ]),
  },
  {
    name: "F§5.3 case citations",
    check: () =>
      sentencesAre("In Roe v. Wade, 410 U.S. 113 (1973), the Court ruled. See id. at 115.", [
        "In Roe v. Wade, 410 U.S. 113 (1973), the Court ruled.",
        "See id. at 115.",
      ]),
  },
  { name: "F§5.3 punctuation runs", check: () => sentencesAre("Wait... what? Yes!", ["Wait... what?", "Yes!"]) },
  {
    name: "F§5.3 closers after a terminator",
    check: () => sentencesAre('She said, "Stop." Then she left.', ['She said, "Stop."', "Then she left."]),
  },
  { name: "F§5.3 initials", check: () => sentencesAre("J. K. Rowling wrote it.", ["J. K. Rowling wrote it."]) },
  {
    name: "F§5.3 exact-case abbreviation set",
    check: () => sentencesAre("Open the app. Then read Art. 5 aloud.", ["Open the app.", "Then read Art. 5 aloud."]),
  },

  // F§5.6(a) — estimated timings from a chunk's own duration.
  {
    name: "F§5.6(a) estimated timings",
    check: () => timingsAre(estimateTimings(["Hello,", "world."], 1000), GOLDEN_TIMINGS),
  },

  // F§5.6(c) — the active word for a media time.
  { name: "F§5.6(c) active word at 400 ms", check: () => findActiveWord(GOLDEN_TIMINGS, 400) === 0 },
  { name: "F§5.6(c) active word at 467 ms", check: () => findActiveWord(GOLDEN_TIMINGS, 467) === 1 },
  { name: "F§5.6(c) active word before the start", check: () => findActiveWord(GOLDEN_TIMINGS, -5) === 0 },
  { name: "F§5.6(c) active word past the end", check: () => findActiveWord(GOLDEN_TIMINGS, 9999) === 1 },

  // F§5.6(e) — the speed plan, all five goldens.
  { name: "F§5.6(e) plan (1.5, 16)", check: () => planIs(1.5, 16, [1, 1.5, 1.5]) },
  { name: "F§5.6(e) plan (4.5, 2)", check: () => planIs(4.5, 2, [2.25, 2, 4.5]) },
  { name: "F§5.6(e) plan (5.0, 2)", check: () => planIs(5, 2, [2.5, 2, 5]) },
  { name: "F§5.6(e) plan (3.0, 2)", check: () => planIs(3, 2, [1.5, 2, 3]) },
  { name: "F§5.6(e) plan (5.0, 1)", check: () => planIs(5, 1, [4, 1, 4]) },
];

/**
 * `runCoreSelfTest()` — every golden, run against the engine this code is executing on. A case that throws
 * (an engine whose SHA-256 rejects the input, a tokenizer that overflows) reports `ok: false` with its name,
 * so the diagnostics screen can list it like any other failure instead of losing the run to one exception.
 */
export function runCoreSelfTest(): SelfTestCase[] {
  return ASSERTIONS.map(({ name, check }) => {
    try {
      return { name, ok: check() };
    } catch {
      return { name, ok: false };
    }
  });
}
