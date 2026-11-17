/**
 * U-063's contract (F§9): F§9's segmentation — the text a model is allowed to see, packed into the pieces one
 * map call reads.
 *
 * Every case builds a real `DocumentModel` with `buildDocument`, so the sentences a split is taken at are the
 * ones F§5.3 really produced rather than a test's idea of a sentence, and every length a case asserts is read
 * back out of the built blocks rather than counted by hand.
 */

import { buildDocument, type DocumentModel, type RawBlock } from "@lectern/core";
import { expect, test } from "vitest";
import { SEGMENT_MAX_CHARS, segmentDocument } from "../segment";

/** What separates two blocks inside one segment: the module's own separator, spelled out so a case can compute. */
const BLOCK_SEPARATOR = "\n\n";

/** A paragraph block of one text, with any geometry a case wants to give it. */
function block(text: string, extra: Omit<RawBlock, "kind" | "text"> = {}): RawBlock {
  return { kind: "paragraph", text, ...extra };
}

/** The document one case packs: its blocks, built the way F§5.1–F§5.4 build them. */
function documentOf(blocks: readonly RawBlock[]): DocumentModel {
  return buildDocument([...blocks], { source: { kind: "txt" } });
}

/** A document of one paragraph per text. */
function paragraphsOf(texts: readonly string[]): DocumentModel {
  return documentOf(texts.map((text) => block(text)));
}

/** A paragraph of `count` copies of one word, so a case knows the length of the text it is packing. */
function paragraph(word: string, count: number): string {
  return `${Array.from({ length: count }, () => word).join(" ")}.`;
}

/** A paragraph of exactly `chars` characters: whole words separated by single spaces, ending in a full stop. */
function paragraphOf(chars: number): string {
  const unit = "alpha ";
  const body = unit.repeat(Math.floor((chars - 1) / unit.length));
  const tail = "b".repeat(chars - 1 - body.length);
  return `${body}${tail}.`;
}

test("blocks pack into as few segments as the limit allows, and no segment is longer than it", () => {
  const doc = paragraphsOf([paragraph("Alpha", 10), paragraph("Bravo", 10), paragraph("Charlie", 10)]);
  const [first = 0, second = 0, third = 0] = doc.blocks.map((modelBlock) => modelBlock.text.length);
  const pairLimit = first + BLOCK_SEPARATOR.length + second;

  // A limit that holds exactly two blocks packs them together and starts a second segment for the third.
  const paired = segmentDocument(doc, pairLimit);
  expect(paired).toHaveLength(2);
  expect(paired[0]).toBe(`${doc.blocks[0]?.text}${BLOCK_SEPARATOR}${doc.blocks[1]?.text}`);
  expect(paired[0]?.length).toBe(pairLimit);
  expect(paired[1]).toBe(doc.blocks[2]?.text);
  expect(paired[1]?.length).toBe(third);

  // F§9's own ceiling holds all three, so the whole document is one segment.
  expect(SEGMENT_MAX_CHARS).toBe(12000);
  const whole = segmentDocument(doc);
  expect(whole).toHaveLength(1);
  expect(whole[0]).toBe(doc.blocks.map((modelBlock) => modelBlock.text).join(BLOCK_SEPARATOR));
  for (const segment of whole) expect(segment.length).toBeLessThanOrEqual(SEGMENT_MAX_CHARS);
});

test("a skipped block never reaches a segment", () => {
  const doc = documentOf([
    block(paragraph("Body", 8)),
    block("1 A footnote nobody should summarize.", { fontRatio: 0.7 }),
    block(paragraph("More", 8)),
  ]);
  expect(doc.blocks.map((modelBlock) => modelBlock.skip)).toEqual([false, true, false]);

  const segments = segmentDocument(doc);
  expect(segments).toHaveLength(1);
  expect(segments[0]).toBe(`${doc.blocks[0]?.text}${BLOCK_SEPARATOR}${doc.blocks[2]?.text}`);
  expect(segments[0]).not.toContain("footnote nobody");
});

test("a block longer than the limit is split at its own sentence boundaries", () => {
  const sentences = Array.from({ length: 20 }, (_unused, index) => `Sentence number ${index + 1} stands here.`);
  const doc = paragraphsOf([sentences.join(" ")]);
  const limit = 100;

  const segments = segmentDocument(doc, limit);
  expect(segments.length).toBeGreaterThan(1);
  for (const segment of segments) {
    expect(segment.length).toBeLessThanOrEqual(limit);
    expect(segment.endsWith(".")).toBe(true);
  }
  // Splitting and re-joining at the boundaries loses nothing: the pieces are the block's own sentences.
  expect(segments.join(" ")).toBe(doc.blocks[0]?.text);
});

test("a document with nothing to read yields no segments", () => {
  expect(segmentDocument(buildDocument([], { source: { kind: "txt" } }))).toEqual([]);

  const furnitureOnly = documentOf([block("1 A lone footnote.", { fontRatio: 0.7 })]);
  expect(furnitureOnly.blocks[0]?.skip).toBe(true);
  expect(segmentDocument(furnitureOnly)).toEqual([]);
});

test("a 40 000-character paragraph is four segments at F§9's ceiling", () => {
  const doc = paragraphsOf([paragraphOf(40000)]);
  expect(doc.blocks[0]?.text.length).toBe(40000);

  const segments = segmentDocument(doc);
  expect(segments).toHaveLength(4);
  for (const segment of segments) expect(segment.length).toBeLessThanOrEqual(SEGMENT_MAX_CHARS);
  expect(segments.join(" ")).toBe(doc.blocks[0]?.text);
});
