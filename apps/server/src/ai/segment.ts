/**
 * F§9's segmentation: the text of a document that the model is allowed to see, packed into the pieces the map
 * step reads.
 *
 * Two rules shape everything here, and both are F§9's:
 *
 * - **Skipped blocks never travel.** A header, a footer or a footnote is page furniture (F§5.4), so a
 *   document's non-reading matter is left out rather than summarized as if it were the argument. The model is
 *   never told what was left out either: a segment is text, not a document with holes in it.
 * - **A segment is at most 12 000 characters, and a block is never cut in half.** Blocks are packed whole, in
 *   document order, into as few segments as the limit allows. A single block that is longer than the limit
 *   cannot be packed at all, so it is split at its own sentence boundaries — the smallest break F§5.3 offers —
 *   which is the one exception to the rule that a block stays whole.
 *
 * A block is not a string to this module: it carries the sentences F§5.3 found in it, each with its own
 * offsets into the block's text, so a split reads the block's own characters through those offsets rather than
 * re-tokenizing text that was already tokenized once.
 */

import type { Block, DocumentModel, Sentence } from "@lectern/core";

/** F§9's ceiling for one segment: a model call reads at most this many characters. */
export const SEGMENT_MAX_CHARS = 12000;

/** What separates two blocks inside one segment, so a segment reads as the paragraphs it was packed from. */
const BLOCK_SEPARATOR = "\n\n";

/** What separates two sentences inside one block, matching the whitespace F§5.3 leaves between them. */
const SENTENCE_SEPARATOR = " ";

/**
 * A limit that is a positive whole number of characters. F§9's own limit is 12 000, and a caller may ask for a
 * smaller one; a caller that asks for something a segment could not hold is given the smallest limit that can
 * still make progress rather than an endless loop.
 */
function limitOf(maxChars: number): number {
  return Number.isFinite(maxChars) && maxChars >= 1 ? Math.floor(maxChars) : 1;
}

/** One sentence's own text, read through the offsets F§5.3 recorded into the owning block's text. */
function sentenceText(block: Block, sentence: Sentence): string {
  return block.text.slice(sentence.charStart, sentence.charEnd);
}

/**
 * Cut a run of text that is longer than the limit into pieces that are not. F§5.3 caps a sentence at 400
 * characters, so this is reachable only with a limit below that; the limit is the harder of the two rules, so
 * the text is cut at it and the remainder continues the next piece.
 */
function cutToLimit(text: string, limit: number): string[] {
  const pieces: string[] = [];
  for (let offset = 0; offset < text.length; offset += limit) pieces.push(text.slice(offset, offset + limit));
  return pieces;
}

/**
 * One block's text as the pieces a segment may hold: the block itself when it fits, and otherwise its
 * sentences packed to the limit. Every piece is at most `limit` characters, the pieces are in document order,
 * and their sentences joined with one space are the block's text.
 */
function blockPieces(block: Block, limit: number): string[] {
  if (block.text.length <= limit) return [block.text];

  const pieces: string[] = [];
  let current = "";
  for (const sentence of block.sentences) {
    const text = sentenceText(block, sentence);
    if (text === "") continue;

    if (current !== "" && current.length + SENTENCE_SEPARATOR.length + text.length > limit) {
      pieces.push(current);
      current = "";
    }

    if (text.length > limit) {
      const chunks = cutToLimit(text, limit);
      for (const chunk of chunks.slice(0, -1)) pieces.push(chunk);
      current = chunks.at(-1) ?? "";
      continue;
    }

    current = current === "" ? text : `${current}${SENTENCE_SEPARATOR}${text}`;
  }
  if (current !== "") pieces.push(current);
  // A block whose text carries no sentence at all cannot be packed by sentence, so it is cut by the limit.
  return pieces.length === 0 ? cutToLimit(block.text, limit) : pieces;
}

/**
 * `segmentDocument(doc, maxChars)` — F§9's segments: the document's non-skipped text, in document order, in
 * pieces of at most `maxChars` characters.
 *
 * A block joins the segment being built when it fits beside what is already there, and starts a new one when it
 * does not, so a document that fits is one segment and a long document is as few as its blocks allow. A
 * document with no reading matter at all — every block skipped, or no block — has no segments, which is what
 * tells the pipeline there is nothing to map.
 */
export function segmentDocument(doc: DocumentModel, maxChars: number = SEGMENT_MAX_CHARS): string[] {
  const limit = limitOf(maxChars);
  const segments: string[] = [];
  let current = "";

  function flush(): void {
    if (current === "") return;
    segments.push(current);
    current = "";
  }

  for (const block of doc.blocks) {
    if (block.skip) continue;
    if (block.text === "") continue;

    for (const piece of blockPieces(block, limit)) {
      if (current === "") {
        current = piece;
        continue;
      }
      if (current.length + BLOCK_SEPARATOR.length + piece.length <= limit) {
        current = `${current}${BLOCK_SEPARATOR}${piece}`;
        continue;
      }
      flush();
      current = piece;
    }
  }

  flush();
  return segments;
}
