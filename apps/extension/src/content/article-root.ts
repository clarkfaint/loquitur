/**
 * The page's article root (F§10.2): where reading starts.
 *
 * Readability decides what a page's article is, and it decides it by editing the document it is handed. A
 * live page must not be edited, so this module hands it a clone and works with two index tables that a
 * single walk of each tree produces:
 *
 * - the *copy's* elements are numbered in pre-order, and every one of them carries its number in an
 *   attribute, so an element Readability hands back can be named by the number it carries;
 * - the *live* document's elements are listed in the same pre-order, which is the same list, because a
 *   deep copy of a tree has the same elements in the same order.
 *
 * The index is therefore the whole correspondence between the two trees, and the attribute never reaches
 * the live page. Pre-order numbering has a second use: every element's subtree is a contiguous interval of
 * indexes (an element numbered `i` with `s` elements under it covers `i … i + s - 1`), so the *lowest common
 * ancestor* of a set of indexes is the narrowest interval covering them all — found in one pass, with no
 * parent pointers and no mapping of copied nodes back to their originals. That ancestor is the article
 * root: Readability returns a wrapper it built itself, whose children are the copy's numbered elements, so
 * the wrapper cannot be used and its surviving children can.
 *
 * `main`, then `body`, is the fallback when Readability finds no article structure at all — it returns
 * nothing, or something with no numbered element left in it — because a page that resists article
 * extraction is still a page with text.
 */

import { Readability } from "@mozilla/readability";

/**
 * The attribute the *copy's* elements carry their pre-order index in. It is written only to the copy, so it
 * never appears in the live page; the tests assert exactly that.
 */
export const CLONE_INDEX_ATTRIBUTE = "data-lectern-index";

/** `Node.nodeType` of an element: the node type this module numbers and descends into. */
const ELEMENT_NODE = 1;

/** `Node.nodeType` of a document: what a clone of a document is. */
const DOCUMENT_NODE = 9;

/** One element of the copy, with its pre-order index and the size of its subtree. */
interface NumberedElement {
  index: number;
  /** The subtree size, in elements, including the element itself. Filled in once its children are known. */
  size: number;
}

/**
 * The article root of a live document (F§10.2): the live element the article Readability found in a copy of
 * the document sits at, or `main`, `body`, or the document element when there is no article structure.
 *
 * A document Readability cannot read at all — it throws rather than answering `null` for some inputs —
 * falls back the same way, because a page with an unreadable article still has a body to read.
 */
export function findArticleRoot(doc: Document): Element {
  try {
    const clone = cloneDocument(doc);
    if (clone !== null) {
      const numbered = numberSubtree(clone.documentElement);
      const content = articleContent(clone);
      const element = content === null ? undefined : liveRootOf(numbered, preOrderElements(doc.documentElement), content);
      if (element !== undefined) return element;
    }
  } catch {
    // Readability refused this document; the fallback chain below is the whole answer to that.
  }
  return fallbackRoot(doc);
}

/** A deep copy of a document, or `null` for anything a clone of a document cannot be read as. */
function cloneDocument(doc: Document): Document | null {
  const clone: Node = doc.cloneNode(true);
  return clone.nodeType === DOCUMENT_NODE ? (clone as Document) : null;
}

/** Number one element's subtree in pre-order, returning the copy's index table. */
function numberSubtree(root: Element): NumberedElement[] {
  const numbered: NumberedElement[] = [];
  numberElement(root, numbered);
  return numbered;
}

/**
 * Number one element and, depth first, its children. The element's index is its position in the list, so
 * numbering and carrying the index as an attribute are the same walk; the subtree size is filled in once
 * the children have been numbered, which is what makes an interval of indexes describe a subtree.
 */
function numberElement(element: Element, numbered: NumberedElement[]): number {
  const entry: NumberedElement = { index: numbered.length, size: 1 };
  numbered.push(entry);
  element.setAttribute(CLONE_INDEX_ATTRIBUTE, String(entry.index));
  let size = 1;
  for (const child of element.children) size += numberElement(child, numbered);
  entry.size = size;
  return size;
}

/** One tree's elements in pre-order: the same list the numbering walk produces, for an unnumbered tree. */
function preOrderElements(root: Element): Element[] {
  const elements: Element[] = [];
  collectElements(root, elements);
  return elements;
}

/** Append one element and, depth first, its children to a pre-order list. */
function collectElements(element: Element, elements: Element[]): void {
  elements.push(element);
  for (const child of element.children) collectElements(child, elements);
}

/**
 * The element Readability extracted the article into, in the copy. Its `serializer` option is what makes
 * this an element instead of a string: Readability hands the node it built to that function and returns
 * what it returned, so an identity serializer returns the article as a node of the copy.
 */
function articleContent(clone: Document): Element | null {
  const article = new Readability<Element>(clone, { serializer: asElement }).parse();
  return article?.content ?? null;
}

/** Readability's identity serializer: the node it offers, as the element it is. */
function asElement(node: Node): Element {
  return node as Element;
}

/** The live element the article's surviving indexes stand for, or `undefined` when none survived. */
function liveRootOf(numbered: NumberedElement[], live: Element[], content: Element): Element | undefined {
  const indexes: number[] = [];
  collectIndexes(content, indexes);
  const common = lowestCommonAncestor(numbered, indexes);
  return common === null ? undefined : live[common.index];
}

/** Collect the index of every numbered element in one subtree, in document order. */
function collectIndexes(node: Node, indexes: number[]): void {
  if (node.nodeType === ELEMENT_NODE) {
    const raw = (node as Element).getAttribute(CLONE_INDEX_ATTRIBUTE);
    if (raw !== null) {
      const index = Number.parseInt(raw, 10);
      if (Number.isInteger(index)) indexes.push(index);
    }
  }
  for (const child of node.childNodes) collectIndexes(child, indexes);
}

/**
 * The lowest common ancestor of a set of pre-order indexes: the narrowest subtree interval that covers them
 * all. Every ancestor of an index covers it, so the ancestors in play are exactly the intervals containing
 * the smallest and the largest index, and the narrowest of those is the answer.
 */
function lowestCommonAncestor(numbered: NumberedElement[], indexes: number[]): NumberedElement | null {
  const first = indexes[0];
  if (first === undefined) return null;
  let lowest = first;
  let highest = first;
  for (const index of indexes) {
    if (index < lowest) lowest = index;
    if (index > highest) highest = index;
  }
  let best: NumberedElement | null = null;
  for (const entry of numbered) {
    // Indexes ascend in pre-order, so once an element starts after the first index it cannot cover it.
    if (entry.index > lowest) break;
    if (entry.index + entry.size - 1 < highest) continue;
    if (best === null || entry.size < best.size) best = entry;
  }
  return best;
}

/** Where reading starts when there is no article: `main`, `body`, or the document element. */
function fallbackRoot(doc: Document): Element {
  return doc.querySelector("main") ?? doc.querySelector("body") ?? doc.documentElement;
}
