/**
 * The hub's OCR engine and F§5.5's two consumers — an image, and a PDF page whose text layer is empty
 * — against the fixtures U-005 generated.
 *
 * The fixtures are resolved through the `@lectern/fixtures` devDependency, so this test follows the
 * artefacts by name. Reading them needs `node:fs`, which has no declarations on this host, so this
 * file is outside the package's type-check program (its `__tests__` directories are excluded): vitest
 * erases types instead of checking them and runs it as written. The engine is real — tesseract.js
 * reading the installed `@tesseract.js-data/eng` — because the numbers this test asserts (how much of
 * the page's text is read back, and that a scan produces text at all) are properties of the engine.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import type { OcrEngine } from "../../ocr";
import { OCR_LANG } from "../../ocr";
import { parseImage } from "../image";
import { createTesseractOcrEngine } from "../ocr-tesseract";
import { parsePdf } from "../pdf";

const require = createRequire(import.meta.url);

/** The three fixtures this test reads, by their generated names. */
const PAGE_PNG = new Uint8Array(readFileSync(require.resolve("@lectern/fixtures/generated/page.png")));
const SCANNED_PDF = new Uint8Array(readFileSync(require.resolve("@lectern/fixtures/generated/scanned.pdf")));

/** The fields of `expected.json` this test reads; the fixture carries more. */
const ExpectationsSchema = z.object({
  chapterTitles: z.array(z.string()),
  pageImageWords: z.array(z.string()),
});

const EXPECTED = ExpectationsSchema.parse(JSON.parse(readFileSync(require.resolve("@lectern/fixtures/generated/expected.json"), "utf8")));

/** F§5.5's declaration test allows one engine 120 s; reading two pages takes a small part of it. */
const TIMEOUT_MS = 120_000;

/** The hub's engine, created once for this file: its worker is loaded on the first call and reused. */
const engine = createTesseractOcrEngine();

afterAll(async () => {
  await engine.dispose();
});

/** The words a text is made of, as the contract counts them: case-folded, letters and digits only. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
}

/** The share of `expected` a reading accounts for, each expected word matched at most once. */
function share(read: readonly string[], expected: readonly string[]): number {
  const pool = [...read];
  let matched = 0;
  for (const word of expected) {
    const at = pool.indexOf(word);
    if (at === -1) continue;
    matched += 1;
    pool.splice(at, 1);
  }
  return expected.length === 0 ? 0 : matched / expected.length;
}

/** A text with its case, its whitespace and its apostrophes evened out, for a content check. */
function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/\s+/gu, " ")
    .trim();
}

test("the engine reports F§5.5's id, and a caller-supplied engine is the one an image is read with", async () => {
  expect(engine.id).toBe("tesseract");
  const asked: { lang: string; bytes: number }[] = [];
  const stub: OcrEngine = {
    id: "stub",
    recognize(image, opts) {
      asked.push({ lang: opts.lang, bytes: image.length });
      return Promise.resolve({
        lines: [{ text: "a stub line long enough to be cut at sixty characters for a title", bbox: [10, 10, 400, 30], confidence: 99 }],
      });
    },
  };
  const parsed = await parseImage(new Uint8Array([1, 2, 3]), stub);
  expect(asked).toEqual([{ lang: OCR_LANG, bytes: 3 }]);
  expect(parsed.rawBlocks.map((block) => block.kind)).toEqual(["paragraph"]);
  expect(parsed.title).toHaveLength(60);
  expect(parsed.title.startsWith("a stub line long enough")).toBe(true);
});

test("reads at least 90% of page.png's words", { timeout: TIMEOUT_MS }, async () => {
  const parsed = await parseImage(PAGE_PNG, engine);
  const read = parsed.rawBlocks.flatMap((block) => words(block.text));
  expect(read.length).toBeGreaterThan(0);
  const matched = share(read, EXPECTED.pageImageWords.flatMap(words));
  expect(matched).toBeGreaterThanOrEqual(0.9);
  expect(parsed.rawBlocks.every((block) => block.kind === "paragraph")).toBe(true);
  // The title is the first block's text, cut the way F§5.1's own fallback cuts it.
  expect(parsed.title).toBe(parsed.rawBlocks[0]?.text.slice(0, 60));
  expect(fold(parsed.title).startsWith("lighthouse notes")).toBe(true);
});

test("both pages of scanned.pdf yield text and no anchors", { timeout: TIMEOUT_MS }, async () => {
  const parsed = await parsePdf(SCANNED_PDF, { ocr: engine });
  expect(parsed.pageCount).toBe(2);

  const pages = [...new Set(parsed.rawBlocks.map((block) => block.page))].sort((left, right) => (left ?? 0) - (right ?? 0));
  expect(pages).toEqual([1, 2]);

  const textOf = (page: number): string =>
    parsed.rawBlocks
      .filter((block) => block.page === page)
      .map((block) => block.text)
      .join(" ");

  for (const page of [1, 2]) {
    expect(words(textOf(page)).length).toBeGreaterThan(20);
    expect(fold(textOf(page))).toContain(fold(EXPECTED.chapterTitles[page - 1] ?? ""));
  }

  // F§5.5: an OCR'd page carries no anchor, because a scan has no text item to point one at.
  expect(parsed.wordAnchors).toHaveLength(0);
});

test("without an engine, scanned.pdf yields zero blocks and no error", { timeout: TIMEOUT_MS }, async () => {
  const parsed = await parsePdf(SCANNED_PDF);
  expect(parsed.pageCount).toBe(2);
  expect(parsed.rawBlocks).toEqual([]);
  expect(parsed.wordAnchors).toEqual([]);
});
