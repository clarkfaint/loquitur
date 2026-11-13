/**
 * Sentence and word tokenization (F§5.3), tokenizerVersion 1.
 *
 * Deterministic, hand-rolled and locale-free: no `Intl.Segmenter`, no regular-expression lookbehind, no
 * NLP package, and no rewriting of the text. Every range this module returns is an offset pair into the
 * string it was given, and every piece of text it returns is a `slice` of that string, so callers can
 * keep `Sentence.charStart`/`charEnd` (offsets into `Block.text`) and `Word.charStart`/`charEnd`
 * (offsets into `Sentence.text`) pointing at characters that were never copied or trimmed.
 *
 * The scanner errs toward fewer splits: an abbreviation that truly ends a sentence (`…in the U.S. He
 * left.`) does not split, which F§5.3 records as a known and accepted limit.
 */

import { CASE_INSENSITIVE_ABBREVIATIONS, EXACT_CASE_ABBREVIATIONS } from "./abbreviations";
import type { Sentence, Word } from "./model";

/** The tokenizer the whole document model is pinned to (F§5.1, F§5.3). */
export const TOKENIZER_VERSION = 1;

/** One sentence as this module first sees it: a range of a block's text, before it has an index. */
export interface SentenceRange {
  /** Offset of the sentence's first character inside the block text. */
  charStart: number;
  /** Offset just past the sentence's last character. */
  charEnd: number;
  /** Exactly `blockText.slice(charStart, charEnd)`, never a reassembled copy. */
  text: string;
}

/** An offset pair inside some string. */
interface CharRange {
  charStart: number;
  charEnd: number;
}

/** A sentence longer than this is split at the last sensible break inside its first 400 characters. */
const MAX_SENTENCE_LENGTH = 400;

const TERMINATORS = new Set([".", "!", "?", "\u2026"]);
const CLOSERS = new Set(['"', "'", ")", "]", "\u201d", "\u2019", "\u00bb"]);
const OPENERS = new Set(['"', "'", "(", "[", "\u201c", "\u2018", "\u00ab"]);
const SENTENCE_BREAK_CHARACTERS = ",;:\u2014";

const LETTER_OR_INNER_DOT = /[\p{L}.]/u;
const SINGLE_LETTER = /^\p{L}$/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const UPPERCASE_OR_DIGIT = /[\p{Lu}\p{N}]/u;
const WHITESPACE = /\s/u;

function isWhitespace(character: string): boolean {
  return WHITESPACE.test(character);
}

function isTerminator(character: string): boolean {
  return TERMINATORS.has(character);
}

function isCloser(character: string): boolean {
  return CLOSERS.has(character);
}

/** Whether `character` can begin a sentence after a boundary: a capital, a digit, or an opening mark. */
function startsSentence(character: string): boolean {
  return UPPERCASE_OR_DIGIT.test(character) || OPENERS.has(character);
}

function skipWhitespace(text: string, from: number): number {
  let cursor = from;
  while (cursor < text.length && isWhitespace(text.charAt(cursor))) cursor += 1;
  return cursor;
}

/** The maximal run of letters and inner dots that ends where the terminator at `terminator` begins. */
function tokenBefore(text: string, terminator: number): string {
  let cursor = terminator;
  while (cursor > 0 && LETTER_OR_INNER_DOT.test(text.charAt(cursor - 1))) cursor -= 1;
  return text.slice(cursor, terminator);
}

/** The three ways F§5.3 refuses to end a sentence after a single `.`: case-insensitive, exact-case, initial. */
function isAbbreviationToken(token: string): boolean {
  if (token === "") return false;
  if (SINGLE_LETTER.test(token)) return true;
  if (CASE_INSENSITIVE_ABBREVIATIONS.has(token.toLowerCase())) return true;
  return EXACT_CASE_ABBREVIATIONS.has(token);
}

/** The trimmed range `[charStart, charEnd)` of `text`, or `null` when it holds no character at all. */
function rangeOf(text: string, charStart: number, charEnd: number): SentenceRange | null {
  let start = charStart;
  let end = charEnd;
  while (start < end && isWhitespace(text.charAt(start))) start += 1;
  while (end > start && isWhitespace(text.charAt(end - 1))) end -= 1;
  if (start >= end) return null;
  return { charStart: start, charEnd: end, text: text.slice(start, end) };
}

/** The offset of the last character of `characters` inside `[from, to]`, or `-1`. */
function lastIndexOfAny(text: string, characters: string, from: number, to: number): number {
  for (let index = to; index >= from; index -= 1) {
    if (characters.includes(text.charAt(index))) return index;
  }
  return -1;
}

/**
 * Where sentences may end in `text`, as offsets just past the terminator run and its closers. A
 * candidate needs whitespace after it and a capital, digit or opening mark after that whitespace, and a
 * lone `.` is dropped when the token in front of it is an abbreviation. The end of the block always ends
 * a sentence, whether or not a candidate was found there.
 */
function candidateEnds(text: string): number[] {
  const ends: number[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const terminator = text.charAt(cursor);
    if (!isTerminator(terminator)) {
      cursor += 1;
      continue;
    }
    let runEnd = cursor;
    while (runEnd < text.length && isTerminator(text.charAt(runEnd))) runEnd += 1;
    let closerEnd = runEnd;
    while (closerEnd < text.length && isCloser(text.charAt(closerEnd))) closerEnd += 1;
    const afterWhitespace = skipWhitespace(text, closerEnd);
    const candidate = afterWhitespace > closerEnd && startsSentence(text.charAt(afterWhitespace));
    const rejected = runEnd - cursor === 1 && terminator === "." && isAbbreviationToken(tokenBefore(text, cursor));
    if (candidate && !rejected) ends.push(closerEnd);
    cursor = runEnd;
  }
  ends.push(text.length);
  return ends;
}

/**
 * One range, split until every piece is at most `MAX_SENTENCE_LENGTH` characters: first after the last
 * `,`, `;`, `:` or `—` inside the piece's first 400 characters (the punctuation stays with the piece),
 * then at the last space there, and — for a run with neither — at exactly 400 characters, which is the
 * only break left and the one that keeps the guarantee that no piece grows without bound.
 */
function longSentencePieces(text: string, range: SentenceRange): SentenceRange[] {
  const pieces: SentenceRange[] = [];
  let start = range.charStart;
  while (range.charEnd - start > MAX_SENTENCE_LENGTH) {
    const windowEnd = Math.min(start + MAX_SENTENCE_LENGTH - 1, range.charEnd - 1);
    const punctuation = lastIndexOfAny(text, SENTENCE_BREAK_CHARACTERS, start, windowEnd);
    let cut: number;
    if (punctuation !== -1) {
      cut = punctuation + 1;
    } else {
      const space = text.lastIndexOf(" ", windowEnd);
      cut = space > start ? space : Math.min(start + MAX_SENTENCE_LENGTH, range.charEnd);
    }
    const piece = rangeOf(text, start, cut);
    if (piece !== null) pieces.push(piece);
    start = skipWhitespace(text, cut);
    if (start >= range.charEnd) return pieces;
  }
  const tail = rangeOf(text, start, range.charEnd);
  if (tail !== null) pieces.push(tail);
  return pieces;
}

/**
 * Split a block's text into sentences (F§5.3). Ranges are trimmed, disjoint and in document order; the
 * whitespace between two sentences belongs to neither, and text that is empty or whitespace-only yields
 * no sentence at all.
 */
export function splitSentences(blockText: string): SentenceRange[] {
  const ranges: SentenceRange[] = [];
  let cursor = 0;
  for (const end of candidateEnds(blockText)) {
    const range = rangeOf(blockText, cursor, end);
    if (range !== null) ranges.push(range);
    cursor = end;
  }
  const sentences: SentenceRange[] = [];
  for (const range of ranges) {
    for (const piece of longSentencePieces(blockText, range)) sentences.push(piece);
  }
  return sentences;
}

/**
 * Split one sentence's text into words (F§5.3). A word is a maximal run of non-whitespace characters.
 * A run holding no letter and no digit — a lone dash, an ellipsis, a bullet — is no word of its own: it
 * joins the range of the word on its left, or of the word on its right when it comes first, so that
 * every non-whitespace character of the sentence is inside exactly one word. A sentence made only of
 * such runs keeps one word covering them, which is the same rule with no neighbour available.
 */
export function splitWords(sentenceText: string): Word[] {
  const ranges: CharRange[] = [];
  let lastWord: CharRange | undefined;
  let pendingStart: number | null = null;
  let pendingEnd = 0;
  let cursor = 0;
  while (cursor < sentenceText.length) {
    if (isWhitespace(sentenceText.charAt(cursor))) {
      cursor += 1;
      continue;
    }
    let tokenEnd = cursor;
    while (tokenEnd < sentenceText.length && !isWhitespace(sentenceText.charAt(tokenEnd))) tokenEnd += 1;
    const token = sentenceText.slice(cursor, tokenEnd);
    if (LETTER_OR_DIGIT.test(token)) {
      const word: CharRange = { charStart: pendingStart ?? cursor, charEnd: tokenEnd };
      ranges.push(word);
      lastWord = word;
      pendingStart = null;
    } else if (lastWord !== undefined) {
      lastWord.charEnd = tokenEnd;
    } else {
      pendingStart ??= cursor;
      pendingEnd = tokenEnd;
    }
    cursor = tokenEnd;
  }
  if (pendingStart !== null) ranges.push({ charStart: pendingStart, charEnd: pendingEnd });
  return ranges.map((range, index) => ({
    index,
    charStart: range.charStart,
    charEnd: range.charEnd,
    text: sentenceText.slice(range.charStart, range.charEnd),
  }));
}

/**
 * Tokenize one block into F§5.1 `Sentence`s. `firstSentenceIndex` is the global index of the block's
 * first sentence (F§5.1 numbers sentences across the whole document), and `blockIndex` is the block's
 * own index; sentence offsets stay relative to `blockText` and word offsets relative to each sentence.
 */
export function tokenizeBlock(blockText: string, firstSentenceIndex: number, blockIndex: number): Sentence[] {
  return splitSentences(blockText).map((range, offset) => ({
    index: firstSentenceIndex + offset,
    blockIndex,
    charStart: range.charStart,
    charEnd: range.charEnd,
    text: range.text,
    words: splitWords(range.text),
  }));
}
