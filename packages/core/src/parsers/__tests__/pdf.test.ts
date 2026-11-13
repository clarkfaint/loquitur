/**
 * F§5.4's PDF parser, run against the fixture U-005 generated.
 *
 * The fixtures are resolved through the `@lectern/fixtures` devDependency, so this test follows the
 * artefacts by name. Reading them needs `node:fs`, which has no declarations on this host, so this
 * file is outside the package's type-check program (its `__tests__` directories are excluded): vitest
 * types instead of checking them and runs it as written.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { expect, test } from "vitest";
import { z } from "zod";
import { buildDocument } from "../../builder";
import { DocumentModelSchema } from "../../model";
import { normalizeText } from "../../normalize";
import { anchorsFor, parsePdf } from "../pdf";

const require = createRequire(import.meta.url);

/** The generated PDF, and the expectations U-005 recorded for it. */
const PDF_BYTES = readFileSync(require.resolve("@lectern/fixtures/generated/text.pdf"));
const BYTES = new Uint8Array(PDF_BYTES);

/** The fields of `expected.json` this test reads; the fixture carries more. */
const ExpectationsSchema = z.object({
  title: z.string(),
  chapterTitles: z.array(z.string()),
  headerText: z.string(),
  footerPattern: z.string(),
  footnoteStart: z.string(),
  dehyphenatedWord: z.string(),
});

const EXPECTED = ExpectationsSchema.parse(JSON.parse(readFileSync(require.resolve("@lectern/fixtures/generated/expected.json"), "utf8")));

/** The fixture's pages, read twice on purpose: once by the parser, once for the items it points at. */
const PARSED_PAGES = 5;

const parsed = await parsePdf(BYTES);

const document = buildDocument(parsed.rawBlocks, {
  source: { kind: "pdf", mime: "application/pdf", pageCount: parsed.pageCount },
  title: parsed.title,
});

/** Every page's text items, as strings, so an anchor can be checked against the item it names. */
async function readPageItems(bytes: Uint8Array): Promise<string[][]> {
  const data = new Uint8Array(bytes);
  const task = getDocument({ data, useWorkerFetch: false, disableFontFace: true, verbosity: 0 });
  try {
    const pdf = await task.promise;
    const pages: string[][] = [];
    for (let page = 1; page <= pdf.numPages; page += 1) {
      const pdfPage = await pdf.getPage(page);
      const content = await pdfPage.getTextContent();
      pages.push(content.items.map((item) => ("str" in item && typeof item.str === "string" ? item.str : "")));
      pdfPage.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

const PAGE_ITEMS = await readPageItems(BYTES);

test("the fixture's five pages build into a valid model with its chapter headings", () => {
  expect(parsed.pageCount).toBe(PARSED_PAGES);
  expect(parsed.title).toBe(EXPECTED.title);
  expect(PAGE_ITEMS).toHaveLength(PARSED_PAGES);
  expect(DocumentModelSchema.safeParse(document).success).toBe(true);

  const headings = document.blocks.filter((block) => block.kind === "heading");
  expect(headings.map((block) => block.text)).toEqual(EXPECTED.chapterTitles);
  // One type size means one rank: every chapter of this fixture is the same heading level.
  expect(headings.every((block) => block.level !== undefined)).toBe(true);
  expect(new Set(headings.map((block) => block.level)).size).toBe(1);
});

test("the running header and the page-number footer are furniture on every page", () => {
  const headers = document.blocks.filter((block) => block.kind === "header");
  const footers = document.blocks.filter((block) => block.kind === "footer");
  const pages = [1, 2, 3, 4, 5];

  expect(headers).toHaveLength(PARSED_PAGES);
  expect(footers).toHaveLength(PARSED_PAGES);
  expect(headers.every((block) => block.skip)).toBe(true);
  expect(footers.every((block) => block.skip)).toBe(true);
  expect(headers.map((block) => block.page)).toEqual(pages);
  expect(footers.map((block) => block.page)).toEqual(pages);
  expect(headers.map((block) => block.text)).toEqual(pages.map(() => EXPECTED.headerText));
  expect(footers.map((block) => block.text)).toEqual(pages.map((page) => EXPECTED.footerPattern.replace("#", String(page))));
});

test("the footnote is a block of its own kind, and skipped", () => {
  const footnotes = document.blocks.filter((block) => block.kind === "footnote");

  expect(footnotes).toHaveLength(1);
  const [footnote] = footnotes;
  expect(footnote?.skip).toBe(true);
  expect(footnote?.page).toBe(PARSED_PAGES);
  expect(footnote?.text.startsWith(EXPECTED.footnoteStart)).toBe(true);
});

test("the word broken across a line break is read whole", () => {
  const block = document.blocks.find((entry) => entry.text.includes("Whatever the weather was doing at night"));

  expect(block).toBeDefined();
  expect(block?.text).toContain(EXPECTED.dehyphenatedWord);
  expect(block?.text).not.toContain("light-");
  expect(block?.sentences.flatMap((sentence) => sentence.words.map((word) => word.text))).toContain(EXPECTED.dehyphenatedWord);
  expect(document.blocks.some((entry) => entry.text.includes("light-"))).toBe(false);
});

test("every block of a paged source carries the page it was read from, and they come in reading order", () => {
  expect(document.blocks.every((block) => block.page !== undefined && block.page >= 1 && block.page <= PARSED_PAGES)).toBe(true);
  expect(document.blocks.map((block) => block.page)).toEqual(
    [...document.blocks.map((block) => block.page)].sort((left, right) => (left ?? 0) - (right ?? 0)),
  );

  parsed.rawBlocks.forEach((block, index) => {
    const previous = parsed.rawBlocks[index - 1];
    if (previous === undefined || previous.page !== block.page) return;
    expect(block.yRatio ?? 0).toBeGreaterThanOrEqual(previous.yRatio ?? 0);
  });
});

test("every word is anchored exactly once, to an item that exists on the page it names", () => {
  const anchors = anchorsFor(document, parsed.wordAnchors);

  /** The word behind an anchor, keyed the way a `PdfAnchor` names it. */
  const words = new Map<string, string>();
  for (const block of document.blocks) {
    for (const sentence of block.sentences) {
      for (const word of sentence.words) words.set(`${sentence.index}:${word.index}`, word.text);
    }
  }

  // One anchor per word of the document, and never two for the same word.
  expect(anchors).toHaveLength(document.wordCount);
  expect(new Set(anchors.map((anchor) => `${anchor.sentenceIndex}:${anchor.wordIndex}`)).size).toBe(anchors.length);

  for (const anchor of anchors) {
    const item = PAGE_ITEMS[anchor.page - 1]?.[anchor.itemIndex];
    expect(item).toBeDefined();
    expect(anchor.itemIndex).toBeLessThan(PAGE_ITEMS[anchor.page - 1]?.length ?? 0);

    const slice = (item ?? "").slice(anchor.charStart, anchor.charEnd);
    expect(slice.length).toBeGreaterThan(0);
    expect(words.get(`${anchor.sentenceIndex}:${anchor.wordIndex}`)?.startsWith(slice)).toBe(true);
  }

  // Every word of every block that is read at all is among them.
  const anchored = new Set(anchors.map((anchor) => `${anchor.sentenceIndex}:${anchor.wordIndex}`));
  for (const block of document.blocks.filter((entry) => !entry.skip)) {
    for (const sentence of block.sentences) {
      for (const word of sentence.words) expect(anchored.has(`${sentence.index}:${word.index}`)).toBe(true);
    }
  }
});

test("every block's text is already in the form F§5.2 normalizes to, which is what the anchors assume", () => {
  for (const block of document.blocks) expect(normalizeText(block.text)).toBe(block.text);
});

test("parsing leaves the caller's bytes intact, and reads them twice", async () => {
  // pdfjs transfers the buffer it is given, so this parser copies it: the same array has now been
  // parsed once here and once by the page-item reader above, and is still readable.
  expect(BYTES.byteLength).toBe(PDF_BYTES.byteLength);
  expect(BYTES.byteLength).toBeGreaterThan(0);

  const again = await parsePdf(BYTES);
  expect(again.pageCount).toBe(PARSED_PAGES);
  expect(again.rawBlocks.map((block) => block.text)).toEqual(parsed.rawBlocks.map((block) => block.text));
  expect([...BYTES.slice(0, 5)]).toEqual([...PDF_BYTES.slice(0, 5)]);
});
