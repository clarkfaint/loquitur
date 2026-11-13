/**
 * F§5.5's line grouping, on lines written for this test.
 *
 * Synthetic lines are the only way to hold the geometry still: on a real scan the boxes move with the
 * type size and with which letters happen to sit on the line, so one property at a time cannot be
 * exercised there. Every box below is `height` tall starting at `top`, which makes the whitespace
 * between two boxes the step from the previous `bottom` to the next `top` — the quantity the
 * paragraph rule reads.
 */

import { expect, test } from "vitest";
import * as core from "../index";
import type { OcrLine, RawBlock } from "../ocr";
import { groupOcrLines, OCR_MIN_CONFIDENCE, OCR_PARAGRAPH_GAP } from "../ocr";

/** One engine line: `height` tall from `top`, `confidence` sure, with its box starting at `left`. */
function line(text: string, top: number, confidence: number, height = 20, left = 100): OcrLine {
  return { text, bbox: [left, top, left + 400, top + height], confidence };
}

/** The blocks' texts, in the order they were produced. */
function texts(blocks: readonly RawBlock[]): string[] {
  return blocks.map((block) => block.text);
}

test("the isomorphic entry exports the engine contract and F§5.5's own numbers", () => {
  expect(core.OCR_MIN_CONFIDENCE).toBe(OCR_MIN_CONFIDENCE);
  expect(core.OCR_PARAGRAPH_GAP).toBe(OCR_PARAGRAPH_GAP);
  expect(core.OCR_MIN_CONFIDENCE).toBe(40);
  expect(core.OCR_PARAGRAPH_GAP).toBe(1.5);
  expect(core.OCR_LANG).toBe("eng");
  expect(texts(core.groupOcrLines([line("through the barrel", 0, 95)]))).toEqual(["through the barrel"]);
  const engine: core.OcrEngine = { id: "stub", recognize: () => Promise.resolve({ lines: [] }) };
  expect(engine.id).toBe("stub");
  expect(OCR_MIN_CONFIDENCE).toBe(core.OCR_MIN_CONFIDENCE);
});

test("drops the lines the engine was less sure of than F§5.5's floor", () => {
  const blocks = groupOcrLines([line("unsure", 0, 39), line("borderline", 40, 40), line("sure", 80, 95)]);
  expect(texts(blocks)).toEqual(["borderline sure"]);
});

test("reads the lines top to bottom, then left to right where two share a top", () => {
  expect(texts(groupOcrLines([line("third", 80, 95), line("first", 0, 95), line("second", 40, 95)]))).toEqual(["first second third"]);
  expect(texts(groupOcrLines([line("right", 0, 95, 20, 500), line("left", 0, 95, 20, 100)]))).toEqual(["left right"]);
});

test("splits a paragraph where the whitespace is wider than 1.5x the median line height", () => {
  // 20 px lines put the median height at 20, so the threshold is exactly 30 px of whitespace.
  const blocks = groupOcrLines([
    line("a", 0, 95),
    line("b", 50, 95), // gap 30, which is the threshold itself and not above it
    line("c", 101, 95), // gap 31
    line("noise", 400, 5, 500), // dropped, so its 500 px box cannot move the median
  ]);
  expect(texts(blocks)).toEqual(["a b", "c"]);
});

test("keeps ordinary leading in one paragraph, flattened onto one line", () => {
  const blocks = groupOcrLines([line("two\nlines ", 0, 95), line("  with   gaps", 40, 95), line("and a newline\n", 80, 90)]);
  expect(blocks).toEqual([{ kind: "paragraph", text: "two lines with gaps and a newline" }]);
});

test("holds no block for a line that reads as blank once its newlines are flattened", () => {
  expect(texts(groupOcrLines([line("  \n ", 0, 95), line("kept", 40, 95)]))).toEqual(["kept"]);
});

test("returns nothing when the engine read nothing worth keeping", () => {
  expect(groupOcrLines([])).toEqual([]);
  expect(groupOcrLines([line("faint", 0, 10)])).toEqual([]);
});

test("orders the lines before it splits them, so a shuffled page still reads in order", () => {
  const blocks = groupOcrLines([line("second paragraph", 200, 95), line("first paragraph", 0, 95), line("more of the first", 40, 95)]);
  expect(texts(blocks)).toEqual(["first paragraph more of the first", "second paragraph"]);
});
