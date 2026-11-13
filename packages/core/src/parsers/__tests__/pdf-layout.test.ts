/**
 * F§5.4's PDF layout rules, on synthetic items.
 *
 * No PDF and no pdfjs here: just baselines, type sizes and strings, so what is being pinned is the
 * rule rather than one fixture's behaviour. The sizes and distances are the fixture's own — a 14-point
 * body, 30-point leading, 45 points between paragraphs — which is what makes the arithmetic in the
 * comments checkable against real geometry.
 */

import { expect, test } from "vitest";
import type { PdfTextItem } from "../pdf-layout";
import { dehyphenate, detectHeadings, groupLines, groupParagraphs, medianFontSize } from "../pdf-layout";

/** The body size the synthetic pages are set in. */
const BODY = 14;

/** One item: its width follows its string, so the rule that separates two items has geometry to read. */
function item(x: number, y: number, str: string, fontSize = BODY, itemIndex = 0): PdfTextItem {
  return { str, x, y, width: str.length * fontSize * 0.5, height: fontSize, fontSize, itemIndex };
}

/** A page of one-line paragraphs at 30-point leading, from `top` downwards. */
function bodyLines(count: number, top = 700): PdfTextItem[] {
  return Array.from({ length: count }, (_unused, index) => item(100, top - index * 30, `Line ${index + 1}`, BODY, index));
}

test("the page median is the median of the type sizes the page's items report", () => {
  expect(medianFontSize([])).toBe(0);
  expect(medianFontSize([item(0, 700, "a", 10), item(0, 700, "b", BODY), item(0, 700, "c", 21)])).toBe(BODY);
  expect(medianFontSize([item(0, 700, "a", 10), item(0, 700, "b", BODY)])).toBe(12);
});

test("items sharing a baseline are one line, left to right, with a space where the geometry has a gap", () => {
  const lines = groupLines([item(300, 700, "Right", BODY, 1), item(100, 700, "Left", BODY, 0)]);

  expect(lines).toHaveLength(1);
  expect(lines[0]?.text).toBe("Left Right");
  expect(lines[0]?.x).toBe(100);
  expect(lines[0]?.y).toBe(700);
  expect(lines[0]?.fontSize).toBe(BODY);
  expect(lines[0]?.items.map((entry) => entry.itemIndex)).toEqual([0, 1]);
  expect(lines[0]?.sources[0]).toEqual({ itemIndex: 0, offset: 0 });
  expect(lines[0]?.sources[4]).toBeNull();
  expect(lines[0]?.sources[5]).toEqual({ itemIndex: 1, offset: 0 });
});

test("two items with no space between them are one run of characters", () => {
  const lines = groupLines([item(100, 700, "punc", BODY, 0), item(128, 700, ",", BODY, 1)]);

  expect(lines).toHaveLength(1);
  expect(lines[0]?.text).toBe("punc,");
  expect(lines[0]?.sources[4]).toEqual({ itemIndex: 1, offset: 0 });
});

test("a baseline difference beyond a fifth of the type size starts a new line", () => {
  const lines = groupLines([item(100, 700, "Top", BODY, 0), item(121, 698.5, "Same", BODY, 1), item(100, 680, "Next", BODY, 2)]);

  expect(lines.map((line) => line.text)).toEqual(["TopSame", "Next"]);
});

test("a vertical gap above 1.5x the median line height starts a paragraph", () => {
  // 30-point leading at a 14-point type leaves a 16-point gap, and 1.5 x 14 is 21: one paragraph.
  const tight = groupParagraphs(groupLines(bodyLines(3)));
  expect(tight).toHaveLength(1);
  expect(tight[0]?.text).toBe("Line 1 Line 2 Line 3");
  expect(tight[0]?.fontSize).toBe(BODY);

  // 45-point baselines leave a 31-point gap, which is more than 21: a paragraph each.
  const spaced = groupParagraphs(groupLines([item(100, 700, "First paragraph.", BODY, 0), item(100, 655, "Second paragraph.", BODY, 1)]));
  expect(spaced.map((paragraph) => paragraph.text)).toEqual(["First paragraph.", "Second paragraph."]);

  // The comparison is strict: a 35-point baseline distance is exactly 1.5 x 14 after the line height, and stays one paragraph.
  const boundary = groupParagraphs(groupLines([item(100, 700, "One.", BODY, 0), item(100, 665, "Two.", BODY, 1)]));
  expect(boundary).toHaveLength(1);
  expect(boundary[0]?.text).toBe("One. Two.");
});

test("a paragraph's provenance names the item behind every character it kept", () => {
  const [paragraph] = groupParagraphs(groupLines([item(100, 700, "First line.", BODY, 0), item(100, 670, "Second line.", BODY, 1)]));

  expect(paragraph?.text).toBe("First line. Second line.");
  expect(paragraph?.sources).toHaveLength("First line. Second line.".length);
  expect(paragraph?.sources[0]).toEqual({ itemIndex: 0, offset: 0 });
  expect(paragraph?.sources[5]).toEqual({ itemIndex: 0, offset: 5 });
  expect(paragraph?.sources[11]).toBeNull();
  expect(paragraph?.sources[12]).toEqual({ itemIndex: 1, offset: 0 });
});

test("a line ending in a hyphen continues into a lowercase next line as one word", () => {
  expect(dehyphenate(["the top of the light-", "house was lit"])).toBe("the top of the lighthouse was lit");
  expect(dehyphenate([])).toBe("");
  expect(dehyphenate(["One line only."])).toBe("One line only.");
  expect(dehyphenate(["First line.", "Second line."])).toBe("First line. Second line.");
  // An uppercase continuation is not a broken word, so the hyphen and the space both stay.
  expect(dehyphenate(["See the note-", "Keeper's log"])).toBe("See the note- Keeper's log");
});

test("paragraphs de-hyphenate across their own line breaks, and keep the provenance of both halves", () => {
  const [paragraph] = groupParagraphs(
    groupLines([item(100, 700, "the top of the light-", BODY, 0), item(100, 670, "house was lit", BODY, 1)]),
  );

  expect(paragraph?.text).toBe("the top of the lighthouse was lit");
  expect(paragraph?.sources[15]).toEqual({ itemIndex: 0, offset: 15 });
  expect(paragraph?.sources[19]).toEqual({ itemIndex: 0, offset: 19 });
  expect(paragraph?.sources[20]).toEqual({ itemIndex: 1, offset: 0 });
});

test("a line at 1.25x the page median or larger is a heading", () => {
  const atThreshold = [...bodyLines(5), item(100, 400, "Heading", BODY * 1.25, 5)];
  expect(medianFontSize(atThreshold)).toBe(BODY);
  expect(detectHeadings(groupLines(atThreshold), medianFontSize(atThreshold)).map((line) => line.text)).toEqual(["Heading"]);

  const justBelow = [...bodyLines(5), item(100, 400, "Not quite", BODY * 1.25 - 0.01, 5)];
  expect(detectHeadings(groupLines(justBelow), medianFontSize(justBelow))).toEqual([]);

  // A page with nothing measurable has no headings, rather than all of them.
  expect(detectHeadings(groupLines([]), 0)).toEqual([]);
});
