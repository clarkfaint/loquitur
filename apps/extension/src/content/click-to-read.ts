/**
 * Read from here (F§10.2): the `Alt`+click that turns a point on a page into a position in the document.
 *
 * A plain click belongs to the page — it follows a link, folds a section, focuses a field — so this module only
 * ever looks at a click the reader held `Alt` for, and it consumes that click only once it has an answer. A
 * point that is not over readable text is left to the page untouched.
 *
 * The mapping is deliberately not arithmetic on the element's own text. Block text is *normalized* (F§5.2): a
 * run of spaces collapses to one, leading and trailing whitespace goes, a soft hyphen disappears. An offset
 * counted over `textContent` therefore drifts from the offset the model holds, and the drift grows with every
 * collapsed run before the point. So the point is answered with containment instead: the caret's text node names
 * the block, and then each sentence and word of that block is asked whether its own `Range` — resolved by the
 * map, which is exact — holds the caret.
 *
 * Measured on this host: a range holds its own boundaries, so a caret in the space right after a word joins that
 * word, which is where a reader clicking the end of a word is pointing. A caret no range can address at all — a
 * text node that left the document between the extraction and the click — falls to the next sentence or word
 * whose start follows it, so the answer is never a refusal while there is text to name.
 */

import type { Block, DocumentModel, Sentence, Word } from "@lectern/core";
import type { TextMap } from "./text-map";

/** A position in the document's text, as the player reports and accepts it (F§5.1). */
export interface PagePosition {
  /** F§5.1's global sentence index. */
  sentenceIndex: number;
  /** The word's index within that sentence. */
  wordIndex: number;
}

/** `Node.nodeType` of a text node: the only node a readable word can be pointed at. */
const TEXT_NODE = 3;

/**
 * Whether a click is a request to read from the point it landed on: the primary button with `Alt` held and no
 * other modifier. Nothing else counts — a plain click, a context-menu click and a modified selection click all
 * belong to the page or to the browser.
 */
export function isReadFromHereClick(event: MouseEvent): boolean {
  return event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey && event.button === 0;
}

/**
 * The position a point on the page names, or `null` when it names no readable word: a point off the mapped
 * text, over the page's chrome, over a field, or over a block the model does not have.
 */
export function positionForPoint(textMap: TextMap, model: DocumentModel, x: number, y: number): PagePosition | null {
  const owner = ownerDocumentOf(textMap);
  if (owner === null) return null;
  const caret = caretAt(owner, x, y);
  if (caret === null || caret.node.nodeType !== TEXT_NODE) return null;
  const entry = textMap.entries.find((candidate) => candidate.node === caret.node);
  if (entry === undefined) return null;
  const block = model.blocks[entry.blockIndex];
  if (block === undefined || block.index !== entry.blockIndex) return null;
  const sentence = sentenceAt(textMap, block, caret);
  if (sentence === null) return null;
  const word = wordAt(textMap, block, sentence, caret);
  if (word === null) return null;
  return { sentenceIndex: sentence.index, wordIndex: word.index };
}

/** A caret as the browser reports it: a node and an offset into it. */
interface Caret {
  node: Node;
  offset: number;
}

/** The caret at a point, from either of the two APIs that answer one. */
function caretAt(owner: Document, x: number, y: number): Caret | null {
  const position = owner.caretPositionFromPoint?.(x, y) ?? null;
  if (position !== null) return { node: position.offsetNode, offset: position.offset };
  const range = owner.caretRangeFromPoint?.(x, y) ?? null;
  if (range === null) return null;
  return { node: range.startContainer, offset: range.startOffset };
}

/** The document the mapped text belongs to, or `null` for a map with no blocks at all. */
function ownerDocumentOf(textMap: TextMap): Document | null {
  for (const block of textMap.blocks) {
    if (block.element.ownerDocument !== null) return block.element.ownerDocument;
  }
  return null;
}

/**
 * The sentence the caret sits in. A range holds its own boundaries, so a caret at a sentence's last character + 1
 * still belongs to that sentence; a caret no range can address — a detached node — falls to the next sentence
 * whose start follows it, and the last sentence of the block is the floor.
 */
function sentenceAt(textMap: TextMap, block: Block, caret: Caret): Sentence | null {
  let next: Sentence | null = null;
  for (const sentence of block.sentences) {
    const range = textMap.rangeFor(block.index, sentence.charStart, sentence.charEnd);
    if (range === null) continue;
    if (holds(range, caret)) return sentence;
    if (next === null && isBefore(range, caret)) next = sentence;
  }
  return next ?? block.sentences.at(-1) ?? null;
}

/** The word the caret sits in, by the same rule: containment first, then the next word, then the last one. */
function wordAt(textMap: TextMap, block: Block, sentence: Sentence, caret: Caret): Word | null {
  let next: Word | null = null;
  for (const word of sentence.words) {
    const range = textMap.rangeFor(block.index, sentence.charStart + word.charStart, sentence.charStart + word.charEnd);
    if (range === null) continue;
    if (holds(range, caret)) return word;
    if (next === null && isBefore(range, caret)) next = word;
  }
  return next ?? sentence.words.at(-1) ?? null;
}

/** Whether a range holds the caret. An offset one past a node's end is clamped: it is a boundary, not an error. */
function holds(range: Range, caret: Caret): boolean {
  try {
    return range.isPointInRange(caret.node, Math.min(caret.offset, lengthOf(caret.node)));
  } catch {
    // A caret in a node the range cannot address — a detached node — answers "not held" rather than throwing.
    return false;
  }
}

/** Whether the caret is before a range's start, which `Range.comparePoint` answers as `-1`. */
function isBefore(range: Range, caret: Caret): boolean {
  try {
    return range.comparePoint(caret.node, Math.min(caret.offset, lengthOf(caret.node))) === -1;
  } catch {
    return false;
  }
}

/** How many positions a node addresses: its characters when it is text, its children otherwise. */
function lengthOf(node: Node): number {
  return node.nodeType === TEXT_NODE ? (node as Text).data.length : node.childNodes.length;
}
