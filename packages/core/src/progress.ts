/**
 * Progress and time-remaining math (F§5.6(f)). All three functions read the document and a position in
 * it; none of them keeps state, so a restored position reports the same progress it did before.
 *
 * `remainingMs` needs a speed to convert words into time, and `baseWpm` — the running average the reader
 * keeps per voice — to know how long a word takes at rate 1.
 */

import type { DocumentModel, Position } from "./model";

/** Milliseconds in a minute, the unit `baseWpm` is expressed in (F§5.6(f)). */
const MS_PER_MINUTE = 60000;

/**
 * How many words the document holds before the given global sentence index (F§5.6(f)'s
 * `wordsBefore(sentenceIndex)`). Sentences carry their own global index, so this reads the document
 * rather than assuming one sentence per block.
 */
function wordsBefore(doc: DocumentModel, sentenceIndex: number): number {
  let words = 0;
  for (const block of doc.blocks) {
    for (const sentence of block.sentences) {
      if (sentence.index < sentenceIndex) words += sentence.words.length;
    }
  }
  return words;
}

/** How many words of the document the position has already passed — the numerator of F§5.6(f). */
function wordsRead(doc: DocumentModel, position: Position): number {
  return wordsBefore(doc, position.sentenceIndex) + position.wordIndex;
}

/**
 * `progressFraction(doc, position)` — F§5.6(f): read words over the document's word count, held inside
 * `[0, 1]`. A position on the first word reads 0, and the position the reader reports after the last word
 * — the first one at or past the end — reads 1. An empty document has nothing to have read.
 */
export function progressFraction(doc: DocumentModel, position: Position): number {
  if (doc.wordCount === 0) return 0;
  return Math.min(1, Math.max(0, wordsRead(doc, position) / doc.wordCount));
}

/**
 * `remainingMs(doc, position, rate, baseWpm)` — F§5.6(f): the words still to read divided by the words per
 * minute the voice actually manages at `rate`, rounded to whole milliseconds. A position at or past the
 * last word has no time left; a rate or a `baseWpm` that cannot carry words is not a speed at all, so it
 * is refused rather than answered with a fabricated number.
 */
export function remainingMs(doc: DocumentModel, position: Position, rate: number, baseWpm: number): number {
  const remainingWords = Math.max(0, doc.wordCount - wordsRead(doc, position));
  if (remainingWords === 0) return 0;
  if (!(rate > 0)) throw new RangeError(`remainingMs: rate must be greater than zero, got ${rate}`);
  if (!(baseWpm > 0)) throw new RangeError(`remainingMs: baseWpm must be greater than zero, got ${baseWpm}`);
  return Math.round((remainingWords * MS_PER_MINUTE) / (baseWpm * rate));
}

/**
 * `updateBaseWpm(previous, words, durationMs)` — F§5.6(f): the running average of
 * `60000 · words / durationMs` over the chunks played with the current voice, whose initial value is 170.
 * The chunk just played and the average so far weigh the same, so the estimate follows a voice that
 * changes pace without a single odd chunk moving it. A chunk that carries no words, or no time, teaches
 * nothing and leaves the average alone.
 */
export function updateBaseWpm(previous: number, words: number, durationMs: number): number {
  if (words <= 0 || durationMs <= 0) return previous;
  const sample = (words * MS_PER_MINUTE) / durationMs;
  return (previous + sample) / 2;
}
