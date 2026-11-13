/**
 * The HTML mapping (F§5.4, HTML / URL row): turn one element subtree into the flat `RawBlock[]` a
 * parser hands to `buildDocument`.
 *
 * The walk is shallow on purpose. A tag F§5.4 names becomes exactly one block and the walk does not
 * descend into it, so a `<blockquote>` that holds a `<p>` contributes one quote, not a quote and a
 * paragraph. Every other element contributes *text*: a block-level container ends the block being
 * built and starts a new one, which is the block-level fallback F§5.4 asks for when a document has
 * no article structure (a `<div>` of loose prose becomes a paragraph), while an inline element's
 * words join the block around them, so a paragraph that wraps half its sentences in `<span>` or
 * `<em>` is still read once, whole. `script`, `style`, `template` and `noscript` are never read at
 * all: their content is code, not prose, and no block may carry it.
 *
 * The type is the DOM `Element` interface. linkedom's elements are a second implementation of that
 * interface, and this module reads only `localName`, `childNodes` and `textContent` — which linkedom
 * implements — so a caller that parsed with linkedom may hand its element over.
 */

import type { HeadingLevel, RawBlock } from "../builder";
import type { BlockKind } from "../model";

/** `Node.nodeType` of an element: the only node type whose children this walker looks at. */
const ELEMENT_NODE = 1;

/** `Node.nodeType` of a text node: the only node type whose data becomes block text. */
const TEXT_NODE = 3;

/**
 * Elements whose content is never prose: code, styling, markup or document metadata. F§5.4's tests
 * forbid a block from carrying `script` or `style` text, and a `head` carries a title, not a
 * sentence to read aloud.
 */
const IGNORED_TAGS: ReadonlySet<string> = new Set<string>(["head", "noscript", "script", "style", "template"]);

/** The heading levels F§5.4 names, keyed by tag. */
const HEADING_LEVELS: ReadonlyMap<string, HeadingLevel> = new Map<string, HeadingLevel>([
  ["h1", 1],
  ["h2", 2],
  ["h3", 3],
  ["h4", 4],
  ["h5", 5],
  ["h6", 6],
]);

/** The other tags F§5.4 names, with the block kind each one becomes. */
const BLOCK_TAGS: ReadonlyMap<string, BlockKind> = new Map<string, BlockKind>([
  ["p", "paragraph"],
  ["li", "list-item"],
  ["blockquote", "quote"],
  ["figcaption", "caption"],
]);

/**
 * Block-level containers: elements that hold blocks rather than join one. A container's own text
 * (text that is not inside a heading, paragraph, list item, quote or caption) is prose too, so it
 * becomes a paragraph — this is the fallback that keeps a document with no article structure
 * readable.
 */
const BLOCK_CONTAINERS: ReadonlySet<string> = new Set<string>([
  "address",
  "article",
  "aside",
  "body",
  "details",
  "div",
  "dl",
  "dd",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "header",
  "hgroup",
  "main",
  "nav",
  "ol",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

/** Inline tags that separate two words without carrying one themselves. */
const WORD_BREAK_TAGS: ReadonlySet<string> = new Set<string>(["br", "wbr"]);

/** The tag of an element, lower case, whatever the document's own casing was. */
function tagOf(element: Element): string {
  return element.localName.toLowerCase();
}

/** An element's text, never `null`: an element with no text has text `""`. */
function textOf(element: Element): string {
  return element.textContent ?? "";
}

/** The block kind a tag maps to, or `null` when the tag is not one of F§5.4's blocks. */
function blockKindOf(tag: string): BlockKind | null {
  if (HEADING_LEVELS.has(tag)) return "heading";
  return BLOCK_TAGS.get(tag) ?? null;
}

/** One block for a mapped element, carrying a heading's level and nothing else optional. */
function blockFor(element: Element, kind: BlockKind): RawBlock {
  const text = textOf(element);
  if (kind !== "heading") return { kind, text };
  const level = HEADING_LEVELS.get(tagOf(element));
  return level === undefined ? { kind, text } : { kind, level, text };
}

/**
 * Close the block being built: append it when it holds anything but whitespace, and start the next
 * one empty. Returns the buffer the caller continues with.
 */
function flush(pending: string, blocks: RawBlock[]): string {
  const text = pending.trim();
  if (text !== "") blocks.push({ kind: "paragraph", text });
  return "";
}

/** Walk one element's children in document order, appending every block the subtree contributes. */
function visit(parent: Element, blocks: RawBlock[]): void {
  const nodes = parent.childNodes;
  let pending = "";
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node === undefined) continue;
    if (node.nodeType === TEXT_NODE) {
      pending += node.textContent ?? "";
      continue;
    }
    if (node.nodeType !== ELEMENT_NODE) continue;
    const element = node as Element;
    const tag = tagOf(element);
    if (IGNORED_TAGS.has(tag)) continue;
    const kind = blockKindOf(tag);
    if (kind !== null) {
      pending = flush(pending, blocks);
      blocks.push(blockFor(element, kind));
      continue;
    }
    if (BLOCK_CONTAINERS.has(tag)) {
      pending = flush(pending, blocks);
      visit(element, blocks);
      continue;
    }
    if (WORD_BREAK_TAGS.has(tag)) {
      pending += " ";
      continue;
    }
    pending += textOf(element);
  }
  flush(pending, blocks);
}

/**
 * Map one element subtree to raw blocks (F§5.4). `root` is the article Readability extracted, or the
 * document body when there was no article to extract.
 */
export function mapElementToRawBlocks(root: Element): RawBlock[] {
  const blocks: RawBlock[] = [];
  visit(root, blocks);
  return blocks;
}
