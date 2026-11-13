import { expect, test } from "vitest";
import { splitSentences, splitWords, TOKENIZER_VERSION, tokenizeBlock } from "../tokenizer";

const WHITESPACE = /\s/u;

/**
 * The six golden cases of F§5.3 as literal strings, kept together so the invariant tests below run over
 * the same inputs the case-by-case tests assert. The texts are the architecture brief's, verbatim.
 */
const GOLDEN_BLOCKS: readonly string[] = [
  "Dr. Smith went to Washington. He arrived at 3.15 p.m. on Jan. 5.",
  "In Roe v. Wade, 410 U.S. 113 (1973), the Court ruled. See id. at 115.",
  "Wait... what? Yes!",
  'She said, "Stop." Then she left.',
  "J. K. Rowling wrote it.",
  "Open the app. Then read Art. 5 aloud.",
];

/** A 900-character block with no terminator at all: 99 single spaces and one 9-character word. */
const LONG_BLOCK_TEXT = Array.from({ length: 100 }, (_unused, index) => (index === 0 ? "abcdefghi" : "abcdefgh")).join(" ");

function sentenceTexts(blockText: string): string[] {
  return splitSentences(blockText).map((sentence) => sentence.text);
}

function wordTexts(sentenceText: string): string[] {
  return splitWords(sentenceText).map((word) => word.text);
}

/** Every word range of a block, translated into offsets into the block's own text. */
function wordRanges(blockText: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const sentence of tokenizeBlock(blockText, 0, 0)) {
    for (const word of sentence.words) {
      ranges.push([sentence.charStart + word.charStart, sentence.charStart + word.charEnd]);
    }
  }
  return ranges;
}

/** The non-whitespace characters of a block that no word covers, or that more than one word covers. */
function charactersNotInExactlyOneWord(blockText: string): string[] {
  const ranges = wordRanges(blockText);
  const offenders: string[] = [];
  for (let index = 0; index < blockText.length; index += 1) {
    const character = blockText.charAt(index);
    if (WHITESPACE.test(character)) continue;
    const holders = ranges.filter(([start, end]) => index >= start && index < end);
    if (holders.length !== 1) offenders.push(`${JSON.stringify(character)} at ${index} (${holders.length} words)`);
  }
  return offenders;
}

test("F§5.3 golden case 1 — an abbreviation is not a sentence end", () => {
  expect(sentenceTexts("Dr. Smith went to Washington. He arrived at 3.15 p.m. on Jan. 5.")).toEqual([
    "Dr. Smith went to Washington.",
    "He arrived at 3.15 p.m. on Jan. 5.",
  ]);
});

test("F§5.3 golden case 2 — a case citation, an initial and a real sentence end", () => {
  expect(sentenceTexts("In Roe v. Wade, 410 U.S. 113 (1973), the Court ruled. See id. at 115.")).toEqual([
    "In Roe v. Wade, 410 U.S. 113 (1973), the Court ruled.",
    "See id. at 115.",
  ]);
});

test("F§5.3 golden case 3 — a run of terminators and a short question", () => {
  expect(sentenceTexts("Wait... what? Yes!")).toEqual(["Wait... what?", "Yes!"]);
});

test("F§5.3 golden case 4 — a closing quote belongs to the sentence it closes", () => {
  expect(sentenceTexts('She said, "Stop." Then she left.')).toEqual(['She said, "Stop."', "Then she left."]);
});

test("F§5.3 golden case 5 — initials do not end a sentence", () => {
  expect(sentenceTexts("J. K. Rowling wrote it.")).toEqual(["J. K. Rowling wrote it."]);
});

test("F§5.3 golden case 6 — a lower-case word is not a citation abbreviation", () => {
  expect(sentenceTexts("Open the app. Then read Art. 5 aloud.")).toEqual(["Open the app.", "Then read Art. 5 aloud."]);
});

test("every sentence range slices back to its own text", () => {
  for (const blockText of [...GOLDEN_BLOCKS, LONG_BLOCK_TEXT, "—", "Alpha — beta gamma."]) {
    for (const sentence of splitSentences(blockText)) {
      expect(blockText.slice(sentence.charStart, sentence.charEnd)).toBe(sentence.text);
      expect(sentence.text.length).toBe(sentence.charEnd - sentence.charStart);
    }
  }
});

test("every word range slices back to its own text", () => {
  for (const blockText of GOLDEN_BLOCKS) {
    for (const sentence of tokenizeBlock(blockText, 0, 0)) {
      for (const word of sentence.words) {
        expect(sentence.text.slice(word.charStart, word.charEnd)).toBe(word.text);
      }
    }
  }
});

test("every non-whitespace character of a block lies in exactly one word", () => {
  for (const blockText of [...GOLDEN_BLOCKS, LONG_BLOCK_TEXT, "—", "Alpha — beta gamma.", "Wait\u2026 \u2026what?"]) {
    expect(charactersNotInExactlyOneWord(blockText)).toEqual([]);
  }
});

test("a 900-character sentence without terminators splits into pieces of at most 400 characters", () => {
  expect(LONG_BLOCK_TEXT.length).toBe(900);
  const sentences = splitSentences(LONG_BLOCK_TEXT);
  expect(sentences.length).toBeGreaterThan(1);
  for (const sentence of sentences) {
    expect(sentence.text.length).toBeLessThanOrEqual(400);
  }
  expect(sentences.map((sentence) => sentence.text).join(" ")).toBe(LONG_BLOCK_TEXT);
});

test("a long sentence breaks after its punctuation and keeps the punctuation", () => {
  const blockText = "abcdefgh, ".repeat(50).trim();
  expect(blockText.length).toBe(499);
  const sentences = splitSentences(blockText);
  expect(sentences.length).toBeGreaterThan(1);
  for (const sentence of sentences) {
    expect(sentence.text.length).toBeLessThanOrEqual(400);
  }
  expect(sentences.map((sentence) => sentence.text).join(" ")).toBe(blockText);
  expect(sentences[0]?.text.endsWith(",")).toBe(true);
});

test("a run with no space and no punctuation is cut at exactly 400 characters", () => {
  const blockText = "a".repeat(900);
  const sentences = splitSentences(blockText);
  expect(sentences.map((sentence) => sentence.text.length)).toEqual([400, 400, 100]);
  expect(sentences.map((sentence) => sentence.text).join("")).toBe(blockText);
});

test("a punctuation-only token merges into its neighbour", () => {
  expect(wordTexts("Hello \u2014 world")).toEqual(["Hello \u2014", "world"]);
  expect(wordTexts("\u2014 Hello")).toEqual(["\u2014 Hello"]);
  expect(wordTexts("\u2014")).toEqual(["\u2014"]);
  expect(wordTexts("Alpha \u2014 \u2014 beta")).toEqual(["Alpha \u2014 \u2014", "beta"]);
  const merged = splitWords("\u2014 Hello");
  expect(merged.map((word) => [word.charStart, word.charEnd])).toEqual([[0, 7]]);
  const trailing = splitWords("Hello \u2014");
  expect(trailing.map((word) => [word.charStart, word.charEnd])).toEqual([[0, 7]]);
});

test("empty and whitespace-only input yields no sentences", () => {
  expect(splitSentences("")).toEqual([]);
  expect(splitSentences("   \n\t ")).toEqual([]);
  expect(splitWords("")).toEqual([]);
  expect(tokenizeBlock("", 0, 0)).toEqual([]);
});

test("the tokenizer version is 1", () => {
  expect(TOKENIZER_VERSION).toBe(1);
});

test("tokenizeBlock names the block and numbers its sentences from the first sentence index", () => {
  const sentences = tokenizeBlock("One. Two. Three.", 7, 3);
  expect(sentences.map((sentence) => sentence.index)).toEqual([7, 8, 9]);
  expect(sentences.map((sentence) => sentence.blockIndex)).toEqual([3, 3, 3]);
  expect(sentences.map((sentence) => sentence.text)).toEqual(["One.", "Two.", "Three."]);
  expect(sentences.map((sentence) => sentence.words.length)).toEqual([1, 1, 1]);
  expect(sentences.map((sentence) => sentence.words[0]?.text)).toEqual(["One.", "Two.", "Three."]);
});

test("words are numbered from zero inside their own sentence", () => {
  const words = splitWords("One two three.");
  expect(words.map((word) => word.index)).toEqual([0, 1, 2]);
  expect(words.map((word) => [word.charStart, word.charEnd])).toEqual([
    [0, 3],
    [4, 7],
    [8, 14],
  ]);
});
