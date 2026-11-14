/**
 * The CSS Custom Highlight API boundary (F§10.1).
 *
 * The reader paints what it is reading with the browser's own highlight registry instead of wrapping text
 * in elements: a block stays one element holding one text node, and the two ranges that mark the active
 * sentence and the active word are handed to the platform. This module is the only place that touches the
 * API, so the rest of the reader can treat "this browser cannot paint highlights" as a settled answer
 * rather than a failure to handle at every call site.
 */

/** The registry name of the sentence being read. */
export const SENTENCE_HIGHLIGHT = "lectern-sentence";

/** The registry name of the word being read. */
export const WORD_HIGHLIGHT = "lectern-word";

/** The two names this package registers, so a caller cannot invent a third by mistake. */
export type HighlightName = typeof SENTENCE_HIGHLIGHT | typeof WORD_HIGHLIGHT;

/**
 * Whether this browser can paint CSS highlights. False where the API is absent — an older browser, or a
 * server render, where `CSS` is not defined at all — and every function here is then a no-op.
 */
export function isHighlightSupported(): boolean {
  return typeof CSS !== "undefined" && typeof Highlight === "function" && CSS.highlights !== undefined;
}

/** Register `ranges` under `name`, replacing whatever was registered there before. */
export function setHighlight(name: HighlightName, ranges: Range[]): void {
  if (!isHighlightSupported()) return;
  CSS.highlights.set(name, new Highlight(...ranges));
}

/** Remove everything registered under `name`, leaving the other name alone. */
export function clearHighlight(name: HighlightName): void {
  if (!isHighlightSupported()) return;
  CSS.highlights.delete(name);
}
