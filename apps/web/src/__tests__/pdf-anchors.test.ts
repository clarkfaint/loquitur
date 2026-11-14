/**
 * The anchor index (F§5.1, F§10.1): the three questions the page view asks of it before it can paint
 * anything — which anchor a sentence-and-word names, which anchors one sentence has, and what a page
 * that cannot answer for an anchor looks like.
 *
 * The anchors are written out here rather than read from a fixture, because what is under test is the
 * index's own arithmetic and not the hub's parsing: U-007's tests own the anchors a PDF produces.
 */

import type { PdfAnchor } from "@lectern/core";
import { describe, expect, it } from "vitest";
import { anchorKey, indexAnchors, rectsForAnchor, sentenceAnchors } from "../reader/pdf-anchors";

/** The three words of the first sentence: two on one text item, the third on the item after it. */
const FIRST_WORD: PdfAnchor = { sentenceIndex: 0, wordIndex: 0, page: 1, itemIndex: 4, charStart: 0, charEnd: 3 };
const SECOND_WORD: PdfAnchor = { sentenceIndex: 0, wordIndex: 1, page: 1, itemIndex: 4, charStart: 4, charEnd: 8 };
const THIRD_WORD: PdfAnchor = { sentenceIndex: 0, wordIndex: 2, page: 1, itemIndex: 5, charStart: 0, charEnd: 5 };
const FIRST_SENTENCE: PdfAnchor[] = [FIRST_WORD, SECOND_WORD, THIRD_WORD];

/** One word of the sentence after it, drawn on the page after it. */
const SECOND_SENTENCE: PdfAnchor = { sentenceIndex: 1, wordIndex: 0, page: 2, itemIndex: 0, charStart: 10, charEnd: 15 };

/** Every anchor of the two sentences, in the order the document reads them. */
const DOCUMENT: PdfAnchor[] = [...FIRST_SENTENCE, SECOND_SENTENCE];

/** A span holding one text node, as the text layer builds them. */
function spanOf(text: string): HTMLElement {
  const span = document.createElement("span");
  span.append(document.createTextNode(text));
  return span;
}

describe("indexAnchors", () => {
  it("answers the anchor a sentence and a word name, and nothing for a word it has none of", () => {
    const index = indexAnchors(DOCUMENT);

    expect(index.size).toBe(DOCUMENT.length);
    expect(index.get(anchorKey(0, 1))).toEqual(SECOND_WORD);
    expect(index.get(anchorKey(0, 2))?.itemIndex).toBe(5);
    expect(index.get(anchorKey(1, 0))).toEqual(SECOND_SENTENCE);
    expect(index.get(anchorKey(1, 1))).toBeUndefined();
    expect(index.get(anchorKey(9, 9))).toBeUndefined();
  });
});

describe("sentenceAnchors", () => {
  it("answers one sentence's anchors in word order, and no other sentence's", () => {
    // Handed in backwards, so the order the answer comes back in is the index's own doing.
    const descending = [...DOCUMENT].reverse();

    expect(sentenceAnchors(descending, 0).map((anchor) => anchor.wordIndex)).toEqual([0, 1, 2]);
    expect(sentenceAnchors(descending, 0).map((anchor) => anchor.page)).toEqual([1, 1, 1]);
    expect(sentenceAnchors(descending, 1)).toEqual([SECOND_SENTENCE]);
    expect(sentenceAnchors(descending, 2)).toEqual([]);
  });
});

describe("rectsForAnchor", () => {
  it("answers no rectangles when the page has no span for the anchor's item", () => {
    const itemThePageDoesNotHave: PdfAnchor = { ...FIRST_WORD, itemIndex: 99 };

    expect(rectsForAnchor([], FIRST_WORD)).toEqual([]);
    expect(rectsForAnchor([null], FIRST_WORD)).toEqual([]);
    expect(rectsForAnchor([spanOf("a line of the page")], itemThePageDoesNotHave)).toEqual([]);
  });

  it("answers no rectangles when the span the anchor names holds no text node", () => {
    // An item with no string at all is what the empty items a writer leaves beside its text look like.
    const empty = document.createElement("span");
    const spans = [empty, empty, empty, empty, empty];

    expect(rectsForAnchor(spans, FIRST_WORD)).toEqual([]);
    expect(rectsForAnchor(spans, THIRD_WORD)).toEqual([]);
  });
});
