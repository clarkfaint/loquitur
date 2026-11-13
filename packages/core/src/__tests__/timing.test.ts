/**
 * F§5.6's timing math, on inputs written for this test. The golden values of (a) and the four lookups of
 * (c) are the architecture brief's own, verbatim; each alignment case below pins one rule of (b).
 */

import { expect, test } from "vitest";
import { alignEngineTimings, estimateTimings, findActiveWord } from "../timing";

/** F§5.6(a)'s golden words. */
const GOLDEN_WORDS: readonly string[] = ["Hello,", "world."];

/** F§5.6(a)'s golden timings for 1000 ms, and (c)'s table is read off them. */
const GOLDEN_TIMINGS = [
  { i: 0, s: 0, e: 333 },
  { i: 1, s: 467, e: 800 },
];

/** A deterministic source, so the 200-sample invariant run is reproducible. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** A word of 1–8 letters: no punctuation, so `norm` is the word itself. */
function randomWord(random: () => number): string {
  const length = 1 + Math.floor(random() * 8);
  let word = "";
  for (let index = 0; index < length; index += 1) word += LETTERS.charAt(Math.floor(random() * LETTERS.length));
  return word;
}

test("F§5.6(a) golden — estimateTimings(['Hello,', 'world.'], 1000)", () => {
  expect(estimateTimings(GOLDEN_WORDS, 1000)).toEqual(GOLDEN_TIMINGS);
});

test("estimateTimings gives a sentence-final word the pause a comma does not get", () => {
  // Weights 1, 4, 1 of 6: each bare word speaks for 150 ms, and `b.` speaks 150 ms and then holds the
  // chunk through its own three-weight pause, so the next word only starts at 750 ms.
  expect(estimateTimings(["a", "b.", "c"], 900)).toEqual([
    { i: 0, s: 0, e: 150 },
    { i: 1, s: 150, e: 300 },
    { i: 2, s: 750, e: 900 },
  ]);
});

test("estimateTimings reads a mark past its closers and counts a word of punctuation as one letter", () => {
  // `"Stop."` is four letters and a sentence mark: 4 of its 7 weights are spoken, the rest is the pause.
  expect(estimateTimings(['"Stop."'], 300)).toEqual([{ i: 0, s: 0, e: 171 }]);
  // `—` has no letter or digit, so `alnum` floors at 1, and it ends a clause: 1 of 3 weights is spoken.
  expect(estimateTimings(["—"], 500)).toEqual([{ i: 0, s: 0, e: 167 }]);
});

test("F§5.6(c) — the four golden lookups on the golden timings", () => {
  expect(findActiveWord(GOLDEN_TIMINGS, 400)).toBe(0);
  expect(findActiveWord(GOLDEN_TIMINGS, 467)).toBe(1);
  expect(findActiveWord(GOLDEN_TIMINGS, -5)).toBe(0);
  expect(findActiveWord(GOLDEN_TIMINGS, 9999)).toBe(1);
});

test("findActiveWord returns the word whose span contains t, not the one after it", () => {
  const timings = [
    { i: 0, s: 0, e: 100 },
    { i: 1, s: 100, e: 200 },
    { i: 2, s: 200, e: 300 },
    { i: 3, s: 300, e: 400 },
    { i: 4, s: 400, e: 500 },
  ];
  expect(findActiveWord(timings, 0)).toBe(0);
  expect(findActiveWord(timings, 99)).toBe(0);
  expect(findActiveWord(timings, 200)).toBe(2);
  expect(findActiveWord(timings, 399)).toBe(3);
  expect(findActiveWord(timings, 500)).toBe(4);
  expect(findActiveWord(timings, 1000000)).toBe(4);
  expect(findActiveWord([], 500)).toBe(0);
});

test("alignment keeps the engine's own spans when every word matches", () => {
  const result = alignEngineTimings(
    GOLDEN_WORDS,
    [
      { text: "Hello,", s: 0, e: 333 },
      { text: "world.", s: 467, e: 800 },
    ],
    1000,
  );
  expect(result.timingSource).toBe("engine");
  expect(result.timings).toEqual(GOLDEN_TIMINGS);
});

test("alignment concatenates the tokens of a word the engine split in two", () => {
  const result = alignEngineTimings(
    ["lighthouse"],
    [
      { text: "light", s: 0, e: 200 },
      { text: "house", s: 200, e: 500 },
    ],
    1000,
  );
  expect(result.timingSource).toBe("engine");
  expect(result.timings).toEqual([{ i: 0, s: 0, e: 500 }]);
});

test("alignment skips the engine tokens that carry no letters or digits", () => {
  const result = alignEngineTimings(
    ["don't", "stop"],
    [
      { text: "don", s: 0, e: 100 },
      { text: "'", s: 100, e: 120 },
      { text: "t", s: 120, e: 200 },
      { text: "stop", s: 250, e: 500 },
    ],
    1000,
  );
  expect(result.timingSource).toBe("engine");
  expect(result.timings).toEqual([
    { i: 0, s: 0, e: 200 },
    { i: 1, s: 250, e: 500 },
  ]);
});

test("alignment estimates one unmatched word across the gap its neighbours leave", () => {
  const result = alignEngineTimings(
    ["alpha", "missing", "omega"],
    [
      { text: "alpha", s: 0, e: 300 },
      { text: "omega", s: 700, e: 1000 },
    ],
    1000,
  );
  expect(result.timingSource).toBe("engine");
  expect(result.timings).toEqual([
    { i: 0, s: 0, e: 300 },
    { i: 1, s: 300, e: 700 },
    { i: 2, s: 700, e: 1000 },
  ]);
});

test("alignment clamps spans the engine reported outside the chunk", () => {
  const result = alignEngineTimings(["alpha", "beta"], [{ text: "alpha", s: -50, e: 1600 }], 1000);
  expect(result.timingSource).toBe("engine");
  expect(result.timings).toEqual([
    { i: 0, s: 0, e: 1000 },
    { i: 1, s: 1000, e: 1000 },
  ]);
});

test("alignment falls back to estimated when fewer than half the words matched", () => {
  const words = ["alpha", "beta", "gamma"];
  const result = alignEngineTimings(words, [{ text: "alpha", s: 0, e: 100 }], 1000);
  expect(result.timingSource).toBe("estimated");
  expect(result.timings).toEqual([
    { i: 0, s: 0, e: 357 },
    { i: 1, s: 357, e: 643 },
    { i: 2, s: 643, e: 1000 },
  ]);
  expect(result.timings).toEqual(estimateTimings(words, 1000));
});

test("alignment stays with the engine at exactly half the words matched", () => {
  const result = alignEngineTimings(["alpha", "beta"], [{ text: "alpha", s: 0, e: 400 }], 1000);
  expect(result.timingSource).toBe("engine");
  expect(result.timings).toEqual([
    { i: 0, s: 0, e: 400 },
    { i: 1, s: 400, e: 1000 },
  ]);
});

test("alignment estimates the whole chunk when the engine reported nothing at all", () => {
  const words = ["alpha", "beta."];
  const result = alignEngineTimings(words, [], 1000);
  expect(result.timingSource).toBe("estimated");
  expect(result.timings).toEqual(estimateTimings(words, 1000));
});

test("alignment answers an empty word list with no timings", () => {
  expect(alignEngineTimings([], [{ text: "alpha", s: 0, e: 10 }], 1000)).toEqual({ timings: [], timingSource: "estimated" });
});

test("alignment output is monotonic and clamped for 200 seeded random inputs", () => {
  const random = seededRandom(20261113);
  for (let run = 0; run < 200; run += 1) {
    const wordCount = 3 + Math.floor(random() * 10);
    const words = Array.from({ length: wordCount }, () => randomWord(random));
    const durationMs = 1000 + Math.floor(random() * 19000);
    const tokens: { text: string; s: number; e: number }[] = [];
    let cursor = 0;
    for (const word of words) {
      cursor += Math.floor(random() * 200);
      if (random() < 0.7) {
        const start = Math.min(cursor, durationMs);
        const end = Math.min(start + 50 + Math.floor(random() * 500), durationMs);
        tokens.push({ text: word, s: start, e: end });
        cursor = end;
      }
    }
    const result = alignEngineTimings(words, tokens, durationMs);
    expect(result.timings).toHaveLength(wordCount);
    let previousStart = 0;
    for (const [index, timing] of result.timings.entries()) {
      expect(timing.i).toBe(index);
      expect(timing.s).toBeGreaterThanOrEqual(previousStart);
      expect(timing.s).toBeGreaterThanOrEqual(0);
      expect(timing.e).toBeGreaterThanOrEqual(timing.s);
      expect(timing.e).toBeLessThanOrEqual(durationMs);
      previousStart = timing.s;
    }
    expect(alignEngineTimings(words, tokens, durationMs)).toEqual(result);
  }
});
