/**
 * The pages of a scan as one document (F§5.1, F§10.4).
 *
 * A scan is pages of raw blocks: the scanner produced one image per page, the recogniser read each one, and
 * F§5.5's grouping turned each answer into paragraphs. This module puts them in document order and hands the
 * whole list to `buildDocument`, which is the one place a `DocumentModel` is made — so a scan's document is
 * normalized, skip-classified, tokenized and identified by exactly the code that builds a parsed PDF's, and
 * F§5.2's `docId` means the same thing on both paths (two scans of the same text are the same document).
 *
 * **Page numbers are the scan's own.** Each block is stamped with the 1-based page it was read from, so the
 * reader can be told where in the scan a sentence came from and `classifySkip` can recognise a repeated running
 * head across the pages it spans (F§5.4). A page that contributed no block is still a page: numbering is by
 * position in `pages`, not by how many blocks survived.
 *
 * **The title.** F§10.4's scanner leaves the reader with a document the moment it is saved and F§5.1 wants a
 * name, so a scan names itself after the minute it was assembled — `Scan YYYY-MM-DD HH:mm` — unless the scan
 * opens with a heading short enough to be a name, in which case F§5.1's own title rule is left to name the
 * document after that heading.
 *
 * **A scan that read nothing is not a document.** `buildDocument` normalizes each block's text and drops the
 * empty ones, so a scan whose every page came back blank assembles to a model with no blocks and no title —
 * the same answer `src/parsers/image.ts` gives for an empty engine result on the hub — and its caller is
 * expected to refuse it rather than store it. That is why no title is stamped in that case: a name for nothing
 * would only make the emptiness harder to see.
 */

import { buildDocument, type DocumentModel, type RawBlock, type Source } from "@lectern/core";

/** F§5.1's source for a document this device read with a camera and recognised itself (F§10.4, F§5.5). */
const OCR_SOURCE: Source = { kind: "ocr" };

/**
 * How long a heading may be and still name the document, which is the 60 characters F§5.1's own title fallback
 * keeps of a first block (`packages/core/src/builder.ts`, `TITLE_LENGTH`).
 */
const SHORT_HEADING_LENGTH = 60;

/** Two digits, as a date and a clock never carry one. */
function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

/**
 * `scanTitle(now)` — F§10.4's name for a scan the reader has not named: the local date and the minute it was
 * taken, so two scans of different pages are two library entries a reader can tell apart.
 */
export function scanTitle(now: Date): string {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `Scan ${date} ${time}`;
}

/** The document's blocks in reading order, each stamped with the 1-based page it was read from. */
function pagesOf(pages: readonly RawBlock[][]): RawBlock[] {
  const blocks: RawBlock[] = [];
  for (const [index, page] of pages.entries()) {
    for (const block of page) blocks.push({ ...block, page: index + 1 });
  }
  return blocks;
}

/** True when the scan opens with a heading short enough to be the document's name. */
function opensWithShortHeading(blocks: readonly RawBlock[]): boolean {
  const first = blocks[0];
  if (first === undefined || first.kind !== "heading") return false;
  const text = first.text.trim();
  return text !== "" && text.length <= SHORT_HEADING_LENGTH;
}

/**
 * `assembleScan(pages, now)` — one `DocumentModel` from the blocks of every page, in page order, with
 * `source.kind = "ocr"` and F§5.1's title rule applied as described above.
 */
export function assembleScan(pages: readonly RawBlock[][], now: Date): DocumentModel {
  const blocks = pagesOf(pages);
  if (blocks.length === 0) return buildDocument(blocks, { source: OCR_SOURCE });
  if (opensWithShortHeading(blocks)) return buildDocument(blocks, { source: OCR_SOURCE });
  return buildDocument(blocks, { title: scanTitle(now), source: OCR_SOURCE });
}
