/**
 * Timing and synchronization math (F§5.6). Every number here is integer milliseconds of media time
 * inside one chunk, so the playback rate never enters a timing: a timing is what the audio says.
 *
 * A chunk whose engine reported no timestamps is apportioned from the text alone (`estimateTimings`);
 * a chunk whose engine reported timestamps is matched word by word, and only the gaps that unmatched
 * words leave are estimated (`alignEngineTimings`). `findActiveWord` turns the highlight clock into the
 * word the reader should be pointing at.
 */

/** One word's media time inside a chunk: its index, its start and its end, in integer milliseconds (F§5.6). */
export interface WordTiming {
  i: number;
  s: number;
  e: number;
}

/** One timestamped token as a TTS engine reports it (F§5.6(b)): the token's text, and its start and end in integer milliseconds. */
export interface EngineToken {
  text: string;
  s: number;
  e: number;
}

/** Where the timings came from: the engine's own timestamps, or `estimateTimings` alone (F§5.6(b) step 5). */
export type TimingSource = "engine" | "estimated";

/** An aligned chunk: the timings, and which of the two sources produced them (F§5.6(b)). */
export interface AlignedTimings {
  timings: WordTiming[];
  timingSource: TimingSource;
}

/** A letter or a digit in any script — F§5.6(a)'s `alnum` counts these. */
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/gu;
/** Closing punctuation, dropped before a word's final mark is read (F§5.6(a): marks are read "ignoring closers"). */
const CLOSERS = /["'”’»)\]}]+$/u;
/** A mark that ends a sentence, and so earns the longest pause (F§5.6(a)). */
const SENTENCE_END = /[.!?…]$/u;
/** A mark that ends a clause, and so earns the shorter pause (F§5.6(a)). */
const CLAUSE_END = /[,;:—]$/u;
/** Everything that is neither a letter nor a digit, for `norm` (F§5.6(b) step 1). */
const NOT_LETTER_OR_DIGIT = /[^\p{L}\p{N}]+/gu;
/** How many tokens the token pointer may look ahead after a mismatch (F§5.6(b) step 3). */
const MISMATCH_LOOKAHEAD = 3;

/** A word's shape for `estimateTimings`: its letter-and-digit count and its full weight (F§5.6(a)). */
interface WordShape {
  readonly alnum: number;
  readonly weight: number;
}

/** What one word took from the engine's token stream, as indexes into that stream (F§5.6(b) step 2). */
interface TokenSpan {
  readonly first: number;
  readonly last: number;
}

/** `alnum(w)` — the word's letters and digits, at least 1 (F§5.6(a)). */
function alnumCount(word: string): number {
  const found = word.match(LETTER_OR_DIGIT);
  return Math.max(1, found === null ? 0 : found.length);
}

/** `pause(w)` — 3 after a sentence mark, 2 after a clause mark, otherwise 0 (F§5.6(a)). */
function pauseWeight(word: string): number {
  const head = word.replace(CLOSERS, "");
  if (SENTENCE_END.test(head)) return 3;
  if (CLAUSE_END.test(head)) return 2;
  return 0;
}

/** `weight(w) = alnum(w) + pause(w)` (F§5.6(a)). */
function shapeOf(word: string): WordShape {
  const alnum = alnumCount(word);
  return { alnum, weight: alnum + pauseWeight(word) };
}

/** `norm(x)` — lowercase, Unicode letters and digits only (F§5.6(b) step 1). */
function norm(text: string): string {
  return text.toLowerCase().replace(NOT_LETTER_OR_DIGIT, "");
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * `estimateTimings(words, durationMs)` — F§5.6(a), for an engine that returns no timestamps. Each word
 * takes a share of the chunk proportional to `weight(w)`, rounded to whole milliseconds, so a word that
 * ends a sentence also holds the chunk through the pause it does not speak.
 */
export function estimateTimings(words: readonly string[], durationMs: number): WordTiming[] {
  const shapes = words.map(shapeOf);
  const totalWeight = shapes.reduce((sum, shape) => sum + shape.weight, 0);
  const timings: WordTiming[] = [];
  let before = 0;
  for (const [i, shape] of shapes.entries()) {
    timings.push({
      i,
      s: Math.round((durationMs * before) / totalWeight),
      e: Math.round((durationMs * (before + shape.alnum)) / totalWeight),
    });
    before += shape.weight;
  }
  return timings;
}

/**
 * `findActiveWord(timings, tMs)` — F§5.6(c): the last word that has started by `tMs`, found by binary
 * search. A time before the first start reads as word 0, and a time after the last end stays on the last
 * word, so the highlight never falls off either end of the chunk.
 */
export function findActiveWord(timings: readonly WordTiming[], tMs: number): number {
  const first = timings[0];
  if (first === undefined || tMs < first.s) return 0;
  let low = 0;
  let high = timings.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = timings[mid];
    if (candidate !== undefined && candidate.s <= tMs) low = mid;
    else high = mid - 1;
  }
  return timings[low]?.i ?? low;
}

/**
 * Consume consecutive engine tokens from `start` while their concatenated `norm` stays a prefix of
 * `wordNorm` (F§5.6(b) step 2). Tokens whose `norm` is empty are skipped and never counted, which is how
 * an engine that emits punctuation as its own token still matches the word around it. The word is
 * matched only when the run reaches it exactly; a partial run consumes nothing.
 */
function consumeTokens(wordNorm: string, tokenNorms: readonly string[], start: number): TokenSpan | null {
  let joined = "";
  let first = -1;
  let last = -1;
  for (let j = start; j < tokenNorms.length; j += 1) {
    const tokenNorm = tokenNorms[j] ?? "";
    if (tokenNorm === "") continue;
    if (!wordNorm.startsWith(joined + tokenNorm)) break;
    joined += tokenNorm;
    if (first === -1) first = j;
    last = j;
    if (joined === wordNorm) break;
  }
  if (first === -1 || last === -1 || joined !== wordNorm) return null;
  return { first, last };
}

/** The first token within the lookahead that starts the next word, or `start` when none does (F§5.6(b) step 3). */
function advancePointer(tokenNorms: readonly string[], start: number, nextNorm: string): number {
  if (nextNorm === "") return start;
  for (let q = start + 1; q <= start + MISMATCH_LOOKAHEAD && q < tokenNorms.length; q += 1) {
    const tokenNorm = tokenNorms[q] ?? "";
    if (tokenNorm !== "" && nextNorm.startsWith(tokenNorm)) return q;
  }
  return start;
}

/**
 * `alignEngineTimings(words, engineTokens, durationMs)` — F§5.6(b). Words and engine tokens are walked
 * with two monotonic pointers: a matched word keeps the engine's own span, and each run of unmatched
 * words is estimated across the gap its matched neighbours leave, bounded by the chunk start and end.
 * Fewer than half the words matched means the engine's timestamps do not describe this text, so the whole
 * chunk falls back to `estimateTimings` as `estimated`. Both paths end clamped: every start and end lies
 * in `[0, durationMs]`, `s <= e`, and no start moves backwards.
 */
export function alignEngineTimings(words: readonly string[], engineTokens: readonly EngineToken[], durationMs: number): AlignedTimings {
  const estimated = (): AlignedTimings => ({ timings: estimateTimings(words, durationMs), timingSource: "estimated" });
  if (words.length === 0) return estimated();
  const wordNorms = words.map(norm);
  const tokenNorms = engineTokens.map((token) => norm(token.text));
  const spans: (WordTiming | null)[] = wordNorms.map(() => null);
  let pointer = 0;
  let matched = 0;
  for (const [i, wordNorm] of wordNorms.entries()) {
    if (wordNorm === "") continue; // nothing but punctuation: the engine has no token that could equal it
    const span = consumeTokens(wordNorm, tokenNorms, pointer);
    if (span !== null) {
      const from = engineTokens[span.first];
      const to = engineTokens[span.last];
      if (from !== undefined && to !== undefined) {
        spans[i] = { i, s: from.s, e: to.e };
        matched += 1;
        pointer = span.last + 1;
        continue;
      }
    }
    pointer = advancePointer(tokenNorms, pointer, wordNorms[i + 1] ?? "");
  }
  if (matched * 2 < words.length) return estimated();
  const filled: WordTiming[] = [];
  let index = 0;
  while (index < words.length) {
    const span = spans[index] ?? null;
    if (span !== null) {
      filled.push(span);
      index += 1;
      continue;
    }
    let lastUnmatched = index;
    while (lastUnmatched + 1 < words.length && (spans[lastUnmatched + 1] ?? null) === null) lastUnmatched += 1;
    const previous = filled[index - 1];
    const nextSpan = spans[lastUnmatched + 1] ?? null;
    const gapStart = previous === undefined ? 0 : previous.e;
    const gapEnd = nextSpan === null ? durationMs : nextSpan.s;
    const gap = Math.max(0, gapEnd - gapStart);
    const runTimings = estimateTimings(words.slice(index, lastUnmatched + 1), gap);
    for (const [offset, timing] of runTimings.entries()) {
      filled.push({ i: index + offset, s: gapStart + timing.s, e: gapStart + timing.e });
    }
    index = lastUnmatched + 1;
  }
  const timings: WordTiming[] = [];
  let previousStart = 0;
  for (const timing of filled) {
    const start = Math.max(clamp(timing.s, 0, durationMs), previousStart);
    const end = Math.max(clamp(timing.e, 0, durationMs), start);
    timings.push({ i: timing.i, s: start, e: end });
    previousStart = start;
  }
  return { timings, timingSource: "engine" };
}
