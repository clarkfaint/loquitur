/**
 * F§5.6(f)'s progress and time-remaining math. Documents are built through the real builder, so the word
 * counts and the global sentence indexes are the ones the player will see.
 */

import { expect, test } from "vitest";
import { buildDocument } from "../builder";
import type { DocumentModel } from "../model";
import { progressFraction, remainingMs, updateBaseWpm } from "../progress";

const TXT = { kind: "txt" } as const;

/** F§5.6(f)'s initial running average, and the voice every case here plays with. */
const BASE_WPM = 170;
const SENTENCE_COUNT = 34;
const WORDS_PER_SENTENCE = 10;

const SMALL_WORDS = "Alpha beta. Gamma delta epsilon.";

/**
 * 34 sentences of 10 words: 340 words, which at 170 wpm is exactly 120000 ms — so doubling the rate has to
 * halve the remaining time exactly, with no rounding to hide behind.
 */
function wpmDocument(): DocumentModel {
  const sentences = Array.from(
    { length: SENTENCE_COUNT },
    (_unused, sentence) => `${Array.from({ length: WORDS_PER_SENTENCE }, (_word, word) => `word${sentence}x${word}`).join(" ")}.`,
  );
  return buildDocument([{ kind: "paragraph", text: sentences.join(" ") }], { source: TXT });
}

test("fraction is 0 on the first word, (n-1)/n on the last, and 1 at the position past it", () => {
  const doc = buildDocument([{ kind: "paragraph", text: SMALL_WORDS }], { source: TXT });
  expect(doc.wordCount).toBe(5);
  expect(progressFraction(doc, { docId: doc.docId, sentenceIndex: 0, wordIndex: 0 })).toBe(0);
  expect(progressFraction(doc, { docId: doc.docId, sentenceIndex: 1, wordIndex: 2 })).toBe(0.8);
  expect(progressFraction(doc, { docId: doc.docId, sentenceIndex: 1, wordIndex: 3 })).toBe(1);
});

test("fraction is held inside [0, 1] for a position beyond the document", () => {
  const doc = buildDocument([{ kind: "paragraph", text: SMALL_WORDS }], { source: TXT });
  expect(progressFraction(doc, { docId: doc.docId, sentenceIndex: 9, wordIndex: 0 })).toBe(1);
  expect(progressFraction(doc, { docId: doc.docId, sentenceIndex: 0, wordIndex: 99 })).toBe(1);
});

test("an empty document has read nothing", () => {
  const doc = buildDocument([], { source: TXT });
  expect(doc.wordCount).toBe(0);
  expect(progressFraction(doc, { docId: doc.docId, sentenceIndex: 0, wordIndex: 0 })).toBe(0);
});

test("remaining time halves when the rate doubles", () => {
  const doc = wpmDocument();
  expect(doc.wordCount).toBe(SENTENCE_COUNT * WORDS_PER_SENTENCE);
  const start = { docId: doc.docId, sentenceIndex: 0, wordIndex: 0 };
  expect(remainingMs(doc, start, 1, BASE_WPM)).toBe(120000);
  expect(remainingMs(doc, start, 2, BASE_WPM)).toBe(60000);
  expect(remainingMs(doc, start, 1, BASE_WPM)).toBe(2 * remainingMs(doc, start, 2, BASE_WPM));
});

test("remaining time counts only the words still to read", () => {
  const doc = buildDocument([{ kind: "paragraph", text: SMALL_WORDS }], { source: TXT });
  const start = { docId: doc.docId, sentenceIndex: 0, wordIndex: 0 };
  const afterFirstSentence = { docId: doc.docId, sentenceIndex: 1, wordIndex: 0 };
  expect(remainingMs(doc, start, 1, BASE_WPM)).toBe(Math.round((5 * 60000) / BASE_WPM));
  expect(remainingMs(doc, afterFirstSentence, 1, BASE_WPM)).toBe(Math.round((3 * 60000) / BASE_WPM));
});

test("no time remains at the position the reader reports past the last word", () => {
  const doc = buildDocument([{ kind: "paragraph", text: SMALL_WORDS }], { source: TXT });
  expect(remainingMs(doc, { docId: doc.docId, sentenceIndex: 1, wordIndex: 3 }, 1, BASE_WPM)).toBe(0);
  expect(remainingMs(doc, { docId: doc.docId, sentenceIndex: 4, wordIndex: 0 }, 1, BASE_WPM)).toBe(0);
});

test("a rate or an average that cannot carry words is refused rather than answered", () => {
  const doc = buildDocument([{ kind: "paragraph", text: SMALL_WORDS }], { source: TXT });
  const start = { docId: doc.docId, sentenceIndex: 0, wordIndex: 0 };
  expect(() => remainingMs(doc, start, 0, BASE_WPM)).toThrow(RangeError);
  expect(() => remainingMs(doc, start, 1, 0)).toThrow(RangeError);
});

test("updateBaseWpm leaves F§5.6(f)'s initial average where it is for a chunk at 170 wpm", () => {
  // 170 words in 60000 ms is 170 wpm, so the running average has no reason to move.
  expect(updateBaseWpm(BASE_WPM, 170, 60000)).toBe(170);
});

test("updateBaseWpm blends the chunk just played into the running average", () => {
  // 340 words in 60000 ms is 340 wpm: half the way from the initial average.
  expect(updateBaseWpm(BASE_WPM, 340, 60000)).toBe(255);
  expect(updateBaseWpm(255, 340, 60000)).toBe(297.5);
});

test("updateBaseWpm leaves the average alone for a chunk with no words or no time", () => {
  expect(updateBaseWpm(BASE_WPM, 0, 60000)).toBe(BASE_WPM);
  expect(updateBaseWpm(BASE_WPM, 170, 0)).toBe(BASE_WPM);
  expect(updateBaseWpm(BASE_WPM, -5, 60000)).toBe(BASE_WPM);
});
