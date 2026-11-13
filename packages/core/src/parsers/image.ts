/**
 * The image parser (F§5.4's Image / scanned PDF row, F§5.5): a photograph or a scan becomes blocks
 * through the OCR engine and nothing else.
 *
 * There is no text layer to fall back on here and no library to lean on: the bytes go to the engine
 * as they arrived — tesseract.js decodes PNG, JPEG and BMP itself — and what comes back is grouped by
 * `groupOcrLines`. OCR'd text carries no provenance, so no block is given a `page` (an image has no
 * page number) and no word is given an anchor; F§5.5 gives anchors to the PDF path's text layer
 * alone.
 *
 * The title is the first block's text, cut the way F§5.1's own title fallback cuts it, because a scan
 * of a document usually opens with its heading and the hub has nothing else to offer as a name.
 */

import type { RawBlock } from "../builder";
import type { OcrEngine } from "../ocr";
import { groupOcrLines, OCR_LANG } from "../ocr";

/** How much of the first block's text the title keeps, as F§5.1's fallback does. */
const TITLE_LENGTH = 60;

/** What `parseImage` hands to `buildDocument` (F§5.4): raw blocks plus the document's own metadata. */
export interface ParsedImage {
  rawBlocks: RawBlock[];
  title: string;
}

/**
 * Parse an image into raw blocks and metadata (F§5.5). The engine is the caller's: the hub supplies
 * its tesseract adapter, a device with an on-device engine supplies that instead, and this parser
 * never creates one of its own.
 */
export async function parseImage(bytes: Uint8Array, ocr: OcrEngine): Promise<ParsedImage> {
  const recognized = await ocr.recognize(bytes, { lang: OCR_LANG });
  const rawBlocks = groupOcrLines(recognized.lines);
  const first = rawBlocks[0];
  return { rawBlocks, title: first === undefined ? "" : first.text.slice(0, TITLE_LENGTH) };
}
