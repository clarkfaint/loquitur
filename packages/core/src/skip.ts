/**
 * Skip classification (F§5.4): which blocks are page furniture rather than reading matter, and which
 * bracketed runs are citations to leave out of synthesis.
 *
 * Classification never deletes a block and never rewrites its text. It returns a new list in which the
 * furniture's `kind` is `header`, `footer` or `footnote`; `buildDocument` turns that kind into
 * `Block.skip`, and the player — not this module — decides whether skipped blocks are heard.
 */

import type { RawBlock } from "./builder";

/** A footnote marker opens the block with up to three digits and an optional `.` or `)`, then space. */
const FOOTNOTE_MARKER = /^\d{1,3}[.)]?\s/u;

/** A block in type smaller than this fraction of the page median is footnote-sized (F§5.4). */
const SMALL_FONT_RATIO = 0.85;

/** The top and bottom bands, as `yRatio` bounds measured from the top of the page (`0` to `1`). */
const TOP_BAND = 0.08;
const BOTTOM_BAND = 0.92;

/** F§5.4's furniture rule needs at least this many distinct pages before it may fire at all. */
const MINIMUM_FURNITURE_PAGES = 3;

/** F§5.4's repetition threshold, as a fraction of the document's pages. */
const FURNITURE_SHARE_NUMERATOR = 6;
const FURNITURE_SHARE_DENOMINATOR = 10;

/** A bracketed numeric citation: `[12]`, `[3, 4]`, `[1; 2]`, `[7-9]`, `[11–13]`. */
const CITATION = /\[\s*\d+(?:\s*(?:[,;]|[-\u2013\u2014])\s*\d+)*\s*\]/gu;

/** The run of spaces or tabs a removed citation can leave behind. */
const SPACE_RUN = /[ \t]{2,}/gu;

/** Which band of the page a block sits in, or `null` for the body and for blocks without geometry. */
function bandOf(yRatio: number | undefined): "header" | "footer" | null {
  if (yRatio === undefined) return null;
  if (yRatio <= TOP_BAND) return "header";
  if (yRatio >= BOTTOM_BAND) return "footer";
  return null;
}

/**
 * The comparison key of a furniture line: every digit replaced by `#`, whitespace collapsed and the
 * ends trimmed (F§5.4). It is what makes `Page 1` through `Page 12` one line, while leaving word-only
 * differences — `Chapter One` against `Chapter Two` — distinct.
 */
function furnitureKey(text: string): string {
  return text.replace(/\d/g, "#").replace(/\s+/g, " ").trim();
}

/** Whether a block opens with a footnote marker in footnote-sized type (F§5.4). */
function isFootnote(block: RawBlock): boolean {
  return FOOTNOTE_MARKER.test(block.text) && block.fontRatio !== undefined && block.fontRatio < SMALL_FONT_RATIO;
}

/** How many distinct pages the document spans; blocks without a page do not count. */
function countPages(blocks: RawBlock[]): number {
  const pages = new Set<number>();
  for (const block of blocks) {
    if (block.page !== undefined) pages.add(block.page);
  }
  return pages.size;
}

/**
 * For every `band + key` pair, the set of distinct pages on which that line occurs in that band. A set
 * rather than a count, so a page showing the same line twice still counts once.
 */
function tallyBands(blocks: RawBlock[]): Map<string, Set<number>> {
  const tally = new Map<string, Set<number>>();
  for (const block of blocks) {
    if (block.kind === "footnote" || block.page === undefined) continue;
    const band = bandOf(block.yRatio);
    if (band === null) continue;
    const key = `${band}\u0000${furnitureKey(block.text)}`;
    const pages = tally.get(key);
    if (pages === undefined) {
      tally.set(key, new Set<number>([block.page]));
    } else {
      pages.add(block.page);
    }
  }
  return tally;
}

/** Whether a line found on `pages` of `pageCount` pages clears F§5.4's 60% repetition bar. */
function isRepeated(pages: Set<number>, pageCount: number): boolean {
  return pages.size * FURNITURE_SHARE_DENOMINATOR >= pageCount * FURNITURE_SHARE_NUMERATOR;
}

/**
 * Classify the furniture of a document (F§5.4). Footnote markers are recognised per block; headers and
 * footers need a paged document of at least three pages, a block inside the top or bottom band, and a
 * line whose digit-normalized text repeats across at least 60% of the document's pages in that same
 * band. The input list is not modified.
 */
export function classifySkip(rawBlocks: RawBlock[]): RawBlock[] {
  const classified = rawBlocks.map((block) => (isFootnote(block) ? { ...block, kind: "footnote" as const } : { ...block }));
  const pageCount = countPages(classified);
  if (pageCount < MINIMUM_FURNITURE_PAGES) return classified;

  const tally = tallyBands(classified);
  return classified.map((block) => {
    if (block.kind === "footnote" || block.page === undefined) return block;
    const band = bandOf(block.yRatio);
    if (band === null) return block;
    const pages = tally.get(`${band}\u0000${furnitureKey(block.text)}`);
    if (pages === undefined || !isRepeated(pages, pageCount)) return block;
    return { ...block, kind: band };
  });
}

/**
 * The text F§5.4 sends to synthesis with `skipCitations` on: bracketed numeric citations removed, the
 * spaces they leave behind collapsed to one, and the ends trimmed. This returns a new string; the
 * document's own text is never changed.
 */
export function stripCitations(text: string): string {
  return text.replace(CITATION, "").replace(SPACE_RUN, " ").trim();
}
