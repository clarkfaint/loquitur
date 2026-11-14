/**
 * The page's highlights (F§10.2): the sentence being read, and the word inside it, painted by the browser's own
 * highlight registry instead of by marking up the page.
 *
 * This is the whole reason the extension can read a page it does not own. A reader that wrapped every sentence
 * in a `<span>` would edit the document it was asked to read — breaking the page's own CSS, its scripts and its
 * selection — so nothing is inserted, moved or restyled: two `Range`s are handed to `CSS.highlights` under the
 * names F§10.2 fixes, and the platform paints them wherever they happen to lie.
 *
 * The rules live in one constructed stylesheet rather than in a `<style>` element, because a `<style>` element
 * is a page element too. It is added to the document's `adoptedStyleSheets` on the first `show` and removed
 * again by `clear`, so a page that has never been read carries no trace of the extension at all.
 *
 * Positions are F§5.1's own. A sentence is numbered globally across the document and a word within its
 * sentence, with character offsets into `Block.text` and `Sentence.text`; the map built beside the model is
 * what turns an offset pair back into a `Range` (`rangeFor`). Both halves of the highlight are therefore
 * arithmetic on the same map the document was extracted from, and cannot drift from the text they paint.
 */

import type { DocumentModel, Sentence } from "@lectern/core";
import type { TextMap } from "./text-map";

/** The registry name of the sentence being read (F§10.2). */
export const SENTENCE_HIGHLIGHT = "lectern-sentence";

/** The registry name of the word being read (F§10.2). */
export const WORD_HIGHLIGHT = "lectern-word";

/** The two registry names this module owns, so a caller cannot invent a third by mistake. */
export type PageHighlightName = typeof SENTENCE_HIGHLIGHT | typeof WORD_HIGHLIGHT;

/** What the reading asks of the page: paint this position, or paint nothing. */
export interface PageHighlighter {
  /** Paint the sentence at `sentenceIndex` and, inside it, the word at `wordIndex` (F§5.1's numbering). */
  show(sentenceIndex: number, wordIndex: number): void;
  /** Remove both highlights and the stylesheet that gave them their look. */
  clear(): void;
}

/**
 * The two looks, deliberately different (F§10.2 asks for a word that is stronger than its sentence): the
 * sentence is a soft wash a reader can see behind the words, the word a solid block with an underline. The
 * colours are literal because a content script paints on somebody else's page, which carries none of the
 * design tokens the Lectern app's own stylesheet declares.
 */
const RULES = [
  `::highlight(${SENTENCE_HIGHLIGHT}) { background-color: #fde68a; color: #1f2937; }`,
  `::highlight(${WORD_HIGHLIGHT}) { background-color: #f59e0b; color: #111827; text-decoration: underline; }`,
].join("\n");

/**
 * Whether this page can paint CSS highlights at all. False where the API is absent — an older browser, or a
 * document with no `CSS` global — and every function here is then a no-op rather than an exception.
 */
export function isHighlightSupported(): boolean {
  return typeof CSS !== "undefined" && typeof Highlight === "function" && CSS.highlights !== undefined;
}

/**
 * `createHighlighter(textMap, model)` — the page's highlighter, over the extraction that produced both.
 *
 * The map says where a block's characters are on the page; the model says which characters belong to which
 * sentence and word. Neither can answer the question alone, which is why both are taken here and why the
 * module keeps no state beyond the one stylesheet it may have added.
 */
export function createHighlighter(textMap: TextMap, model: DocumentModel): PageHighlighter {
  const sentences = sentencesOf(model);
  const owner = ownerDocumentOf(textMap);
  let sheet: CSSStyleSheet | null = null;

  /** Put the rules on the page once, and report whether the registry can be written to. */
  function attach(): boolean {
    if (owner === null || !isHighlightSupported()) return false;
    sheet ??= constructSheet();
    if (!owner.adoptedStyleSheets.includes(sheet)) {
      owner.adoptedStyleSheets = [...owner.adoptedStyleSheets, sheet];
    }
    return true;
  }

  return {
    show(sentenceIndex, wordIndex) {
      const found = sentences.get(sentenceIndex);
      if (found === undefined) return;
      const sentenceRange = textMap.rangeFor(found.blockIndex, found.sentence.charStart, found.sentence.charEnd);
      if (sentenceRange === null) return;
      if (!attach()) return;
      CSS.highlights.set(SENTENCE_HIGHLIGHT, new Highlight(sentenceRange));
      const word = found.sentence.words[wordIndex];
      const wordRange =
        word === undefined
          ? null
          : textMap.rangeFor(found.blockIndex, found.sentence.charStart + word.charStart, found.sentence.charStart + word.charEnd);
      if (wordRange === null) {
        CSS.highlights.delete(WORD_HIGHLIGHT);
        return;
      }
      CSS.highlights.set(WORD_HIGHLIGHT, new Highlight(wordRange));
    },

    clear() {
      if (isHighlightSupported()) {
        CSS.highlights.delete(SENTENCE_HIGHLIGHT);
        CSS.highlights.delete(WORD_HIGHLIGHT);
      }
      if (sheet === null) return;
      if (owner !== null) owner.adoptedStyleSheets = owner.adoptedStyleSheets.filter((candidate) => candidate !== sheet);
      sheet = null;
    },
  };
}

/** A sentence together with the block its offsets are relative to. */
interface LocatedSentence {
  blockIndex: number;
  sentence: Sentence;
}

/** Every sentence of the model, by F§5.1's global index. */
function sentencesOf(model: DocumentModel): ReadonlyMap<number, LocatedSentence> {
  const sentences = new Map<number, LocatedSentence>();
  for (const block of model.blocks) {
    for (const sentence of block.sentences) sentences.set(sentence.index, { blockIndex: block.index, sentence });
  }
  return sentences;
}

/** The document the mapped text belongs to, or `null` for a map with no blocks at all. */
function ownerDocumentOf(textMap: TextMap): Document | null {
  for (const block of textMap.blocks) {
    if (block.element.ownerDocument !== null) return block.element.ownerDocument;
  }
  return null;
}

/** The one stylesheet this highlighter adds, over the two rules above. */
function constructSheet(): CSSStyleSheet {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(RULES);
  return sheet;
}
