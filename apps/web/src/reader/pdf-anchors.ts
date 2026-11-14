/**
 * F§5.1's `PdfAnchor`s, resolved against a page's text layer (F§10.1).
 *
 * An anchor says where one word of the document was drawn: the page, the index of the text item that
 * drew it among the page's own items, and the character range inside that item's string. A text layer
 * is those same items as spans, so an anchor is a pair of offsets into one span and nothing more —
 * provided the span a given `itemIndex` names is found without guessing at text. That is all this
 * module does.
 *
 * `indexAnchors` keys a document's anchors so an active position is one lookup (F§5.6(d) samples it
 * every frame); `sentenceAnchors` gathers the anchors of one sentence, because a sentence runs across
 * as many items as it has lines and can cross a page; and `rangeForAnchor` — with `rectsForAnchor`
 * over it — turns one anchor into the range, and the rectangles, it covers on the page it names.
 */

import type { PdfAnchor } from "@lectern/core";

/** The key one word's anchor is found under: its sentence, and the word inside it (F§5.1). */
export function anchorKey(sentenceIndex: number, wordIndex: number): string {
  return `${sentenceIndex}:${wordIndex}`;
}

/**
 * A page's text-layer spans, one per text item of that page, indexed the way a `PdfAnchor` indexes
 * them: the position in the list is the anchor's `itemIndex`, and an item the layer did not draw a
 * span for — the empty items a writer leaves beside the text it draws — is `null`.
 */
export type TextLayerSpans = readonly (HTMLElement | null)[];

/** Every anchor of a document under its own key, so an active position is one map lookup. */
export function indexAnchors(anchors: readonly PdfAnchor[]): Map<string, PdfAnchor> {
  const index = new Map<string, PdfAnchor>();
  for (const anchor of anchors) index.set(anchorKey(anchor.sentenceIndex, anchor.wordIndex), anchor);
  return index;
}

/** The anchors of one sentence, in word order, and no others. */
export function sentenceAnchors(anchors: readonly PdfAnchor[], sentenceIndex: number): PdfAnchor[] {
  return anchors.filter((anchor) => anchor.sentenceIndex === sentenceIndex).sort((left, right) => left.wordIndex - right.wordIndex);
}

/** The one text node a span holds, or `null` when there is no span or it holds no text of its own. */
function textNodeOf(span: HTMLElement | null | undefined): Text | null {
  if (span === null || span === undefined) return null;
  const node = span.firstChild;
  return node !== null && node.nodeType === Node.TEXT_NODE ? (node as Text) : null;
}

/** The anchor's character range clamped into the span's own text: an end never before its start. */
function offsetsIn(text: Text, anchor: PdfAnchor): { from: number; to: number } {
  const from = Math.min(Math.max(anchor.charStart, 0), text.data.length);
  return { from, to: Math.min(Math.max(anchor.charEnd, from), text.data.length) };
}

/**
 * `rangeForAnchor(textLayerSpans, anchor)` — the range the anchor covers on the page it names, or
 * `null` when that page has no span for the item, or the span holds no text node.
 *
 * `charStart`/`charEnd` are offsets into the item's own string, and a span's text node is that string,
 * so the two are the same coordinates. They are clamped to what the node holds, which is what keeps an
 * anchor from a document that changed in the library — or from a page rendered at another scale —
 * from making a range that cannot be built.
 */
export function rangeForAnchor(textLayerSpans: TextLayerSpans, anchor: PdfAnchor): Range | null {
  const span = textLayerSpans[anchor.itemIndex] ?? null;
  const text = textNodeOf(span);
  if (span === null || text === null) return null;
  const { from, to } = offsetsIn(text, anchor);
  const range = span.ownerDocument.createRange();
  range.setStart(text, from);
  range.setEnd(text, to);
  return range;
}

/**
 * `rectsForAnchor(textLayerSpans, anchor)` — the rectangles the anchor covers, in the page's own
 * coordinates: one per line of the item the range falls on. An anchor with no range has no
 * rectangles, which is the answer for a page that is not drawn rather than a failure.
 */
export function rectsForAnchor(textLayerSpans: TextLayerSpans, anchor: PdfAnchor): DOMRect[] {
  const range = rangeForAnchor(textLayerSpans, anchor);
  return range === null ? [] : Array.from(range.getClientRects());
}
