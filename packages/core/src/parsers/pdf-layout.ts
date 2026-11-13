/**
 * PDF text layout (F§5.4, PDF row): the pure half of the PDF parser.
 *
 * pdfjs reports a page as a flat list of text items, each with the string it drew, its baseline, its
 * left edge and its type size in device space. Turning that list into reading order is three
 * geometric rules and one spelling rule, and all four live here as functions over plain data: this
 * module imports nothing, so the rules can be read and tested without a PDF in hand. `pdf.ts` owns
 * the other half — pdfjs itself, the page walk, and the `RawBlock`s and word anchors these pieces
 * become.
 *
 * The geometric rules. Items are grouped into *lines* by baseline; a line whose type is 1.25x the
 * page median or larger is a *heading*; and lines are grouped into *paragraphs* unless the vertical
 * gap between them is more than 1.5x the median line height. The one rule that reads the spelling
 * rather than the geometry is de-hyphenation: a line ending in `-` whose next line starts with a
 * lowercase letter is a single word broken across the two lines, and the break is removed.
 *
 * Joins report provenance. Every function that assembles text also returns, for each character, the
 * item it was read from and the offset inside that item's own string, because a `PdfAnchor` has to
 * point back at the words a page actually drew. A character a join inserted itself — the space
 * between two items of a line, or between two lines of a paragraph — is recorded as `null`: it has no
 * page behind it.
 */

/** How much two baselines may differ and still be one line: a fifth of the type size, at least a point. */
const LINE_TOLERANCE_RATIO = 0.2;
const MINIMUM_LINE_TOLERANCE = 1;

/** Two items on one line are separate words when the space between them is wider than this share of the type size. */
const ITEM_GAP_RATIO = 0.25;

/** F§5.4: a vertical gap above this multiple of the median line height starts a new paragraph. */
const PARAGRAPH_GAP_RATIO = 1.5;

/** F§5.4: a line at this multiple of the page median or larger is a heading. */
const HEADING_SIZE_RATIO = 1.25;

/** The character F§5.4 de-hyphenates on, and the letter the continuation must start with. */
const BREAK_HYPHEN = "-";
const LOWERCASE_START = /^[a-z]/u;

const WHITESPACE = /^\s$/u;

/** One text item as this module reads it: the string pdfjs reports, and its geometry in device space. */
export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  itemIndex: number;
}

/** Where one character of assembled text was read from: one item, and one offset inside its string. */
export interface CharSource {
  readonly itemIndex: number;
  readonly offset: number;
}

/** Assembled text, with one provenance entry per character (`null` where the assembly inserted it). */
export interface AssembledText {
  readonly text: string;
  readonly sources: readonly (CharSource | null)[];
}

/** One line of a page: its items left to right, its baseline, and its text with provenance. */
export interface PdfLine extends AssembledText {
  readonly x: number;
  readonly y: number;
  readonly fontSize: number;
  readonly items: readonly PdfTextItem[];
}

/** One paragraph of a page: its lines top to bottom, and its text with provenance. */
export interface PdfParagraph extends AssembledText {
  readonly y: number;
  readonly fontSize: number;
  readonly lines: readonly PdfLine[];
}

/** A text assembly under construction. Private: every exported value is frozen. */
interface Builder {
  text: string[];
  sources: (CharSource | null)[];
}

/** The middle value of a list of numbers, `0` when there is none. */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const lower = sorted[middle - 1] ?? 0;
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? upper : (lower + upper) / 2;
}

/** Whether a character is whitespace; a missing character is not. */
function isWhitespace(character: string | undefined): boolean {
  return character !== undefined && WHITESPACE.test(character);
}

/** The type size F§5.4 calls the page median: the median of every item's size on that page. */
export function medianFontSize(items: readonly PdfTextItem[]): number {
  return median(items.map((item) => item.fontSize));
}

/** How far apart two baselines may be and still count as the same line, for this type size. */
function lineTolerance(fontSize: number): number {
  return Math.max(MINIMUM_LINE_TOLERANCE, fontSize * LINE_TOLERANCE_RATIO);
}

/** Whether the horizontal space after `previous` is wide enough to be a word break of its own. */
function separatedByGap(previous: PdfTextItem, next: PdfTextItem): boolean {
  const gap = next.x - (previous.x + previous.width);
  if (gap <= previous.fontSize * ITEM_GAP_RATIO) return false;
  return !previous.str.endsWith(" ") && !next.str.startsWith(" ");
}

/** One provenance entry per character of an item's own string. */
function itemSources(item: PdfTextItem): CharSource[] {
  const sources: CharSource[] = [];
  for (let offset = 0; offset < item.str.length; offset += 1) {
    sources.push({ itemIndex: item.itemIndex, offset });
  }
  return sources;
}

/** Append a run of characters, and the provenance of each one. */
function pushRun(builder: Builder, text: string, sources: readonly (CharSource | null)[]): void {
  for (let index = 0; index < text.length; index += 1) {
    builder.text.push(text.charAt(index));
    builder.sources.push(sources[index] ?? null);
  }
}

/** Append a space the assembly inserted: a real character, with no page behind it. */
function pushSpace(builder: Builder): void {
  builder.text.push(" ");
  builder.sources.push(null);
}

/**
 * F§5.4's de-hyphenation, applied to the text assembled so far. When the text ends in `-` and `next`
 * starts with a lowercase letter the two are one word, so the break hyphen is dropped and the two
 * parts are joined with nothing between them; this reports whether it did that. Otherwise the caller
 * joins with a space.
 */
function breakHyphen(builder: Builder, next: string): boolean {
  const last = builder.text[builder.text.length - 1];
  if (last !== BREAK_HYPHEN || !LOWERCASE_START.test(next)) return false;
  builder.text.pop();
  builder.sources.pop();
  return true;
}

/** Everything the builder holds, with whitespace trimmed from both ends. */
function frozen(builder: Builder): AssembledText {
  let start = 0;
  let end = builder.text.length;
  while (start < end && isWhitespace(builder.text[start])) start += 1;
  while (end > start && isWhitespace(builder.text[end - 1])) end -= 1;
  return { text: builder.text.slice(start, end).join(""), sources: builder.sources.slice(start, end) };
}

/**
 * The text of one line, in F§5.4's de-hyphenated form: each line after the first is joined with a
 * space, or with nothing at all when `-` at the end of the previous one and a lowercase start make
 * the two halves of a single word.
 */
export function dehyphenate(lines: readonly string[]): string {
  const builder: Builder = { text: [], sources: [] };
  for (const line of lines) {
    if (builder.text.length > 0 && !breakHyphen(builder, line)) pushSpace(builder);
    pushRun(builder, line, []);
  }
  return frozen(builder).text;
}

/** One line: its items joined left to right, with a space between two items the geometry separates. */
function buildLine(items: readonly PdfTextItem[]): AssembledText {
  const builder: Builder = { text: [], sources: [] };
  items.forEach((item, index) => {
    const previous = items[index - 1];
    if (previous !== undefined && separatedByGap(previous, item)) pushSpace(builder);
    pushRun(builder, item.str, itemSources(item));
  });
  return frozen(builder);
}

/** One item list as a line: its assembled text, its geometry, and the items it came from. */
function toLine(items: readonly PdfTextItem[]): PdfLine {
  const assembled = buildLine(items);
  const first = items[0];
  return {
    text: assembled.text,
    sources: assembled.sources,
    x: first?.x ?? 0,
    y: first?.y ?? 0,
    fontSize: median(items.map((item) => item.fontSize)),
    items,
  };
}

/** The line one paragraph's text is assembled from, with each line's own provenance. */
function buildParagraph(lines: readonly PdfLine[]): AssembledText {
  const builder: Builder = { text: [], sources: [] };
  for (const line of lines) {
    if (builder.text.length > 0 && !breakHyphen(builder, line.text)) pushSpace(builder);
    pushRun(builder, line.text, line.sources);
  }
  return frozen(builder);
}

/** One line list as a paragraph: its assembled text, its top baseline, its type size, its lines. */
function toParagraph(lines: readonly PdfLine[]): PdfParagraph {
  const assembled = buildParagraph(lines);
  const first = lines[0];
  return {
    text: assembled.text,
    sources: assembled.sources,
    y: first?.y ?? 0,
    fontSize: median(lines.map((line) => line.fontSize)),
    lines,
  };
}

/**
 * F§5.4's first rule: group a page's items into lines by baseline. Items are ordered top to bottom
 * and, within a line, left to right; an item joins the line being built while its baseline is within
 * a fifth of the type size of that line's baseline. Single-column text only — this is one line list
 * per page, not a column detector.
 */
export function groupLines(items: readonly PdfTextItem[]): PdfLine[] {
  const ordered = [...items].sort((left, right) => right.y - left.y || left.x - right.x);
  const lines: PdfLine[] = [];
  let current: PdfTextItem[] = [];

  for (const item of ordered) {
    const first = current[0];
    if (first !== undefined && Math.abs(item.y - first.y) > lineTolerance(Math.max(first.fontSize, item.fontSize))) {
      lines.push(toLine(current));
      current = [];
    }
    current.push(item);
  }
  if (current.length > 0) lines.push(toLine(current));
  return lines;
}

/**
 * F§5.4's third rule: group lines into paragraphs. The comparison is the whitespace between two
 * baselines — their distance minus the line height — against 1.5x the median line height, so
 * ordinary leading never splits a paragraph and the extra half-line a writer leaves between
 * paragraphs does. The median line height is the median type size of the lines being grouped.
 */
export function groupParagraphs(lines: readonly PdfLine[]): PdfParagraph[] {
  const lineHeight = median(lines.map((line) => line.fontSize));
  const groups: PdfLine[][] = [];
  let current: PdfLine[] = [];

  for (const line of lines) {
    const previous = current[current.length - 1];
    const baselineGap = previous === undefined ? 0 : previous.y - line.y;
    if (previous !== undefined && baselineGap - lineHeight > PARAGRAPH_GAP_RATIO * lineHeight) {
      groups.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) groups.push(current);
  return groups.map(toParagraph);
}

/**
 * F§5.4's second rule: the lines whose type is at least 1.25x the page median. A page with no items,
 * or none whose size can be measured, has no headings rather than all of them.
 */
export function detectHeadings(lines: readonly PdfLine[], pageMedian: number): PdfLine[] {
  if (pageMedian <= 0) return [];
  return lines.filter((line) => line.fontSize >= pageMedian * HEADING_SIZE_RATIO);
}
