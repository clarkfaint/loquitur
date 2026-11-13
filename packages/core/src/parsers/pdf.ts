/**
 * The PDF parser (F§5.4, PDF row): a PDF's text items become `RawBlock`s, and every word of every
 * block keeps a pointer back to the page it was drawn on.
 *
 * pdfjs is used for its text layer, and for F§5.5's fallback on a page whose text layer is empty: that
 * page is rasterized by `pdf-raster.ts`, which owns the canvas. The legacy build is imported from
 * `node_modules` rather than from a CDN, and its own Node path runs the worker in-process, so no
 * worker thread is started.
 *
 * The geometry is `pdf-layout.ts`'s job; this module supplies the items, walks the pages, and settles
 * the two things that are properties of the document rather than of a page: the title, and the rank
 * each heading type gets.
 *
 * Anchors are built from provenance, not from a second guess at the text. `parsePdf` assembles each
 * block's text together with, for every character, the item and offset it came from
 * (`pdf-layout.ts`), and tokenizes that same text with the tokenizer `buildDocument` will use, so a
 * word's range in the block text maps straight onto the characters of the item that drew it. A block
 * whose assembled text is not already in the normalized form F§5.2 would rewrite gets no anchors at
 * all: a pointer computed against text that is about to shift is worse than no pointer.
 */

import { getDocument, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";
import { z } from "zod";
import type { HeadingLevel, RawBlock } from "../builder";
import type { DocumentModel, PdfAnchor } from "../model";
import { normalizeText } from "../normalize";
import type { OcrEngine } from "../ocr";
import { groupOcrLines, OCR_LANG } from "../ocr";
import { tokenizeBlock } from "../tokenizer";
import type { CharSource, PdfLine, PdfParagraph, PdfTextItem } from "./pdf-layout";
import { detectHeadings, groupLines, groupParagraphs, medianFontSize } from "./pdf-layout";
import { rasterizePdfPage } from "./pdf-raster";

/** The MIME type F§5.1 records for a PDF in `source.mime`. */
export const PDF_MIME = "application/pdf";

/** How the page a word was read from is asked for its text. */
const DOCUMENT_OPTIONS = {
  useWorkerFetch: false,
  disableFontFace: true,
  verbosity: VerbosityLevel.ERRORS,
} as const;

/** The heading levels F§5.1 allows, largest type first. */
const HEADING_LEVELS: readonly HeadingLevel[] = [1, 2, 3, 4, 5, 6];

/** F§5.5's scanned-page threshold: a page whose text layer carries fewer characters than this is read by OCR. */
const OCR_MIN_CHARACTERS = 20;

/** F§5.5's rasterization resolution for a page that has no usable text layer. */
const OCR_RASTER_DPI = 200;

/**
 * The shape of a pdfjs text item as far as this parser reads it. A page's items are external input —
 * they come out of a file the user supplied — so their shape is checked before any of it is trusted,
 * and the markers pdfjs returns for marked content, which carry no string at all, fail this schema
 * and are dropped.
 */
const TextItemSchema = z.object({
  str: z.string(),
  transform: z.array(z.unknown()),
  width: z.number(),
  height: z.number(),
});

/** What `parsePdf` accepts besides the bytes. */
export interface ParsePdfOptions {
  /** The address the bytes came from, recorded by the caller as F§5.1's `source.uri`. */
  uri?: string;
  /** A title to prefer over the one the document itself carries. */
  title?: string;
  /**
   * The OCR engine F§5.5's scanned-page fallback reads a page with. Without one, a page whose text
   * layer carries fewer than 20 characters contributes no block at all — which is the whole of what
   * a text-extraction-only hub can do with a scan.
   */
  ocr?: OcrEngine;
}

/**
 * Where one word of one block sits in the page it was read from: the word's range in the block's own
 * text, and the item and character range inside that item which drew those characters.
 */
export interface WordLocation {
  /** The block's index in the document `buildDocument` builds from these raw blocks. */
  blockIndex: number;
  blockCharStart: number;
  blockCharEnd: number;
  /** The page, 1-based like F§5.1's `Block.page`. */
  page: number;
  /** The item's index among the page's text items, and the offsets inside the item's own string. */
  itemIndex: number;
  charStart: number;
  charEnd: number;
}

/** Everything a PDF parse hands over: the blocks, the title, the page count, and the word anchors. */
export interface ParsedPdf {
  rawBlocks: RawBlock[];
  title: string;
  pageCount: number;
  wordAnchors: readonly WordLocation[];
}

/** A block under construction: its raw form, the type size that decided its kind, and its anchors. */
interface ParsedBlock {
  rawBlock: RawBlock;
  fontSize: number;
  locations: BlockLocation[];
}

/** A word location before its block's final index is known. */
type BlockLocation = Omit<WordLocation, "blockIndex">;

/** Where a page's blocks are read from, for the ratios F§5.4's skip classification compares. */
interface PageGeometry {
  page: number;
  pageMedian: number;
  pageHeight: number;
}

/** A number the caller can use, or the fallback when pdfjs reported something else. */
function toNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** A non-empty string field of an otherwise unknown object, trimmed, or `undefined`. */
function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  if (typeof field !== "string") return undefined;
  const trimmed = field.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** A ratio clamped into `[0, 1]`. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * One pdfjs item as the layout wants it, or `null` when it carries nothing to place: an item that
 * fails the shape check, or one whose string is empty. pdf-lib-style writers emit empty items beside
 * the text they draw; they hold no word and no geometry worth grouping.
 */
function toTextItem(raw: unknown, itemIndex: number): PdfTextItem | null {
  const parsed = TextItemSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { str, transform, width, height } = parsed.data;
  if (str === "") return null;
  // The transform is `[a, b, c, d, e, f]`: the scale is its first two entries, the origin its last two.
  const scale = Math.hypot(toNumber(transform[0], 0), toNumber(transform[1], 0));
  return {
    str,
    x: toNumber(transform[4], 0),
    y: toNumber(transform[5], 0),
    width: toNumber(width, 0),
    height: toNumber(height, 0),
    fontSize: scale > 0 ? scale : toNumber(height, 0),
    itemIndex,
  };
}

/** Every item of one page the layout can use, each remembering its index among all of them. */
function toTextItems(rawItems: readonly unknown[]): PdfTextItem[] {
  const items: PdfTextItem[] = [];
  rawItems.forEach((raw, itemIndex) => {
    const item = toTextItem(raw, itemIndex);
    if (item !== null) items.push(item);
  });
  return items;
}

/**
 * The anchors of one block's words. A word is anchored to the item its first character came from,
 * covering only the characters of that word which lie in that item: a word broken across two items
 * (the de-hyphenated word F§5.4 joins, and a word spanning a line break) is anchored where it starts.
 * A block whose text is not already normalized has no anchors, because the offsets would then be
 * computed against text F§5.2 is about to rewrite.
 */
function locationsFor(text: string, sources: readonly (CharSource | null)[], page: number): BlockLocation[] {
  if (normalizeText(text) !== text) return [];
  const locations: BlockLocation[] = [];

  for (const sentence of tokenizeBlock(text, 0, 0)) {
    for (const word of sentence.words) {
      const start = sentence.charStart + word.charStart;
      const end = sentence.charStart + word.charEnd;
      const source = sources[start];
      if (source === undefined || source === null) continue;
      let run = 0;
      while (start + run < end) {
        const next = sources[start + run];
        if (next === undefined || next === null) break;
        if (next.itemIndex !== source.itemIndex || next.offset !== source.offset + run) break;
        run += 1;
      }
      if (run === 0) continue;
      locations.push({
        blockCharStart: start,
        blockCharEnd: end,
        page,
        itemIndex: source.itemIndex,
        charStart: source.offset,
        charEnd: source.offset + run,
      });
    }
  }
  return locations;
}

/** One paragraph as a block, with the ratios F§5.4's furniture rules read; `null` when it holds no text. */
function paragraphBlock(paragraph: PdfParagraph, geometry: PageGeometry, kind: RawBlock["kind"]): ParsedBlock | null {
  if (paragraph.text === "") return null;
  return {
    rawBlock: {
      kind,
      page: geometry.page,
      text: paragraph.text,
      fontRatio: geometry.pageMedian > 0 ? paragraph.fontSize / geometry.pageMedian : 1,
      yRatio: geometry.pageHeight > 0 ? clamp01((geometry.pageHeight - paragraph.y) / geometry.pageHeight) : 0,
    },
    fontSize: paragraph.fontSize,
    locations: locationsFor(paragraph.text, paragraph.sources, geometry.page),
  };
}

/** One paragraph of a run of lines, appended to the page's blocks when it holds text. */
function appendParagraph(blocks: ParsedBlock[], paragraph: PdfParagraph, geometry: PageGeometry, kind: RawBlock["kind"]): void {
  const block = paragraphBlock(paragraph, geometry, kind);
  if (block !== null) blocks.push(block);
}

/**
 * One page as blocks, in reading order. A headline is a block of its own — F§5.4 marks it by type
 * size, not by the gap around it — and the lines between two headlines are grouped into paragraphs.
 * Nothing is grouped across a page boundary: the page a block belongs to has one answer, and a break
 * between pages is a break between paragraphs in any case.
 */
function blocksOfPage(items: readonly PdfTextItem[], geometry: PageGeometry): ParsedBlock[] {
  const lines = groupLines(items);
  const headings = new Set<PdfLine>(detectHeadings(lines, geometry.pageMedian));
  const blocks: ParsedBlock[] = [];
  let run: PdfLine[] = [];

  const flushRun = (): void => {
    if (run.length === 0) return;
    for (const paragraph of groupParagraphs(run)) appendParagraph(blocks, paragraph, geometry, "paragraph");
    run = [];
  };

  for (const line of lines) {
    if (!headings.has(line)) {
      run.push(line);
      continue;
    }
    flushRun();
    const [paragraph] = groupParagraphs([line]);
    if (paragraph !== undefined) appendParagraph(blocks, paragraph, geometry, "heading");
  }
  flushRun();
  return blocks;
}

/** The heading level each heading type takes: the largest type size is level 1, the next 2, and so on. */
function headingLevels(sizes: readonly number[]): Map<number, HeadingLevel> {
  const levels = new Map<number, HeadingLevel>();
  const distinct = [...new Set(sizes)].sort((left, right) => right - left);
  for (const [index, size] of distinct.entries()) {
    levels.set(size, HEADING_LEVELS[Math.min(index, HEADING_LEVELS.length - 1)] ?? 1);
  }
  return levels;
}

/** The document's own title, from its information dictionary, or `undefined` when it declares none. */
async function declaredTitle(pdf: PdfDocumentLike): Promise<string | undefined> {
  try {
    const metadata = await pdf.getMetadata();
    return stringField(metadata.info, "Title");
  } catch {
    return undefined;
  }
}

/** The first heading's text, the fallback title for a document whose information dictionary is silent. */
function firstHeading(blocks: readonly ParsedBlock[]): string {
  for (const block of blocks) {
    if (block.rawBlock.kind === "heading") return block.rawBlock.text;
  }
  return "";
}

/** The members of a pdfjs page this parser reads. */
interface PdfPageLike {
  view: unknown;
  getTextContent(): Promise<{ items: unknown[] }>;
  cleanup(): void;
}

/** The members of a pdfjs document this parser reads. */
interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
  getMetadata(): Promise<{ info: unknown }>;
}

/** The characters a page's text layer actually carries, the count F§5.5's fallback is measured against. */
function extractedCharacters(items: readonly PdfTextItem[]): number {
  return items.reduce((total, item) => total + item.str.length, 0);
}

/**
 * F§5.5's scanned-page fallback: a page whose own text layer is all but empty (fewer than 20
 * characters on it) is rasterized at 200 DPI and read by the OCR engine, and the lines that come
 * back are the page's blocks.
 *
 * Those blocks are `paragraph`s carrying the page they came from and nothing else. A scan holds no
 * type size to measure and no item to point a `PdfAnchor` at, so an OCR'd page yields no anchors at
 * all (F§5.5). A page with a usable text layer is never rasterized, and a caller that supplied no
 * engine gets no blocks here — the text layer is then the only thing the page contributes.
 */
async function ocrBlocks(bytes: Uint8Array, page: number, characters: number, ocr: OcrEngine | undefined): Promise<ParsedBlock[]> {
  if (ocr === undefined || characters >= OCR_MIN_CHARACTERS) return [];
  const png = await rasterizePdfPage(bytes, page, OCR_RASTER_DPI);
  const recognized = await ocr.recognize(png, { lang: OCR_LANG });
  // The type size is 0 because an OCR'd line has none; it is read only to rank headings, and none of these is one.
  return groupOcrLines(recognized.lines).map((rawBlock) => ({ rawBlock: { ...rawBlock, page }, fontSize: 0, locations: [] }));
}

/**
 * Parse a PDF (F§5.4). Every page is read for its text items, each page's items are grouped into
 * lines, headlines and paragraphs with the page's own median type size, and the blocks come out in
 * reading order. The document's title is the one it declares, or the first heading's text.
 */
export async function parsePdf(bytes: Uint8Array, options: ParsePdfOptions = {}): Promise<ParsedPdf> {
  // pdfjs takes ownership of the data it is handed: it transfers the array's buffer to its worker, and
  // nothing can read that buffer afterwards — not even a second call to this function with the same
  // array (measured: the second attempt fails with `DataCloneError`). The caller's bytes are therefore
  // copied first and stay exactly as they were, which also makes a `Buffer` argument acceptable, since
  // pdfjs refuses one.
  const data = new Uint8Array(bytes);
  const task = getDocument({ ...DOCUMENT_OPTIONS, data });
  try {
    const pdf: PdfDocumentLike = await task.promise;
    const declared = await declaredTitle(pdf);
    const blocks: ParsedBlock[] = [];

    for (let page = 1; page <= pdf.numPages; page += 1) {
      const pdfPage = await pdf.getPage(page);
      const content = await pdfPage.getTextContent();
      const items = toTextItems(content.items);
      const geometry: PageGeometry = {
        page,
        pageMedian: medianFontSize(items),
        pageHeight: toNumber(Array.isArray(pdfPage.view) ? pdfPage.view[3] : undefined, 0),
      };
      blocks.push(...blocksOfPage(items, geometry));
      blocks.push(...(await ocrBlocks(bytes, page, extractedCharacters(items), options.ocr)));
      pdfPage.cleanup();
    }

    const levels = headingLevels(blocks.filter((block) => block.rawBlock.kind === "heading").map((block) => block.fontSize));
    const rawBlocks = blocks.map((block) => {
      if (block.rawBlock.kind !== "heading") return block.rawBlock;
      return { ...block.rawBlock, level: levels.get(block.fontSize) ?? 1 };
    });
    const wordAnchors = blocks.flatMap((block, blockIndex) => block.locations.map((location) => ({ ...location, blockIndex })));

    return {
      rawBlocks,
      title: options.title ?? declared ?? firstHeading(blocks),
      pageCount: pdf.numPages,
      wordAnchors,
    };
  } finally {
    await task.destroy();
  }
}

/**
 * F§5.1's `PdfAnchor`s for a built document (F§5.4). Every word of every block that `parsePdf` located
 * becomes one anchor, in reading order — block, then sentence, then word — carrying the global
 * sentence index and the word's index inside it, alongside the page, the item and the character range
 * inside that item. A word the parser could not locate is left out rather than anchored to a guess.
 */
export function anchorsFor(document: DocumentModel, wordAnchors: readonly WordLocation[]): PdfAnchor[] {
  const byBlock = new Map<number, Map<number, WordLocation>>();
  for (const location of wordAnchors) {
    const block = byBlock.get(location.blockIndex) ?? new Map<number, WordLocation>();
    block.set(location.blockCharStart, location);
    byBlock.set(location.blockIndex, block);
  }

  const anchors: PdfAnchor[] = [];
  document.blocks.forEach((block, blockIndex) => {
    const locations = byBlock.get(blockIndex);
    if (locations === undefined) return;
    for (const sentence of block.sentences) {
      for (const word of sentence.words) {
        const location = locations.get(sentence.charStart + word.charStart);
        if (location === undefined) continue;
        anchors.push({
          sentenceIndex: sentence.index,
          wordIndex: word.index,
          page: location.page,
          itemIndex: location.itemIndex,
          charStart: location.charStart,
          charEnd: location.charEnd,
        });
      }
    }
  });
  return anchors;
}
