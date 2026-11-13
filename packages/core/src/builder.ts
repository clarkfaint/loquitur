/**
 * The document builder (F§5.1, F§5.2, F§5.4): the one place where parser output becomes a
 * `DocumentModel`.
 *
 * The order is load-bearing. Text is normalized first, because F§5.2 hashes the *normalized* block
 * texts into `docId` and F§5.1's sentence offsets are offsets into `Block.text`; empty blocks are
 * dropped next, so `Block.index` stays contiguous and no sentence range can be empty; skip
 * classification runs on the normalized text, so two spellings that differ only in a non-breaking
 * space compare equal; tokenization runs last and is the only step that reads offsets.
 */

import { docIdFor } from "./ids";
import type { Block, BlockKind, DocumentModel, Sentence, Source } from "./model";
import { normalizeText } from "./normalize";
import { classifySkip } from "./skip";
import { TOKENIZER_VERSION, tokenizeBlock } from "./tokenizer";

/** A heading level as F§5.1 fixes it: 1 to 6, and nothing else. */
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * One block as a parser hands it over: the text is unnormalized, the geometry is whatever the parser
 * could measure, and there is no `skip` flag yet — furniture is recognised by `classifySkip` (F§5.4).
 */
export interface RawBlock {
  kind: BlockKind;
  level?: HeadingLevel;
  page?: number;
  text: string;
  fontRatio?: number;
  yRatio?: number;
}

/** What the caller knows about a document before its blocks are read (F§5.1). */
export interface DocumentMetaInput {
  title?: string;
  lang?: string;
  source: Source;
}

/** BCP-47 default F§5.1 gives `DocumentModel.lang`. */
const DEFAULT_LANG = "en";

/** How much of the first block F§5.4's title fallback keeps. */
const TITLE_LENGTH = 60;

/** The kinds that are furniture: kept in the model, omitted from playback by the player's setting. */
const FURNITURE: ReadonlySet<BlockKind> = new Set<BlockKind>(["header", "footer", "footnote"]);

/** The F§5.1 `Block` for one classified raw block, with optionals present only when they apply. */
function toBlock(rawBlock: RawBlock, index: number, sentences: Sentence[]): Block {
  const heading = rawBlock.kind === "heading" && rawBlock.level !== undefined;
  return {
    index,
    kind: rawBlock.kind,
    skip: FURNITURE.has(rawBlock.kind),
    text: rawBlock.text,
    sentences,
    ...(heading ? { level: rawBlock.level } : {}),
    ...(rawBlock.page === undefined ? {} : { page: rawBlock.page }),
  };
}

/** The F§5.1 title rule: explicit title, else the first heading, else the first 60 characters. */
function titleOf(blocks: Block[], explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  for (const block of blocks) {
    if (block.kind === "heading") return block.text;
  }
  const first = blocks[0];
  return first === undefined ? "" : first.text.slice(0, TITLE_LENGTH);
}

/**
 * Build the `DocumentModel` for a document (F§5.4): normalize every block's text, drop the empty ones,
 * classify headers, footers and footnotes, tokenize with global sentence indexes, count words and
 * sentences, and identify the document by the hash of its block texts (F§5.2).
 *
 * A skipped block is never removed — F§5.4 keeps furniture in the model and leaves its omission to the
 * `skipFurniture` setting — so the returned document holds every block the parsers produced, each one
 * marked with whether it is furniture.
 */
export function buildDocument(rawBlocks: RawBlock[], meta: DocumentMetaInput): DocumentModel {
  const normalized: RawBlock[] = [];
  for (const rawBlock of rawBlocks) {
    const text = normalizeText(rawBlock.text);
    if (text === "") continue;
    normalized.push({ ...rawBlock, text });
  }

  const classified = classifySkip(normalized);
  const blocks: Block[] = [];
  let sentenceCount = 0;
  let wordCount = 0;

  for (const rawBlock of classified) {
    const sentences = tokenizeBlock(rawBlock.text, sentenceCount, blocks.length);
    sentenceCount += sentences.length;
    for (const sentence of sentences) wordCount += sentence.words.length;
    blocks.push(toBlock(rawBlock, blocks.length, sentences));
  }

  return {
    schemaVersion: 1,
    tokenizerVersion: TOKENIZER_VERSION,
    docId: docIdFor(blocks.map((block) => block.text)),
    title: titleOf(blocks, meta.title),
    lang: meta.lang ?? DEFAULT_LANG,
    source: meta.source,
    blocks,
    sentenceCount,
    wordCount,
  };
}
