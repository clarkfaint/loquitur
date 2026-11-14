/**
 * From the document model to DOM ranges, and from a point on the page back to a position (F§5.1, F§10.1).
 *
 * F§5.1 numbers a sentence globally and a word within its sentence, and gives both as offsets into
 * `Block.text` and `Sentence.text`. A block renders as one element holding one text node, so a sentence
 * or a word is a pair of offsets into that node and nothing more: the range is built by walking the
 * element's text nodes, which stays correct even if a block ever gains a second one.
 *
 * The reverse direction is the caret-from-point API: the browser answers which text node and offset lies
 * under a pointer, and this module turns that into the sentence and word a click asked for.
 */

import type { Block, DocumentModel, Sentence, Word } from "@lectern/core";

/** A point in the document's text, as the reader reports it: a global sentence index and a word index. */
export interface TextPosition {
  sentenceIndex: number;
  wordIndex: number;
}

/** One text node of a block, with the span of block text it covers. */
interface TextSpan {
  node: Text;
  start: number;
  end: number;
}

/** A caret as the browser reports it: a node and an offset into it. */
interface Caret {
  node: Node;
  offset: number;
}

/** Every text node of `element`, in document order, with the offsets it covers. */
function textSpans(element: Element): TextSpan[] {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const spans: TextSpan[] = [];
  let offset = 0;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text;
    const length = text.data.length;
    spans.push({ node: text, start: offset, end: offset + length });
    offset += length;
  }
  return spans;
}

/** The span an offset falls in, and the offset's place inside it. A boundary belongs to the later span. */
function spanAt(spans: TextSpan[], offset: number): { span: TextSpan; local: number } | null {
  const first = spans[0];
  const last = spans.at(-1);
  if (first === undefined || last === undefined) return null;
  if (offset <= first.start) return { span: first, local: 0 };
  for (const span of spans) {
    if (offset <= span.end) return { span, local: offset - span.start };
  }
  return { span: last, local: last.end - last.start };
}

/**
 * The range covering `[start, end)` of a block's text, clamped to what the block actually holds. A block
 * with no text node at all — an element whose content is not text — yields a range over the whole element
 * rather than a range that does not exist.
 */
function rangeForOffsets(blockEl: Element, start: number, end: number): Range {
  const range = blockEl.ownerDocument.createRange();
  const spans = textSpans(blockEl);
  if (spans.length === 0) {
    range.selectNode(blockEl);
    return range;
  }
  const total = spans.at(-1)?.end ?? 0;
  const from = Math.min(Math.max(start, 0), total);
  const to = Math.min(Math.max(end, from), total);
  const startPoint = spanAt(spans, from);
  const endPoint = spanAt(spans, to);
  if (startPoint === null || endPoint === null) {
    range.selectNode(blockEl);
    return range;
  }
  range.setStart(startPoint.span.node, startPoint.local);
  range.setEnd(endPoint.span.node, endPoint.local);
  return range;
}

/** The range covering one sentence of a block (F§5.1's `charStart`/`charEnd` are block offsets). */
export function rangeForSentence(blockEl: Element, sentence: Sentence): Range {
  return rangeForOffsets(blockEl, sentence.charStart, sentence.charEnd);
}

/** The range covering one word, whose offsets are relative to its sentence (F§5.1). */
export function rangeForWord(blockEl: Element, sentence: Sentence, word: Word): Range {
  return rangeForOffsets(blockEl, sentence.charStart + word.charStart, sentence.charStart + word.charEnd);
}

/** The caret the browser places at a point on the page, from either of the two APIs that answer it. */
function caretAt(owner: Document, x: number, y: number): Caret | null {
  const position = owner.caretPositionFromPoint?.(x, y) ?? null;
  if (position !== null) return { node: position.offsetNode, offset: position.offset };
  const range = owner.caretRangeFromPoint?.(x, y) ?? null;
  if (range === null) return null;
  return { node: range.startContainer, offset: range.startOffset };
}

/** How far into the block's text a caret sits, counted in characters. */
function offsetIn(blockEl: Element, caret: Caret): number | null {
  if (!blockEl.contains(caret.node)) return null;
  const range = blockEl.ownerDocument.createRange();
  range.selectNodeContents(blockEl);
  try {
    range.setEnd(caret.node, caret.offset);
  } catch {
    return null;
  }
  return range.toString().length;
}

/** The sentence an offset falls in; an offset in the whitespace between sentences joins the earlier one. */
function sentenceAtOffset(block: Block, offset: number): Sentence | undefined {
  let candidate: Sentence | undefined;
  for (const sentence of block.sentences) {
    if (offset >= sentence.charStart && offset < sentence.charEnd) return sentence;
    if (sentence.charStart <= offset) candidate = sentence;
  }
  return candidate ?? block.sentences[0];
}

/** The word an offset falls in; an offset in the space between words joins the word before it. */
function wordAtOffset(sentence: Sentence, offset: number): Word | undefined {
  let candidate: Word | undefined;
  for (const word of sentence.words) {
    if (offset >= word.charStart && offset < word.charEnd) return word;
    if (word.charStart <= offset) candidate = word;
  }
  return candidate ?? sentence.words[0];
}

/**
 * The position a point on the page points at, or `null` when the point is not over the reader's text at
 * all: outside `root`, over an element that holds no text, or over a block the document does not have.
 */
export function positionFromPoint(root: Element, doc: DocumentModel, x: number, y: number): TextPosition | null {
  const caret = caretAt(root.ownerDocument, x, y);
  if (caret === null || !root.contains(caret.node)) return null;
  const parent = caret.node instanceof Element ? caret.node : caret.node.parentElement;
  const blockEl = parent?.closest("[data-block]") ?? null;
  if (blockEl === null || !root.contains(blockEl)) return null;
  const blockIndex = Number(blockEl.getAttribute("data-block"));
  const block = Number.isInteger(blockIndex) ? doc.blocks[blockIndex] : undefined;
  if (block === undefined) return null;
  const offset = offsetIn(blockEl, caret);
  if (offset === null) return null;
  const sentence = sentenceAtOffset(block, offset);
  if (sentence === undefined) return null;
  const word = wordAtOffset(sentence, offset - sentence.charStart);
  return { sentenceIndex: sentence.index, wordIndex: word === undefined ? 0 : word.index };
}
