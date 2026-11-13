import { z } from "zod";

/** Where a document came from (F§5.1). */
export const SourceKindSchema = z.enum(["pdf", "epub", "docx", "txt", "html", "url", "ocr", "selection", "summary"]);

/** What a block is, for reading order and furniture (F§5.1). */
export const BlockKindSchema = z.enum(["heading", "paragraph", "list-item", "quote", "caption", "header", "footer", "footnote"]);

/**
 * The origin of a document (F§5.1). `uri` and `mime` are absent when the source has neither, and
 * `pageCount` is present for paged sources only.
 */
export const SourceSchema = z.strictObject({
  kind: SourceKindSchema,
  uri: z.string().exactOptional(),
  mime: z.string().exactOptional(),
  pageCount: z.int().nonnegative().exactOptional(),
});

/** One word of a sentence, with the punctuation that is attached to it (F§5.1). */
export const WordSchema = z.strictObject({
  index: z.int().nonnegative(),
  charStart: z.int().nonnegative(),
  charEnd: z.int().nonnegative(),
  text: z.string(),
});

/** One sentence, with its global index and its offsets into the owning block's text (F§5.1). */
export const SentenceSchema = z.strictObject({
  index: z.int().nonnegative(),
  blockIndex: z.int().nonnegative(),
  charStart: z.int().nonnegative(),
  charEnd: z.int().nonnegative(),
  text: z.string(),
  words: z.array(WordSchema),
});

/** One block of a document: a heading, a paragraph, a list item, or furniture (F§5.1). */
export const BlockSchema = z.strictObject({
  index: z.int().nonnegative(),
  kind: BlockKindSchema,
  level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]).exactOptional(),
  page: z.int().nonnegative().exactOptional(),
  skip: z.boolean(),
  text: z.string(),
  sentences: z.array(SentenceSchema),
});

/** The whole document: the unit every later stage reads, writes and restores (F§5.1). */
export const DocumentModelSchema = z.strictObject({
  schemaVersion: z.literal(1),
  tokenizerVersion: z.literal(1),
  docId: z.string(),
  title: z.string(),
  lang: z.string(),
  source: SourceSchema,
  blocks: z.array(BlockSchema),
  sentenceCount: z.int().nonnegative(),
  wordCount: z.int().nonnegative(),
});

/** Where playback is, resolved back into the document (F§5.1). */
export const PositionSchema = z.strictObject({
  docId: z.string(),
  sentenceIndex: z.int().nonnegative(),
  wordIndex: z.int().nonnegative(),
});

/** Where a sentence came from in a paged source, for highlighting (F§5.1). */
export const PdfAnchorSchema = z.strictObject({
  sentenceIndex: z.int().nonnegative(),
  wordIndex: z.int().nonnegative(),
  page: z.int().nonnegative(),
  itemIndex: z.int().nonnegative(),
  charStart: z.int().nonnegative(),
  charEnd: z.int().nonnegative(),
});

export type SourceKind = z.infer<typeof SourceKindSchema>;
export type BlockKind = z.infer<typeof BlockKindSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type Word = z.infer<typeof WordSchema>;
export type Sentence = z.infer<typeof SentenceSchema>;
export type Block = z.infer<typeof BlockSchema>;
export type DocumentModel = z.infer<typeof DocumentModelSchema>;
export type Position = z.infer<typeof PositionSchema>;
export type PdfAnchor = z.infer<typeof PdfAnchorSchema>;
