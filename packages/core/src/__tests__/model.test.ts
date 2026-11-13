import { expect, test } from "vitest";
import {
  type Block,
  BlockKindSchema,
  BlockSchema,
  type DocumentModel,
  DocumentModelSchema,
  type PdfAnchor,
  PdfAnchorSchema,
  type Position,
  PositionSchema,
  type Sentence,
  SentenceSchema,
  type Source,
  SourceKindSchema,
  SourceSchema,
  type Word,
  WordSchema,
} from "../model";

// The object literals below carry the F§5.1 type annotations deliberately: `tsc` is what proves that
// the schema-inferred types have exactly the fields, the optionality and the literal values F§5.1
// declares, since the types are `z.infer` of the schemas and cannot be checked any other way.

const firstWord: Word = { index: 0, charStart: 0, charEnd: 6, text: "Hello," };
const secondWord: Word = { index: 1, charStart: 7, charEnd: 13, text: "world." };
const sentence: Sentence = {
  index: 0,
  blockIndex: 0,
  charStart: 0,
  charEnd: 13,
  text: "Hello, world.",
  words: [firstWord, secondWord],
};
const paragraph: Block = {
  index: 0,
  kind: "paragraph",
  page: 1,
  skip: false,
  text: "Hello, world.",
  sentences: [sentence],
};
const heading: Block = {
  index: 1,
  kind: "heading",
  level: 1,
  skip: false,
  text: "Title",
  sentences: [],
};
const source: Source = { kind: "txt", uri: "lectern-probe.txt", mime: "text/plain" };
const position: Position = { docId: "f8c3bf62a9aa3e6fc1619c250e48abe7", sentenceIndex: 0, wordIndex: 1 };
const pdfAnchor: PdfAnchor = {
  sentenceIndex: 0,
  wordIndex: 0,
  page: 1,
  itemIndex: 0,
  charStart: 0,
  charEnd: 13,
};

const validDocument: DocumentModel = {
  schemaVersion: 1,
  tokenizerVersion: 1,
  docId: "684c0459dd47803dec1ee32224195049",
  title: "Probe document",
  lang: "en",
  source,
  blocks: [paragraph, heading],
  sentenceCount: 1,
  wordCount: 2,
};

/** Parses `value` as a document, asserts the document is rejected, and returns where it was rejected. */
function rejectionPaths(value: unknown): PropertyKey[][] {
  const result = DocumentModelSchema.safeParse(value);
  expect(result.success).toBe(false);
  return result.success ? [] : result.error.issues.map((issue) => issue.path);
}

test("a valid document parses and keeps every field", () => {
  const parsed: DocumentModel = DocumentModelSchema.parse(validDocument);
  expect(parsed).toEqual(validDocument);
});

test("every F§5.1 schema parses its own shape", () => {
  expect(WordSchema.parse(firstWord)).toEqual(firstWord);
  expect(SentenceSchema.parse(sentence)).toEqual(sentence);
  expect(BlockSchema.parse(paragraph)).toEqual(paragraph);
  expect(BlockSchema.parse(heading)).toEqual(heading);
  expect(SourceSchema.parse(source)).toEqual(source);
  expect(PositionSchema.parse(position)).toEqual(position);
  expect(PdfAnchorSchema.parse(pdfAnchor)).toEqual(pdfAnchor);
});

test("SourceKind and BlockKind list exactly the F§5.1 members", () => {
  const sourceKinds = ["pdf", "epub", "docx", "txt", "html", "url", "ocr", "selection", "summary"] as const;
  for (const kind of sourceKinds) expect(SourceKindSchema.safeParse(kind).success).toBe(true);
  expect(SourceKindSchema.safeParse("mobi").success).toBe(false);
  const blockKinds = ["heading", "paragraph", "list-item", "quote", "caption", "header", "footer", "footnote"] as const;
  for (const kind of blockKinds) expect(BlockKindSchema.safeParse(kind).success).toBe(true);
  expect(BlockKindSchema.safeParse("chapter").success).toBe(false);
});

test("rejects a document whose schemaVersion is not the literal 1", () => {
  expect(rejectionPaths({ ...validDocument, schemaVersion: 2 })).toEqual([["schemaVersion"]]);
});

test("rejects a document whose tokenizerVersion is not the literal 1", () => {
  expect(rejectionPaths({ ...validDocument, tokenizerVersion: 2 })).toEqual([["tokenizerVersion"]]);
});

test("rejects a document whose source kind is outside SourceKind", () => {
  expect(rejectionPaths({ ...validDocument, source: { kind: "podcast" } })).toEqual([["source", "kind"]]);
});

test("rejects a block whose kind is outside BlockKind", () => {
  const invalidBlock = { ...paragraph, kind: "chapter" };
  expect(rejectionPaths({ ...validDocument, blocks: [invalidBlock] })).toEqual([["blocks", 0, "kind"]]);
});

test("rejects a heading whose level is outside 1 to 6", () => {
  const invalidHeading = { ...heading, level: 7 };
  expect(rejectionPaths({ ...validDocument, blocks: [invalidHeading] })).toEqual([["blocks", 0, "level"]]);
});

test("rejects a block that omits a required field", () => {
  const incompleteBlock = { index: 0, kind: "paragraph", text: "Hello, world.", sentences: [] };
  expect(rejectionPaths({ ...validDocument, blocks: [incompleteBlock] })).toEqual([["blocks", 0, "skip"]]);
});

test("rejects a document carrying an unrecognized key", () => {
  expect(DocumentModelSchema.safeParse({ ...validDocument, narrator: "unexpected" }).success).toBe(false);
  expect(rejectionPaths({ ...validDocument, blocks: [{ ...paragraph, colour: "red" }] })).toEqual([["blocks", 0]]);
});
