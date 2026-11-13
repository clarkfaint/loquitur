/**
 * Playback order (F§5.1, F§5.4): which sentences the player reads, and where a global sentence index
 * points in the document.
 *
 * Skipped blocks stay in the model, so the omission of furniture is a decision made here, once per
 * queue build, from the `skipFurniture` setting the caller passes in — never by changing the model.
 */

import type { DocumentModel, Sentence } from "./model";

/** How playback is built for one document: `skipFurniture` mirrors the document setting (F§5.4). */
export interface PlayableOptions {
  skipFurniture: boolean;
}

/**
 * The global sentence indexes the player reads, in document order. With `skipFurniture` on, a block
 * whose `skip` is true contributes none of its sentences; with it off, every sentence of the document is
 * read, furniture included.
 */
export function playableSentences(doc: DocumentModel, options: PlayableOptions): number[] {
  const indexes: number[] = [];
  for (const block of doc.blocks) {
    if (options.skipFurniture && block.skip) continue;
    for (const sentence of block.sentences) indexes.push(sentence.index);
  }
  return indexes;
}

/**
 * The sentence with the given **global** index (F§5.1 numbers sentences across the whole document),
 * whether or not its block is skipped — a position restored from the library may well sit in furniture.
 * A document that has no such sentence cannot answer with a `Sentence`, so this throws a `RangeError`
 * naming the index rather than returning a value that does not exist.
 */
export function sentenceAt(doc: DocumentModel, index: number): Sentence {
  for (const block of doc.blocks) {
    for (const sentence of block.sentences) {
      if (sentence.index === index) return sentence;
    }
  }
  throw new RangeError(`sentenceAt: document ${doc.docId} has no sentence with index ${index}`);
}
