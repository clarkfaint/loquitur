/**
 * A page's recognised lines, in F§5.5's shape (F§5.5, F§10.4).
 *
 * The on-device recogniser answers with text blocks that hold lines, and each line carries its text and the
 * frame it was read in — `{ left, top, width, height }` in the photographed image's own pixels. F§5.5's
 * `OcrLine` asks for a corner-pair box instead (`[left, top, right, bottom]`) plus a confidence on the 0–100
 * scale, and `groupOcrLines` reads those two numbers to decide where one paragraph ends and the next begins.
 * This module is that conversion and nothing else, so it is pure: no recogniser is loaded here, no device is
 * touched, and the installed package is imported for its types alone.
 *
 * **The confidence.** The installed `@react-native-ml-kit/text-recognition@2.0.0` typings declare no
 * confidence on a line (its `TextLine` is `text`, `frame?`, `cornerPoints?`, `elements`,
 * `recognizedLanguages`), and ML Kit does not report one. F§5.5's scale is still what the shape asks for, so a
 * line the recogniser did not score is reported at 100 — trusted, rather than dropped by a floor no engine here
 * measures. A recogniser that *does* report a score keeps it, which is why the input type widens the installed
 * one by that one optional field.
 *
 * **A line without a frame.** The typings mark `frame` optional and a device may leave it out, so such a line
 * is placed in reading order: a zero-height box at the bottom of the line before it, clamped to the page. Zero
 * height is deliberate — it asks for no paragraph break of its own, because a line whose geometry was not
 * measured cannot claim the whitespace that splits one. `pageHeight` bounds that placement and nothing else: a
 * measured frame is reported exactly as the engine saw it, in the engine's pixels.
 */

import type { OcrLine } from "@lectern/core";
import type { Frame } from "@react-native-ml-kit/text-recognition";

/** The confidence F§5.5's shape is given for a line the recogniser did not score. */
export const UNSCORED_CONFIDENCE = 100;

/** One line as the recogniser reports it: the installed `TextLine`, widened by the score it may report. */
export interface RecognizedLine {
  text: string;
  frame?: Frame;
  /** A score on F§5.5's 0–100 scale, when a recogniser reports one. ML Kit does not. */
  confidence?: number;
}

/** One block as the recogniser reports it. */
export interface RecognizedBlock {
  text: string;
  frame?: Frame;
  lines: RecognizedLine[];
}

/**
 * One page as the recogniser reports it. `TextRecognitionResult` is assignable to this, so the real
 * recogniser's answer is passed straight in; the widening exists for the optional `confidence` above and for a
 * fixture a test writes by hand.
 */
export interface RecognizedPage {
  text: string;
  blocks: RecognizedBlock[];
}

/** The box one measured frame occupies, as F§5.5's `[left, top, right, bottom]`. */
function boxOf(frame: Frame): [number, number, number, number] {
  return [frame.left, frame.top, frame.left + frame.width, frame.top + frame.height];
}

/** The line's score, or F§5.5's trust value when it reports none. */
function confidenceOf(line: RecognizedLine): number {
  const reported = line.confidence;
  return typeof reported === "number" && Number.isFinite(reported) ? reported : UNSCORED_CONFIDENCE;
}

/**
 * `pageHeightOf(page)` — how tall the page the recogniser read was, in its own pixels: the lowest edge any frame
 * in the answer reaches. Neither the recogniser nor the scanner reports an image's dimensions, so the answer's
 * own geometry is the only measurement available, and it is exactly the bound `linesFromRecognition` needs.
 * A page whose answer carries no frame at all answers `0`.
 */
export function pageHeightOf(page: RecognizedPage): number {
  let height = 0;
  for (const block of page.blocks) {
    const frame = block.frame;
    if (frame !== undefined) height = Math.max(height, frame.top + frame.height);
    for (const line of block.lines) {
      const lineFrame = line.frame;
      if (lineFrame !== undefined) height = Math.max(height, lineFrame.top + lineFrame.height);
    }
  }
  return height;
}

/**
 * `linesFromRecognition(page, pageHeight)` — every line of the answer, in the order the recogniser reported it
 * (block by block, line by line), as the `OcrLine`s `groupOcrLines` groups.
 *
 * A line's own frame is preferred to its block's, because the line is what was measured; the block's frame is
 * the fallback for a recogniser that measured the paragraph and not its rows. The text is passed through
 * unchanged: collapsing whitespace and dropping blank lines is `groupOcrLines`'s own work (F§5.5), and doing it
 * twice would be two answers to one question.
 */
export function linesFromRecognition(page: RecognizedPage, pageHeight: number): OcrLine[] {
  const limit = pageHeight > 0 && Number.isFinite(pageHeight) ? pageHeight : null;
  const lines: OcrLine[] = [];
  let cursor = 0;

  for (const block of page.blocks) {
    for (const line of block.lines) {
      const frame = line.frame ?? block.frame;
      if (frame === undefined) {
        const top = limit === null ? Math.max(cursor, 0) : Math.min(Math.max(cursor, 0), limit);
        lines.push({ text: line.text, bbox: [0, top, 0, top], confidence: confidenceOf(line) });
        continue;
      }
      const box = boxOf(frame);
      cursor = box[3];
      lines.push({ text: line.text, bbox: box, confidence: confidenceOf(line) });
    }
  }
  return lines;
}
