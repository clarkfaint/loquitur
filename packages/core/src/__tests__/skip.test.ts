import { expect, test } from "vitest";
import type { RawBlock } from "../builder";
import { buildDocument } from "../builder";
import { classifySkip, stripCitations } from "../skip";

/** A paged document whose every page opens with the same line and closes with `Page N`. */
function pagedDocument(pageCount: number): RawBlock[] {
  const blocks: RawBlock[] = [];
  for (let page = 1; page <= pageCount; page += 1) {
    blocks.push({ kind: "paragraph", page, yRatio: 0.02, text: "Chapter Three" });
    blocks.push({ kind: "paragraph", page, yRatio: 0.5, text: `Body paragraph for page ${page}.` });
    blocks.push({ kind: "paragraph", page, yRatio: 0.98, text: `Page ${page}` });
  }
  return blocks;
}

/** The furniture kinds this module can assign. */
function furniture(blocks: RawBlock[]): RawBlock[] {
  return blocks.filter((block) => block.kind === "header" || block.kind === "footer" || block.kind === "footnote");
}

test("a 5-page document marks exactly its repeated heading and its per-page footer", () => {
  const classified = classifySkip(pagedDocument(5));
  const marked = furniture(classified);

  expect(marked).toHaveLength(10);
  expect(marked.filter((block) => block.kind === "header")).toHaveLength(5);
  expect(marked.filter((block) => block.kind === "footer")).toHaveLength(5);

  for (const block of marked) {
    if (block.kind === "header") expect(block.text).toBe("Chapter Three");
    else expect(block.text).toBe(`Page ${block.page}`);
  }

  const bodies = classified.filter((block) => block.text.startsWith("Body paragraph"));
  expect(bodies).toHaveLength(5);
  expect(bodies.every((block) => block.kind === "paragraph")).toBe(true);
});

test("a 2-page document marks nothing, however obviously the line repeats", () => {
  const classified = classifySkip(pagedDocument(2));
  expect(furniture(classified)).toHaveLength(0);
  expect(classified.every((block) => block.kind === "paragraph")).toBe(true);
});

test("the 60% threshold is inclusive and a rarer line stays body text", () => {
  const blocks: RawBlock[] = [];
  for (let page = 1; page <= 5; page += 1) {
    if (page <= 3) blocks.push({ kind: "paragraph", page, yRatio: 0.01, text: "Part Two" });
    if (page <= 2) blocks.push({ kind: "paragraph", page, yRatio: 0.03, text: "Rarely Seen" });
    blocks.push({ kind: "paragraph", page, yRatio: 0.5, text: `Body ${page}.` });
  }

  const classified = classifySkip(blocks);
  expect(furniture(classified).map((block) => block.text)).toEqual(["Part Two", "Part Two", "Part Two"]);
  expect(classified.filter((block) => block.text === "Rarely Seen").every((block) => block.kind === "paragraph")).toBe(true);
});

test("a line in the body of the page is never furniture, even when its text repeats", () => {
  const blocks: RawBlock[] = [];
  for (let page = 1; page <= 5; page += 1) {
    blocks.push({ kind: "paragraph", page, yRatio: 0.5, text: "Running Title In The Middle" });
  }
  expect(furniture(classifySkip(blocks))).toHaveLength(0);
});

test("a footnote marker in small type is a footnote; the same text in body type is not", () => {
  const classified = classifySkip([
    { kind: "paragraph", page: 1, text: "1. See the note below.", fontRatio: 0.7 },
    { kind: "paragraph", page: 1, text: "1. This is ordinary text.", fontRatio: 1 },
    { kind: "paragraph", page: 1, text: "No marker here.", fontRatio: 0.5 },
  ]);
  expect(classified.map((block) => block.kind)).toEqual(["footnote", "paragraph", "paragraph"]);
});

test("classifySkip leaves its input untouched", () => {
  const input = pagedDocument(5);
  classifySkip(input);
  expect(input.every((block) => block.kind === "paragraph")).toBe(true);
  expect(input.map((block) => block.text)).toEqual(pagedDocument(5).map((block) => block.text));
});

test("skipped blocks stay in the model, flagged rather than deleted", () => {
  const doc = buildDocument(pagedDocument(5), { source: { kind: "pdf", pageCount: 5 } });
  expect(doc.blocks).toHaveLength(15);
  expect(doc.blocks.filter((block) => block.skip)).toHaveLength(10);
  expect(doc.blocks.filter((block) => block.kind === "header")).toHaveLength(5);
  expect(doc.blocks.filter((block) => block.kind === "footer")).toHaveLength(5);
  expect(doc.blocks.filter((block) => block.kind === "paragraph")).toHaveLength(5);
});

test("stripCitations removes bracketed numeric citations and leaves single spaces", () => {
  expect(stripCitations("See [12] and [3, 4].")).toBe("See and .");
  expect(stripCitations("One [1], two [2].")).toBe("One , two .");
  expect(stripCitations("No citations here.")).toBe("No citations here.");
});

test("stripCitations leaves brackets that are not numeric citations alone", () => {
  expect(stripCitations("See figure [a] there.")).toBe("See figure [a] there.");
  expect(stripCitations("An array [0] and [1] of items.")).toBe("An array and of items.");
});
