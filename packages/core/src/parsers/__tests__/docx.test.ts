/**
 * F§5.4's DOCX parser, run against the fixture document U-005 generated and against the one input the
 * parser refuses.
 *
 * The fixture is resolved through the `@lectern/fixtures` devDependency, so this test follows the
 * artefact by name. Reading it needs `node:fs`, and mammoth's declarations reference Node's `Buffer`,
 * which this repository does not install, so this file stays outside the package's type-check program:
 * vitest erases types and runs it as written.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { unzipSync, zipSync } from "fflate";
import { expect, test } from "vitest";
import { z } from "zod";
import { buildDocument } from "../../builder";
import { DocumentModelSchema } from "../../model";
import { DOCX_MIME, DocxParseError, parseDocx } from "../docx";

const require = createRequire(import.meta.url);

/** The generated document, and the expectations U-005 recorded for it. */
const DOCX = new Uint8Array(readFileSync(require.resolve("@lectern/fixtures/generated/doc.docx")));

/** The fields of `expected.json` this test reads; the fixture carries more. */
const ExpectationsSchema = z.object({
  title: z.string(),
  chapterTitles: z.array(z.string()),
  firstSentenceOfChapter: z.array(z.string()),
});

const EXPECTED = ExpectationsSchema.parse(JSON.parse(readFileSync(require.resolve("@lectern/fixtures/generated/expected.json"), "utf8")));

/** The two chapters the fixture document carries, in the order its body holds them. */
const DOCUMENT_CHAPTERS = EXPECTED.chapterTitles.slice(0, 2);

/** The kinds the fixture's eleven blocks are mapped to, in document order. */
const FIXTURE_KINDS = [
  "paragraph",
  "heading",
  "paragraph",
  "paragraph",
  "paragraph",
  "heading",
  "paragraph",
  "paragraph",
  "list-item",
  "list-item",
  "list-item",
];

/** The fixture's numbered list, which Word stores as a real numbering reference. */
const FIXTURE_LIST_ITEMS = [
  "Trim the wicks and polish the lens before dusk, because soot on glass costs more light than a weak flame.",
  "Wind the clockwork that turns the lamp, because a rotation that has stopped reads as a light that is not there.",
  "Write the log at midnight and again at dawn, because a night that is not recorded is a night that is not trusted.",
];

/** The first eight bytes of an OLE2 compound file: what a legacy `.doc` opens with. */
const OLE2_HEADER = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00, 0x00, 0x00]);

/** The refusal a parse must make: its class and its code, so a wrong failure cannot pass. */
async function refusalOf(promise: Promise<unknown>): Promise<DocxParseError> {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(DocxParseError);
  if (!(error instanceof DocxParseError)) throw new Error("expected the parse to be refused");
  return error;
}

test("the DOCX MIME type is the OOXML one", () => {
  expect(DOCX_MIME).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
});

test("the fixture document yields its title and both headings with their levels", async () => {
  const parsed = await parseDocx(DOCX);
  expect(parsed.title).toBe(EXPECTED.title);

  const headings = parsed.rawBlocks.filter((block) => block.kind === "heading");
  expect(headings.map((block) => block.text)).toEqual(DOCUMENT_CHAPTERS);
  expect(headings.map((block) => block.level)).toEqual([1, 2]);
});

test("the fixture document's paragraphs and its numbered list are mapped in document order", async () => {
  const parsed = await parseDocx(DOCX);
  expect(parsed.rawBlocks.map((block) => block.kind)).toEqual(FIXTURE_KINDS);

  // The document's Title-styled paragraph is body markup to mammoth, so it is read as prose too.
  const paragraphs = parsed.rawBlocks.filter((block) => block.kind === "paragraph");
  expect(paragraphs).toHaveLength(6);
  expect(paragraphs[0]?.text).toBe(EXPECTED.title);

  const listItems = parsed.rawBlocks.filter((block) => block.kind === "list-item");
  expect(listItems.map((block) => block.text)).toEqual(FIXTURE_LIST_ITEMS);
});

test("the fixture document builds into a valid model whose chapters open as expected", async () => {
  const parsed = await parseDocx(DOCX);
  const document = buildDocument(parsed.rawBlocks, { source: { kind: "docx" }, title: parsed.title });
  expect(DocumentModelSchema.safeParse(document).success).toBe(true);
  expect(document.title).toBe(EXPECTED.title);

  const headings = document.blocks.filter((block) => block.kind === "heading");
  const openings = headings.map((heading) => document.blocks[heading.index + 1]?.sentences[0]?.text);
  expect(openings).toEqual(EXPECTED.firstSentenceOfChapter.slice(0, 2));
});

test("a legacy .doc header is refused with UNSUPPORTED_FORMAT", async () => {
  const error = await refusalOf(parseDocx(OLE2_HEADER));
  expect(error.code).toBe("UNSUPPORTED_FORMAT");
  expect(error.message).toContain(".doc");
});

test("a package with no core properties still maps, and declares no title", async () => {
  const entries = unzipSync(DOCX);
  expect(entries["docProps/core.xml"]).toBeDefined();
  const withoutProperties = Object.fromEntries(Object.entries(entries).filter(([name]) => name !== "docProps/core.xml"));

  const parsed = await parseDocx(zipSync(withoutProperties));
  expect(parsed.title).toBe("");
  expect(parsed.rawBlocks.map((block) => block.kind)).toEqual(FIXTURE_KINDS);
});
