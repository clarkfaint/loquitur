import { expect, test } from "vitest";
import type { RawBlock } from "../builder";
import { buildDocument } from "../builder";
import { DocumentModelSchema } from "../model";
import { playableSentences, sentenceAt } from "../playable";

const TXT = { kind: "txt" } as const;

/** A 3-page document whose first and last lines are running furniture (F§5.4). */
function pagedDocument(pageCount: number): RawBlock[] {
  const blocks: RawBlock[] = [];
  for (let page = 1; page <= pageCount; page += 1) {
    blocks.push({ kind: "paragraph", page, yRatio: 0.02, text: "Chapter Three" });
    blocks.push({ kind: "paragraph", page, yRatio: 0.5, text: `Body paragraph for page ${page}.` });
    blocks.push({ kind: "paragraph", page, yRatio: 0.98, text: `Page ${page}` });
  }
  return blocks;
}

test("a built document validates against DocumentModelSchema", () => {
  const doc = buildDocument(
    [
      { kind: "heading", level: 1, text: "Title" },
      { kind: "paragraph", text: "Hello, world. Second sentence here." },
    ],
    { source: TXT },
  );
  expect(DocumentModelSchema.safeParse(doc).success).toBe(true);
});

test("sentence indexes are contiguous from 0 across the whole document", () => {
  const doc = buildDocument(
    [
      { kind: "paragraph", text: "First block. It has two sentences." },
      { kind: "paragraph", text: "Second block. It has two as well." },
    ],
    { source: TXT },
  );
  const indexes = doc.blocks.flatMap((block) => block.sentences.map((sentence) => sentence.index));
  expect(indexes).toEqual([0, 1, 2, 3]);
  expect(doc.sentenceCount).toBe(4);
  expect(doc.blocks.map((block) => block.index)).toEqual([0, 1]);
  expect(doc.blocks.flatMap((block) => block.sentences.map((sentence) => sentence.blockIndex))).toEqual([0, 0, 1, 1]);
});

test("every sentence's range slices its own text out of the owning block", () => {
  const doc = buildDocument([{ kind: "paragraph", text: "  Wait...  what? Yes!  " }], { source: TXT });
  for (const block of doc.blocks) {
    expect(block.text).toBe("Wait... what? Yes!");
    for (const sentence of block.sentences) {
      expect(block.text.slice(sentence.charStart, sentence.charEnd)).toBe(sentence.text);
    }
  }
});

test("docId is the F§5.2 golden value for one block", () => {
  const doc = buildDocument([{ kind: "paragraph", text: "Hello, world." }], { source: TXT });
  expect(doc.docId).toBe("f8c3bf62a9aa3e6fc1619c250e48abe7");
});

test("docId is the F§5.2 golden value for two blocks", () => {
  const doc = buildDocument(
    [
      { kind: "heading", level: 1, text: "Title" },
      { kind: "paragraph", text: "Hello, world. Second sentence here." },
    ],
    { source: TXT },
  );
  expect(doc.docId).toBe("684c0459dd47803dec1ee32224195049");
});

test("sentence and word counts cover every block", () => {
  const doc = buildDocument([{ kind: "paragraph", text: "Hello, world. Second sentence here." }], { source: TXT });
  expect(doc.sentenceCount).toBe(2);
  expect(doc.wordCount).toBe(5);
  const counted = doc.blocks.reduce(
    (total, block) => total + block.sentences.reduce((words, sentence) => words + sentence.words.length, 0),
    0,
  );
  expect(doc.wordCount).toBe(counted);
});

test("the title prefers an explicit title, then the first heading, then 60 characters", () => {
  const blocks: RawBlock[] = [
    { kind: "paragraph", text: "Opening paragraph." },
    { kind: "heading", level: 2, text: "Chapter Two" },
  ];
  expect(buildDocument(blocks, { source: TXT, title: "Custom" }).title).toBe("Custom");
  expect(buildDocument(blocks, { source: TXT }).title).toBe("Chapter Two");

  const long = "This first block is deliberately long enough to exceed sixty characters.";
  const fallback = buildDocument([{ kind: "paragraph", text: long }], { source: TXT });
  expect(fallback.title).toBe("This first block is deliberately long enough to exceed sixty");
  expect(fallback.title).toHaveLength(60);
});

test("blocks that normalize to nothing are dropped and the model stays dense", () => {
  const doc = buildDocument(
    [
      { kind: "paragraph", text: "   \n\t  " },
      { kind: "paragraph", text: "Kept." },
      { kind: "paragraph", text: "" },
    ],
    { source: TXT },
  );
  expect(doc.blocks).toHaveLength(1);
  expect(doc.blocks[0]?.index).toBe(0);
  expect(doc.blocks[0]?.text).toBe("Kept.");
  expect(doc.sentenceCount).toBe(1);
});

test("playableSentences omits furniture only when skipFurniture is on", () => {
  const doc = buildDocument(pagedDocument(3), { source: { kind: "pdf", pageCount: 3 } });
  expect(doc.blocks).toHaveLength(9);
  expect(doc.blocks.filter((block) => block.skip)).toHaveLength(6);
  expect(playableSentences(doc, { skipFurniture: true })).toEqual([1, 4, 7]);
  expect(playableSentences(doc, { skipFurniture: false })).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test("sentenceAt resolves a global index and refuses one the document does not have", () => {
  const doc = buildDocument(pagedDocument(3), { source: { kind: "pdf", pageCount: 3 } });
  expect(sentenceAt(doc, 1).text).toBe("Body paragraph for page 1.");
  expect(sentenceAt(doc, 0).text).toBe("Chapter Three");
  expect(sentenceAt(doc, 8).text).toBe("Page 3");
  expect(() => sentenceAt(doc, 9)).toThrow(RangeError);
});
