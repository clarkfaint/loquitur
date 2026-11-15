/**
 * The reader's highlight geometry (F§5.1, F§10.4).
 *
 * The web reader paints the sentence and the word through the CSS Custom Highlight API, which takes a pair of
 * offsets into a text node. React Native has no range API at all, so the Android reader reaches the same
 * result a different way: the block being read is re-rendered as a short list of `<Text>` runs, each one
 * carrying its own background, and the whole document is therefore still one text element per sentence rather
 * than one element per word.
 *
 * Everything here is a pure function of the document model, which is what makes the two rules this unit has to
 * hold testable under Node: the runs of a block always concatenate back to that block's own text — so no
 * character is dropped, duplicated or reordered by highlighting — and a block that does not hold the active
 * sentence has nothing to split on, so it is one plain run.
 *
 * The offsets come from F§5.1 and are used exactly as the model stores them: a sentence's `charStart`/`charEnd`
 * are offsets into its `Block.text`, while a word's are offsets into its `Sentence.text` — the tokenizer's own
 * doc comment says so, and `packages/ui-web/src/highlight/locate.ts` composes them the same way — so a word's
 * place in the block is its sentence's start plus its own start.
 */

import type { Block, DocumentModel } from "@lectern/core";

/** How one run of a block's text is painted. `plain` is unmarked, the other two are F§10.4's two backgrounds. */
export type HighlightRole = "plain" | "sentence" | "word";

/** One run of a block's text: the text itself, and the role that decides its background. */
export interface HighlightSegment {
  text: string;
  role: HighlightRole;
}

/** The point the highlight is drawn for: a global sentence index, and a word index inside that sentence. */
export interface ActivePoint {
  sentenceIndex: number;
  wordIndex: number;
}

/** A number held inside `[low, high]`, so a malformed offset cannot slice outside the block's text. */
function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * `segmentsForBlock(block, active)` — the runs of one block's text, in document order, for the position being
 * read.
 *
 * A block that does not hold the active sentence is one `plain` run covering its whole text. A block that does
 * is split around the sentence's own offsets, and inside the sentence around the active word's — the word run
 * is exactly the active word's text, so the reader sees the word the engine is on rather than the word the
 * platform happens to be buffering. An empty run is never returned: a sentence at the start of a block has
 * nothing before it, and a run of no characters would be an element that draws nothing.
 */
export function segmentsForBlock(block: Block, active: ActivePoint): HighlightSegment[] {
  const sentence = block.sentences.find((candidate) => candidate.index === active.sentenceIndex);
  if (sentence === undefined) return [{ text: block.text, role: "plain" }];

  const length = block.text.length;
  const sentenceStart = clamp(sentence.charStart, 0, length);
  const sentenceEnd = clamp(sentence.charEnd, sentenceStart, length);
  const segments: HighlightSegment[] = [];
  const push = (text: string, role: HighlightRole): void => {
    if (text !== "") segments.push({ text, role });
  };

  push(block.text.slice(0, sentenceStart), "plain");

  const word = sentence.words[active.wordIndex];
  if (word === undefined) {
    push(block.text.slice(sentenceStart, sentenceEnd), "sentence");
  } else {
    // F§5.1 gives a word's offsets inside its sentence, so its place in the block is the sentence's start plus
    // its own; the word's text is that slice, which is the sentence's own slice of the same two numbers.
    const wordStart = clamp(sentenceStart + word.charStart, sentenceStart, sentenceEnd);
    const wordEnd = clamp(sentenceStart + word.charEnd, wordStart, sentenceEnd);
    push(block.text.slice(sentenceStart, wordStart), "sentence");
    push(block.text.slice(wordStart, wordEnd), "word");
    push(block.text.slice(wordEnd, sentenceEnd), "sentence");
  }

  push(block.text.slice(sentenceEnd), "plain");

  // A block whose text is empty has no run to draw; one empty run keeps every caller's invariant that a block
  // is always represented by at least one segment, and still concatenates to the block's text.
  if (segments.length === 0) segments.push({ text: "", role: "plain" });
  return segments;
}

/**
 * `blockIndexForSentence(doc, sentenceIndex)` — which block holds the sentence with that **global** index, or
 * `null` when the document has no such sentence.
 *
 * The list follows the active block while reading, and a block is what a virtualized list can scroll to, so
 * the position has to be resolved to one. F§5.1 numbers sentences across the whole document, so this is a
 * search rather than arithmetic; a sentence index restored from the library may well sit in a skipped block,
 * which is still a block the list draws.
 */
export function blockIndexForSentence(doc: DocumentModel, sentenceIndex: number): number | null {
  for (const block of doc.blocks) {
    for (const sentence of block.sentences) {
      if (sentence.index === sentenceIndex) return block.index;
    }
  }
  return null;
}
