/**
 * The page's text map (F§10.2): readable blocks, and the mapping from an offset in a block's normalized
 * text back to a `Range` on the page.
 *
 * Two facts shape this module.
 *
 * First, block text is *normalized* (F§5.2): runs of spaces collapse, soft hyphens vanish, lines are
 * trimmed. A block's characters therefore do not line up with the characters of the page, and a highlight
 * that used raw offsets would drift by one or more characters per collapsed run. So the map is built in a
 * single pass that keeps, for every character of the normalized text, the text node and the raw offset it
 * came from. A range is then the point of its first character to the point *after* its last one, which is
 * exact across inline element boundaries, collapsed whitespace and line breaks alike.
 *
 * Second, a block's boundaries come from block-level ancestors (F§10.2), not from the text. `h1`–`h6`,
 * `p`, `li`, `blockquote` and `figcaption` each become one block and the walk does not descend past them,
 * so a `<blockquote>` holding a paragraph is one quote rather than a quote and a paragraph; other block
 * containers flush the text around them into paragraphs, which is how a page with no article structure is
 * still read; inline elements join the block they sit in; and a `<br>` is a line break *inside* the block
 * it sits in. Text nodes, never `innerText`: the latter needs layout, which an extension context and a
 * test document do not have.
 *
 * Block indexes here are the indexes of the `DocumentModel` built from the map (F§5.1), which is why a
 * block whose normalized text is empty is dropped here exactly as core's builder drops it: the two lists
 * must not drift apart, because every range is asked for by a model offset.
 */

import type { BlockKind, HeadingLevel } from "@lectern/core";
import { isReadableElement, type ReadableEnv, tagName } from "./visibility";

/** One block of readable text, as the page holds it. */
export interface TextBlock {
  /** The element the block's boundaries come from. */
  element: Element;
  /** The block kind, from the element's tag (F§5.1). */
  kind: BlockKind;
  /** A heading's level, and nothing else. */
  level?: HeadingLevel;
  /** The block's text, normalized by F§5.2. */
  text: string;
}

/** One text node's contribution to one block, as offsets into that block's normalized text. */
export interface TextEntry {
  /** The text node the characters came from. */
  node: Text;
  /** The block the node contributes to. */
  blockIndex: number;
  /** The first offset of the block's text the node accounts for. */
  start: number;
  /** One past the last such offset. */
  end: number;
}

/** A page's readable blocks and the mapping its ranges are resolved through. */
export interface TextMap {
  blocks: TextBlock[];
  entries: TextEntry[];
  /**
   * The `Range` covering `[charStart, charEnd)` of a block's normalized text, or `null` when the block or
   * the offsets are outside the map. The range is created in the document the mapped text nodes belong to.
   */
  rangeFor(blockIndex: number, charStart: number, charEnd: number): Range | null;
}

/** `Node.nodeType` of an element. */
const ELEMENT_NODE = 1;

/** `Node.nodeType` of a text node. */
const TEXT_NODE = 3;

/** A line break no element carries text for, as the block text spells it. */
const LINE_BREAK = "\n";

/**
 * A combining mark: a character that composes with the one before it. Unicode normalization composes such
 * a pair into one character, so the marks are gathered with their base character before the text is
 * normalized — which is what keeps one normalized character pointing at one page offset.
 */
const COMBINING_MARK = /\p{M}/u;

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
 * Block-level containers: elements that hold blocks rather than join one. Their own text — text that is
 * not inside a heading, paragraph, list item, quote or caption — is prose too, so it becomes a paragraph.
 * The set is core's own list of containers, repeated here because `@lectern/core/parsers` is Node-only and
 * a content script may not import it.
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

/** Inline tags that break a line without carrying text of their own. */
const BREAK_TAGS: ReadonlySet<string> = new Set<string>(["br", "wbr"]);

/** One character on its way into a block's text, and the page character it came from. */
interface Cell {
  ch: string;
  /** The text node it came from, or `null` for a line break the page signalled with an element. */
  node: Text | null;
  /** Its offset in that node's own data, or `0` for a line break. */
  offset: number;
}

/** A point on the page: a position between two characters of one text node. */
interface Point {
  node: Text;
  offset: number;
}

/** One text node's window of a block's normalized text. */
interface BlockEntry {
  node: Text;
  start: number;
  end: number;
}

/** A block's normalized text, and everything a range needs to be resolved from it. */
interface Aligned {
  text: string;
  points: Point[];
  entries: BlockEntry[];
}

/** The element one block belongs to, and the kind and level it takes from that element. */
interface BlockHost {
  element: Element;
  kind: BlockKind;
  level?: HeadingLevel;
}

/** Text on its way to becoming one block: where it came from and the element it is read under. */
interface Group {
  host: BlockHost;
  cells: Cell[];
}

/** One block of the map, before its groups are turned into the public shape. */
interface MappedBlock {
  element: Element;
  kind: BlockKind;
  level?: HeadingLevel;
  text: string;
  points: Point[];
  entries: BlockEntry[];
}

/**
 * Build the text map of one element subtree (F§10.2). `root` is the article root `findArticleRoot` picked
 * or any element to read; `env` states what the caller can measure about the document.
 */
export function buildTextMap(root: Element, env: ReadableEnv): TextMap {
  const groups: Group[] = [];
  visitElement(root, root, env, groups);
  return createTextMap(mappedBlocks(groups));
}

/**
 * Build the text map of one or more selection ranges (F§10.2): the same blocks, restricted to the
 * characters the ranges cover. A range that spans several blocks yields them all, in document order.
 */
export function buildSelectionTextMap(ranges: readonly Range[], env: ReadableEnv): TextMap {
  const groups: Group[] = [];
  for (const range of ranges) addRangeGroups(groups, range, env);
  return createTextMap(mappedBlocks(groups));
}

/** Walk one element's children in document order, collecting the text each block holds. */
function visitElement(element: Element, root: Element, env: ReadableEnv, groups: Group[]): void {
  for (const node of element.childNodes) {
    if (node.nodeType === TEXT_NODE) {
      const text = node as Text;
      if (text.data === "") continue;
      pushCells(groups, hostOf(element, root), cellsOfText(text, 0, text.data.length));
      continue;
    }
    if (node.nodeType !== ELEMENT_NODE) continue;
    const child = node as Element;
    if (!isReadableElement(child, env)) continue;
    if (BREAK_TAGS.has(tagName(child))) {
      pushCells(groups, hostOf(element, root), [{ ch: LINE_BREAK, node: null, offset: 0 }]);
      continue;
    }
    visitElement(child, root, env, groups);
  }
}

/** Collect the part of one range's text that lies inside the given element's subtree. */
function visitRange(element: Element, root: Element, range: Range, env: ReadableEnv, groups: Group[]): void {
  if (!isReadableElement(element, env)) return;
  for (const node of element.childNodes) {
    if (node.nodeType === TEXT_NODE) {
      const text = node as Text;
      const clip = clipToRange(text, range);
      if (clip === null) continue;
      pushCells(groups, hostOf(element, root), cellsOfText(text, clip.from, clip.to));
      continue;
    }
    if (node.nodeType !== ELEMENT_NODE) continue;
    const child = node as Element;
    if (BREAK_TAGS.has(tagName(child))) continue;
    visitRange(child, root, range, env, groups);
  }
}

/** Add one range's blocks: its own subtree root, walked for the text the range covers. */
function addRangeGroups(groups: Group[], range: Range, env: ReadableEnv): void {
  if (range.collapsed) return;
  const root = elementRootOf(range.commonAncestorContainer);
  if (root === null) return;
  visitRange(root, root, range, env, groups);
}

/** The element a node sits in: the node itself when it is an element, else its parent element. */
function elementRootOf(node: Node): Element | null {
  return node.nodeType === ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/**
 * The window of a text node that lies inside a range, or `null` when the node is not covered. A node the
 * range only partly covers is clipped at the range's own boundaries; a node entirely before or after it is
 * dropped, which `comparePoint` answers for both cases.
 */
function clipToRange(node: Text, range: Range): { from: number; to: number } | null {
  const length = node.data.length;
  if (length === 0) return null;
  const from = range.startContainer === node ? range.startOffset : 0;
  const to = range.endContainer === node ? range.endOffset : length;
  if (to <= from) return null;
  if (range.startContainer !== node && range.comparePoint(node, length) < 0) return null;
  if (range.endContainer !== node && range.comparePoint(node, 0) > 0) return null;
  return { from, to };
}

/**
 * The block host of a text node's parent (F§10.2): the *outermost* element below the root that is one of
 * F§5.4's blocks, else the highest block container below the root, else the root itself. Taking the
 * outermost mapped ancestor is what keeps a `<blockquote>` holding a paragraph a single quote, and the
 * container fallback is what turns a container's loose text into a paragraph.
 */
function hostOf(start: Element, root: Element): BlockHost {
  let mapped: Element | null = null;
  let container: Element | null = null;
  let current: Element | null = start;
  while (current !== null && current !== root) {
    const tag = tagName(current);
    if (blockKindOf(tag) !== null) mapped = current;
    if (BLOCK_CONTAINERS.has(tag)) container = current;
    current = current.parentElement;
  }
  return hostFor(mapped ?? container ?? root);
}

/** The block kind a tag maps to, or `null` when the tag is not one of F§5.4's blocks. */
function blockKindOf(tag: string): BlockKind | null {
  if (HEADING_LEVELS.has(tag)) return "heading";
  return BLOCK_TAGS.get(tag) ?? null;
}

/** The host one element makes: its heading level, its block kind, or a paragraph. */
function hostFor(element: Element): BlockHost {
  const level = HEADING_LEVELS.get(tagName(element));
  if (level !== undefined) return { element, kind: "heading", level };
  return { element, kind: BLOCK_TAGS.get(tagName(element)) ?? "paragraph" };
}

/**
 * Add cells to the block being built, or start one. Cells join the previous group when they belong to the
 * same element, which is what makes one run of text one block; a container's text on either side of a
 * paragraph is therefore two blocks, as it is when a parser maps the document.
 */
function pushCells(groups: Group[], host: BlockHost, cells: readonly Cell[]): void {
  if (cells.length === 0) return;
  const last = groups[groups.length - 1];
  if (last !== undefined && last.host.element === host.element) {
    for (const cell of cells) last.cells.push(cell);
    return;
  }
  groups.push({ host, cells: [...cells] });
}

/**
 * One text node's characters, each pointing back at the offset it came from. Unicode normalization runs on
 * a base character together with the combining marks that follow it, so one normalized character still
 * names one offset; the alternative — normalizing the concatenation — could merge a base character of one
 * node with a mark of the next and leave the pair pointing at two offsets.
 */
function cellsOfText(node: Text, from: number, to: number): Cell[] {
  const data = node.data.slice(from, to);
  const cells: Cell[] = [];
  let index = 0;
  while (index < data.length) {
    let end = index + 1;
    while (end < data.length && COMBINING_MARK.test(data.charAt(end))) end += 1;
    for (const ch of data.slice(index, end).normalize("NFC")) cells.push({ ch, node, offset: from + index });
    index = end;
  }
  return cells;
}

/** Turn groups into blocks, dropping the ones whose text normalizes to nothing. */
function mappedBlocks(groups: readonly Group[]): MappedBlock[] {
  const blocks: MappedBlock[] = [];
  for (const group of groups) {
    const aligned = align(group.cells);
    if (aligned === null) continue;
    blocks.push({ ...group.host, text: aligned.text, points: aligned.points, entries: aligned.entries });
  }
  return blocks;
}

/** Normalize one group's characters (F§5.2), keeping every character's page point. */
function align(cells: readonly Cell[]): Aligned | null {
  const final = trimEdges(collapseNewlines(trimLineEnds(collapseRuns(cells))));
  if (final.length === 0) return null;
  const points = pointsOf(final);
  if (points === null) return null;
  return { text: final.map((cell) => cell.ch).join(""), points, entries: entriesOf(points) };
}

/**
 * The first normalization steps, in F§5.2's order: line endings are unified, a non-breaking space becomes
 * an ordinary one, soft hyphens are dropped, and a run of spaces and tabs becomes one space carrying the
 * first character of the run.
 */
function collapseRuns(cells: readonly Cell[]): Cell[] {
  const out: Cell[] = [];
  let skipLineFeed = false;
  for (const cell of cells) {
    const ch = cell.ch;
    if (skipLineFeed) {
      skipLineFeed = false;
      if (ch === "\n") continue;
    }
    if (ch === "\r") {
      out.push({ ...cell, ch: "\n" });
      skipLineFeed = true;
      continue;
    }
    if (ch === "\u00A0") {
      out.push({ ...cell, ch: " " });
      continue;
    }
    if (ch === "\u00AD") continue;
    if (ch === " " || ch === "\t") {
      pushSpace(out, cell);
      continue;
    }
    out.push(cell);
  }
  return out;
}

/** Append one space, unless the previous character is already the space it would collapse into. */
function pushSpace(out: Cell[], cell: Cell): void {
  const last = out[out.length - 1];
  if (last !== undefined && last.ch === " ") return;
  out.push({ ...cell, ch: " " });
}

/** Drop whitespace that only sits at one end of a line (F§5.2's per-line trim). */
function trimLineEnds(cells: readonly Cell[]): Cell[] {
  const out: Cell[] = [];
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    if (cell === undefined) continue;
    if (isWhitespace(cell)) {
      const previous = out[out.length - 1];
      const next = cells[index + 1];
      if (previous === undefined || previous.ch === "\n") continue;
      if (next === undefined || next.ch === "\n") continue;
    }
    out.push(cell);
  }
  return out;
}

/** Keep at most two consecutive line breaks (F§5.2's paragraph break). */
function collapseNewlines(cells: readonly Cell[]): Cell[] {
  const out: Cell[] = [];
  let run = 0;
  for (const cell of cells) {
    if (cell.ch === "\n") {
      run += 1;
      if (run > 2) continue;
    } else {
      run = 0;
    }
    out.push(cell);
  }
  return out;
}

/** Drop whitespace at the very start and the very end of a block (F§5.2's final trim). */
function trimEdges(cells: readonly Cell[]): Cell[] {
  let start = 0;
  let end = cells.length;
  while (start < end) {
    const cell = cells[start];
    if (cell === undefined || !isWhitespace(cell)) break;
    start += 1;
  }
  while (end > start) {
    const cell = cells[end - 1];
    if (cell === undefined || !isWhitespace(cell)) break;
    end -= 1;
  }
  return cells.slice(start, end);
}

/** Whether a character is whitespace as `String.prototype.trim` counts it. */
function isWhitespace(cell: Cell): boolean {
  return cell.ch.trim() === "";
}

/**
 * The page point of every character of a block's text. A line break carries no text node of its own, so it
 * takes the point of the character after it — the text it separates begins there — or, at a block's end,
 * the point one past the last character, which is where the break itself sits.
 */
function pointsOf(cells: readonly Cell[]): Point[] | null {
  const points: (Point | null)[] = [];
  let pending: number[] = [];
  for (const cell of cells) {
    if (cell.node === null) {
      pending.push(points.length);
      points.push(null);
      continue;
    }
    const point: Point = { node: cell.node, offset: cell.offset };
    for (const index of pending) points[index] = point;
    pending = [];
    points.push(point);
  }
  const last = lastPoint(points);
  if (last === null) return null;
  for (const index of pending) points[index] = { node: last.node, offset: last.offset + 1 };
  const resolved: Point[] = [];
  for (const point of points) {
    if (point === null) return null;
    resolved.push(point);
  }
  return resolved;
}

/** The last resolved point of a partially filled list, or `null` while none is resolved. */
function lastPoint(points: readonly (Point | null)[]): Point | null {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index];
    if (point !== undefined && point !== null) return point;
  }
  return null;
}

/** One entry per text node that accounts for characters of a block, in block order. */
function entriesOf(points: readonly Point[]): BlockEntry[] {
  const entries: BlockEntry[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (point === undefined) continue;
    const last = entries[entries.length - 1];
    if (last !== undefined && last.node === point.node && last.end === index) {
      last.end = index + 1;
      continue;
    }
    entries.push({ node: point.node, start: index, end: index + 1 });
  }
  return entries;
}

/** The public map, with the block indexes and entries the `DocumentModel` will carry. */
function createTextMap(blocks: readonly MappedBlock[]): TextMap {
  const publicBlocks: TextBlock[] = [];
  const points: Point[][] = [];
  const entries: TextEntry[] = [];
  for (const block of blocks) {
    const blockIndex = publicBlocks.length;
    const common = { element: block.element, kind: block.kind, text: block.text };
    publicBlocks.push(block.level === undefined ? common : { ...common, level: block.level });
    points.push(block.points);
    for (const entry of block.entries) {
      entries.push({ node: entry.node, blockIndex, start: entry.start, end: entry.end });
    }
  }
  return {
    blocks: publicBlocks,
    entries,
    rangeFor: (blockIndex, charStart, charEnd) => rangeFor(points, blockIndex, charStart, charEnd),
  };
}

/**
 * Resolve a block offset pair to a range: the point of the first character to the point after the last
 * one. Nothing is guessed — an offset outside the block, a backwards or empty span, or a block the map
 * does not hold all answer `null`.
 */
function rangeFor(points: readonly Point[][], blockIndex: number, charStart: number, charEnd: number): Range | null {
  const block = points[blockIndex];
  if (block === undefined) return null;
  if (!Number.isInteger(charStart) || !Number.isInteger(charEnd)) return null;
  if (charStart < 0 || charEnd <= charStart || charEnd > block.length) return null;
  const first = block[charStart];
  const last = block[charEnd - 1];
  if (first === undefined || last === undefined) return null;
  const range = first.node.ownerDocument.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset + 1);
  return range;
}
