/**
 * The highlight model's tests (AGENTS.md §7).
 *
 * `highlight-model.ts` is the only module of this unit that can run under Node: every other file it ships
 * stands on React Native — the list, the bar, the sheets and the screen all need a renderer and a device
 * service — and those are covered by the on-device diagnostics screen that U-052 verifies through `adb`, not by
 * this package's Node test program. So the two invariants the reader's text depends on are asserted here: the
 * runs of a block always concatenate back to that block's own text, and the run marked as the word is the word
 * the player is on.
 *
 * The documents are built with `@lectern/core`'s own builder rather than written by hand, because the offsets
 * these cases are about are the ones the tokenizer produces: a hand-written `Block` would assert the model
 * against numbers that only this file believes in. The fixture text is original Lectern test text.
 */

import { type Block, buildDocument, type DocumentModel } from "@lectern/core";
import { describe, expect, it } from "vitest";
import { type ActivePoint, blockIndexForSentence, segmentsForBlock } from "../highlight-model";

/** The document every case reads: a heading, a paragraph of two sentences, and a page header (furniture). */
const DOC: DocumentModel = buildDocument(
  [
    { kind: "heading", level: 1, text: "The pier at dawn" },
    { kind: "paragraph", text: "The morning ferry waits at the pier. Gulls circle above it, and the water is flat." },
    { kind: "header", text: "Lectern, page 1" },
  ],
  { title: "The pier", source: { kind: "txt" } },
);

/** The block with a given index, or a failure naming the index. */
function blockAt(doc: DocumentModel, index: number): Block {
  const block = doc.blocks[index];
  if (block === undefined) throw new Error(`the fixture has no block ${index}`);
  return block;
}

/** Every sentence of the document, with the block that holds it. */
function sentences(doc: DocumentModel): { block: Block; sentenceIndex: number; wordCount: number }[] {
  return doc.blocks.flatMap((block) =>
    block.sentences.map((sentence) => ({ block, sentenceIndex: sentence.index, wordCount: sentence.words.length })),
  );
}

describe("segmentsForBlock", () => {
  it("concatenates back to the block's text, for every position in the document", () => {
    const positions: ActivePoint[] = [];
    for (const entry of sentences(DOC)) {
      for (let wordIndex = 0; wordIndex <= entry.wordCount; wordIndex += 1) {
        positions.push({ sentenceIndex: entry.sentenceIndex, wordIndex });
      }
    }
    // A sentence the document does not have, and a word past the end of every sentence, are the two ways a
    // restored position can arrive out of range.
    positions.push({ sentenceIndex: 999, wordIndex: 0 }, { sentenceIndex: 0, wordIndex: 99 });

    for (const block of DOC.blocks) {
      for (const active of positions) {
        const text = segmentsForBlock(block, active)
          .map((segment) => segment.text)
          .join("");
        expect(text, `block ${block.index} at sentence ${active.sentenceIndex}`).toBe(block.text);
      }
    }
  });

  it("marks the active word as one run whose text is that word", () => {
    for (const entry of sentences(DOC)) {
      const block = entry.block;
      const sentence = block.sentences.find((candidate) => candidate.index === entry.sentenceIndex);
      if (sentence === undefined) throw new Error("the fixture lost its sentence");

      for (const word of sentence.words) {
        const segments = segmentsForBlock(block, { sentenceIndex: entry.sentenceIndex, wordIndex: word.index });
        const marked = segments.filter((segment) => segment.role === "word");
        expect(marked).toHaveLength(1);
        expect(marked[0]?.text).toBe(word.text);
      }
    }
  });

  it("leaves the whole sentence marked when the word index is past the end", () => {
    const entry = sentences(DOC)[1];
    if (entry === undefined) throw new Error("the fixture has no second sentence");
    const sentence = entry.block.sentences.find((candidate) => candidate.index === entry.sentenceIndex);
    if (sentence === undefined) throw new Error("the fixture lost its sentence");

    const segments = segmentsForBlock(entry.block, { sentenceIndex: entry.sentenceIndex, wordIndex: 99 });
    expect(segments.some((segment) => segment.role === "word")).toBe(false);
    const marked = segments.filter((segment) => segment.role === "sentence");
    expect(marked.map((segment) => segment.text).join("")).toBe(sentence.text);
  });

  it("is one plain run for a block that does not hold the active sentence", () => {
    const active: ActivePoint = { sentenceIndex: 0, wordIndex: 0 };
    expect(blockIndexForSentence(DOC, 0)).toBe(0);

    for (const block of DOC.blocks) {
      if (block.index === 0) continue;
      expect(segmentsForBlock(block, active)).toEqual([{ text: block.text, role: "plain" }]);
    }
  });

  it("marks a block of furniture like any other block when the position is inside it", () => {
    const header = blockAt(DOC, 2);
    expect(header.skip).toBe(true);
    const sentence = header.sentences[0];
    if (sentence === undefined) throw new Error("the fixture's header has no sentence");

    const segments = segmentsForBlock(header, { sentenceIndex: sentence.index, wordIndex: 0 });
    expect(segments.some((segment) => segment.role === "word")).toBe(true);
    expect(segments.map((segment) => segment.text).join("")).toBe(header.text);
  });
});

describe("blockIndexForSentence", () => {
  it("resolves every sentence of the document to the block that holds it", () => {
    for (const entry of sentences(DOC)) {
      expect(blockIndexForSentence(DOC, entry.sentenceIndex)).toBe(entry.block.index);
    }
  });

  it("answers null for a sentence the document does not have", () => {
    expect(blockIndexForSentence(DOC, 999)).toBeNull();
  });
});
