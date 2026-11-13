/**
 * The OCR pipeline's isomorphic half (F§5.5): the engine contract each OCR adapter implements, and
 * the rule that turns an engine's positioned lines into the `RawBlock`s `buildDocument` takes.
 *
 * Nothing here touches a library. An engine is anything that reads an image and returns lines with a
 * bounding box and a confidence; the hub's tesseract adapter (`./parsers/ocr-tesseract`) and the
 * camera path's on-device engine are both just implementations of it. Keeping the interface and the
 * grouping rule out of `./parsers` is what lets Android — which never loads tesseract — share them.
 *
 * The grouping rule is F§5.5's, read as geometry: lines are read top to bottom, and a *whitespace*
 * gap between one line's box and the next one's wider than 1.5× the median line height starts a new
 * paragraph. Comparing the ink-to-ink gap rather than the distance between the two tops is what
 * separates ordinary leading from a paragraph break on a real page: measured on `text.pdf` rendered
 * at 200 DPI, consecutive lines leave 47–48 px of whitespace where a paragraph start leaves 55–238 px
 * against a median line height of 36 px (threshold 54 px), and the rule reads that page back as eight
 * blocks. The tighter canvas render in `page.png` leaves only 14 px between lines and 34–40 px at its
 * one block break against a 26 px median (threshold 39 px), so the same rule finds two blocks there —
 * a scan with generous inter-paragraph spacing is what the threshold is tuned for.
 */

import type { RawBlock } from "./builder";

/**
 * One line an OCR engine read: the text it saw, the box it saw it in, and how sure it was.
 *
 * The box is `[left, top, right, bottom]` in the engine's own pixel coordinates — the image's pixels,
 * never the page's points — because that is the only frame an engine can report in.
 */
export interface OcrLine {
  text: string;
  bbox: [number, number, number, number];
  /** The engine's mean confidence for the line, on the 0–100 scale F§5.5's threshold is written in. */
  confidence: number;
}

/** What `OcrEngine.recognize` answers with (F§5.5). */
export interface OcrResult {
  lines: OcrLine[];
}

/** An OCR engine (F§5.5): a stable id for logs and telemetry-free diagnostics, and one call. */
export interface OcrEngine {
  id: string;
  recognize(image: Uint8Array, opts: { lang: string }): Promise<OcrResult>;
}

/** F§5.5's confidence floor: a line the engine is less sure of than this is dropped. */
export const OCR_MIN_CONFIDENCE = 40;

/** F§5.5's paragraph rule: a whitespace gap wider than this multiple of the median line height splits. */
export const OCR_PARAGRAPH_GAP = 1.5;

/**
 * The language an engine is asked to read (F§5.5): the hub's OCR language, which is the language data
 * installed beside the engine (`@tesseract.js-data/eng`). A caller that reads another language passes
 * its own code to `recognize`; the two parsers that own no language of their own — an image and a
 * scanned page — ask for this one.
 */
export const OCR_LANG = "eng";

/** A line that survived the confidence filter, reduced to what the grouping reads. */
interface PlacedLine {
  text: string;
  top: number;
  bottom: number;
  left: number;
}

/** One line's text as an OCR engine's output needs it: one line, one space, no newline. */
function flatten(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** The middle value of a non-empty list of measurements, averaged for an even count. */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * Group an engine's lines into blocks (F§5.5): drop the lines below the confidence floor, read the
 * rest top to bottom (and left to right where two share a top, which is how a two-column page is
 * ordered without a column model), and start a new paragraph wherever the whitespace between two
 * lines is wider than 1.5× the median line height.
 *
 * The median is taken over the lines that survived the filter, so a line the engine was unsure of
 * cannot move the threshold; a line whose text is blank once its newlines are flattened holds no
 * word and is dropped with it. Every block comes out as a `paragraph`: F§5.5 says nothing about
 * recognising headings in a scan, so nothing here guesses at one.
 */
export function groupOcrLines(lines: readonly OcrLine[]): RawBlock[] {
  const placed: PlacedLine[] = [];
  for (const line of lines) {
    if (line.confidence < OCR_MIN_CONFIDENCE) continue;
    const text = flatten(line.text);
    if (text === "") continue;
    placed.push({ text, top: line.bbox[1], bottom: line.bbox[3], left: line.bbox[0] });
  }
  if (placed.length === 0) return [];

  const ordered = [...placed].sort((left, right) => left.top - right.top || left.left - right.left);
  const lineHeight = median(ordered.map((line) => Math.max(0, line.bottom - line.top)));
  const threshold = OCR_PARAGRAPH_GAP * lineHeight;

  const blocks: RawBlock[] = [];
  let paragraph: string[] = [];
  let previous: PlacedLine | undefined;

  const flush = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };

  for (const line of ordered) {
    if (previous !== undefined && line.top - previous.bottom > threshold) flush();
    paragraph.push(line.text);
    previous = line;
  }
  flush();
  return blocks;
}
