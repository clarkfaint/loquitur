/**
 * F§5.4's dispatcher, run against every fixture U-005 generated: each artefact has to be identified
 * from its own bytes and read by the parser that owns its format, whatever the caller claims about
 * it, and every refusal has to arrive as a `ParseError` carrying one of the five codes.
 *
 * The fixtures are resolved through the `@lectern/fixtures` devDependency, so this test follows the
 * artefacts by name. Reading them needs `node:fs`, which has no declarations on this host, so this
 * file stays outside the package's type-check program (its test directories are excluded): vitest
 * erases types instead of checking them and runs it as written.
 *
 * Two engines appear. The image and the scanned PDF are read with the hub's real engine, because
 * whether a scan yields text at all is a property of that engine; the engine's answer is asserted
 * loosely there (the page's own heading comes back as the title) and exactly in the test that
 * supplies a stub engine, which is what proves the wiring without depending on OCR accuracy.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { strToU8, zipSync } from "fflate";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import type { DocumentModel, SourceKind } from "../../model";
import { DocumentModelSchema } from "../../model";
import type { OcrEngine } from "../../ocr";
import { ParseError, parseDocument, sniffFormat } from "../dispatch";
import { createTesseractOcrEngine } from "../ocr-tesseract";

const require = createRequire(import.meta.url);

/** Every artefact U-005 generates for the parsers, by the name it is committed under. */
const FIXTURE_NAMES = ["sample.txt", "sample.md", "article.html", "text.pdf", "page.png", "scanned.pdf", "book.epub", "doc.docx"] as const;

type FixtureName = (typeof FIXTURE_NAMES)[number];

/** The fixtures' bytes, read once for the whole file. */
const FIXTURES: Readonly<Record<FixtureName, Uint8Array>> = Object.fromEntries(
  FIXTURE_NAMES.map((name) => [name, new Uint8Array(readFileSync(require.resolve(`@lectern/fixtures/generated/${name}`)))]),
) as Record<FixtureName, Uint8Array>;

/** The fields of `expected.json` this test reads; the fixture carries more. */
const ExpectationsSchema = z.object({ title: z.string() });

const EXPECTED = ExpectationsSchema.parse(JSON.parse(readFileSync(require.resolve("@lectern/fixtures/generated/expected.json"), "utf8")));

/** F§5.5's declaration test allows one engine 120 s; reading three pages takes a small part of it. */
const TIMEOUT_MS = 120_000;

/** The hub's engine, created once for this file: its worker is loaded on the first call and reused. */
const engine = createTesseractOcrEngine();

afterAll(async () => {
  await engine.dispose();
});

/**
 * The bytes of a file that is not UTF-8 at all: `c3 28` is a two-byte lead with a byte that is not a
 * continuation, and `81` is a continuation byte in the lead position. A strict decode refuses both.
 */
const NOT_UTF8 = new Uint8Array([0xc3, 0x28, 0x81, 0xff, 0x00, 0x80]);

/** The first eight bytes of an OLE2 compound file: what a legacy `.doc` opens with. */
const OLE2_HEADER = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00, 0x00, 0x00]);

/** UTF-8 text, as the caller of an upload would hold it. */
function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** A stub engine: one line, one box, full confidence. Its answer is fixed, so the title is too. */
const STUB_LINE_TEXT = "A page read by an engine that was handed to the dispatcher.";

const STUB_ENGINE: OcrEngine = {
  id: "stub",
  recognize: () =>
    Promise.resolve({ lines: [{ text: STUB_LINE_TEXT, bbox: [10, 20, 400, 60] as [number, number, number, number], confidence: 92 }] }),
};

/** The refusal a parse must make: its class and its code, so a wrong failure cannot pass. */
async function refusalOf(promise: Promise<unknown>): Promise<ParseError> {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ParseError);
  if (!(error instanceof ParseError)) throw new Error("expected the input to be refused");
  return error;
}

/** What every fixture is expected to parse into, without any hint from the caller. */
interface FixtureCase {
  name: FixtureName;
  kind: SourceKind;
  /** A hint that contradicts the bytes: a name (and sometimes a type) that is not the true one. */
  wrongHint: { filename?: string; mime?: string };
}

const FIXTURE_CASES: readonly FixtureCase[] = [
  { name: "sample.txt", kind: "txt", wrongHint: { filename: "sample.md" } },
  { name: "sample.md", kind: "txt", wrongHint: { filename: "sample.pdf", mime: "text/markdown" } },
  { name: "article.html", kind: "html", wrongHint: { filename: "article.txt", mime: "text/plain" } },
  { name: "text.pdf", kind: "pdf", wrongHint: { filename: "text.txt", mime: "text/plain" } },
  { name: "page.png", kind: "ocr", wrongHint: { filename: "page.pdf", mime: "application/pdf" } },
  { name: "scanned.pdf", kind: "pdf", wrongHint: { filename: "scanned.docx" } },
  { name: "book.epub", kind: "epub", wrongHint: { filename: "book.docx" } },
  { name: "doc.docx", kind: "docx", wrongHint: { filename: "doc.epub" } },
];

test(
  "the bytes decide the format: every fixture parses with no hint",
  async () => {
    for (const fixture of FIXTURE_CASES) {
      const parsed = await parseDocument({ bytes: FIXTURES[fixture.name] }, { ocr: engine });
      expect(DocumentModelSchema.safeParse(parsed.document).success).toBe(true);
      expect(parsed.document.source.kind).toBe(fixture.kind);
      expect(parsed.document.blocks.length).toBeGreaterThan(0);
      expect(parsed.document.title).not.toBe("");
    }
  },
  TIMEOUT_MS,
);

test(
  "a wrong name or a wrong declared type does not change what the bytes are",
  async () => {
    for (const fixture of FIXTURE_CASES) {
      const without = await parseDocument({ bytes: FIXTURES[fixture.name] }, { ocr: engine });
      const wrong = await parseDocument({ bytes: FIXTURES[fixture.name], ...fixture.wrongHint }, { ocr: engine });
      expect(wrong.document.source.kind).toBe(without.document.source.kind);
      expect(wrong.document.docId).toBe(without.document.docId);
      expect(wrong.document.title).toBe(without.document.title);
    }
  },
  TIMEOUT_MS,
);

test(
  "each fixture's title is the one its own text declares",
  async () => {
    const titles: Record<string, string> = {};
    const firstBlocks: Record<string, string> = {};
    for (const fixture of FIXTURE_CASES) {
      const parsed = await parseDocument({ bytes: FIXTURES[fixture.name] }, { ocr: engine });
      titles[fixture.name] = parsed.document.title;
      firstBlocks[fixture.name] = parsed.document.blocks[0]?.text ?? "";
    }

    for (const name of ["sample.txt", "sample.md", "article.html", "text.pdf", "book.epub", "doc.docx"] as const) {
      expect(titles[name]).toBe(EXPECTED.title);
    }
    // A scan declares no title of its own and its OCR'd blocks are paragraphs, so F§5.1's fallback
    // names it after its first line, cut to 60 characters. The image's own heading is what the engine
    // reads back first, so the title it produces opens with the document's title.
    expect(titles["page.png"]?.startsWith(EXPECTED.title)).toBe(true);
    expect(titles["scanned.pdf"]).toBe((firstBlocks["scanned.pdf"] ?? "").slice(0, 60));
    expect(titles["scanned.pdf"]).toHaveLength(60);
  },
  TIMEOUT_MS,
);

test("the two renderings of one document read back as the same document", async () => {
  const plain = await parseDocument({ bytes: FIXTURES["sample.txt"] });
  const markdown = await parseDocument({ bytes: FIXTURES["sample.md"] });
  expect(plain.document.docId).toBe(markdown.document.docId);
  expect(plain.document.wordCount).toBe(markdown.document.wordCount);
  expect(plain.document.blocks.map((block) => block.kind)).toEqual(markdown.document.blocks.map((block) => block.kind));
});

test("text.pdf carries anchors and book.epub does not", async () => {
  const pdf = await parseDocument({ bytes: FIXTURES["text.pdf"] });
  expect(pdf.document.source.pageCount).toBe(5);
  expect(pdf.anchors).toBeDefined();
  expect(pdf.anchors?.length).toBe(pdf.document.wordCount);

  const epub = await parseDocument({ bytes: FIXTURES["book.epub"] });
  expect(epub.anchors).toBeUndefined();
  expect(epub.document.source.pageCount).toBeUndefined();
});

test("an image is read through the engine it was handed, and its first line names the document", async () => {
  const parsed = await parseDocument({ bytes: FIXTURES["page.png"] }, { ocr: STUB_ENGINE });
  expect(parsed.document.source.kind).toBe("ocr");
  expect(parsed.document.source.mime).toBe("image/png");
  expect(parsed.document.title).toBe(STUB_LINE_TEXT);
  expect(parsed.document.blocks.map((block) => block.text)).toEqual([STUB_LINE_TEXT]);
  expect(parsed.anchors).toBeUndefined();
});

test("an image with no engine is refused rather than read as something else", async () => {
  const error = await refusalOf(parseDocument({ bytes: FIXTURES["page.png"] }));
  expect(error.code).toBe("PARSE_FAILED");
  expect(error.message).toContain("OCR engine");
});

test("a scanned PDF with no engine carries no text, and is refused as empty", async () => {
  const error = await refusalOf(parseDocument({ bytes: FIXTURES["scanned.pdf"] }));
  expect(error.code).toBe("EMPTY_DOCUMENT");
});

test(
  "a scanned PDF with an engine is read as a PDF whose pages carry no anchors",
  async () => {
    const parsed = await parseDocument({ bytes: FIXTURES["scanned.pdf"] }, { ocr: engine });
    expect(parsed.document.source.kind).toBe("pdf");
    expect(parsed.document.source.pageCount).toBe(2);
    expect(parsed.anchors).toEqual([]);
  },
  TIMEOUT_MS,
);

test("markup that came from an address is a url, and records the address", async () => {
  const url = "https://example.test/notes";
  const parsed = await parseDocument({ bytes: FIXTURES["article.html"], url });
  expect(parsed.document.source.kind).toBe("url");
  expect(parsed.document.source.uri).toBe(url);

  const fromFile = await parseDocument({ bytes: FIXTURES["article.html"] });
  expect(fromFile.document.source.kind).toBe("html");
  expect(fromFile.document.source.uri).toBeUndefined();
});

test("bytes that are neither a format Loquitur reads nor UTF-8 text are UNSUPPORTED_FORMAT", async () => {
  const error = await refusalOf(parseDocument({ bytes: NOT_UTF8 }));
  expect(error.code).toBe("UNSUPPORTED_FORMAT");
});

test("an empty text file is EMPTY_DOCUMENT, and so is one that is only whitespace", async () => {
  const empty = await refusalOf(parseDocument({ bytes: new Uint8Array(0), filename: "empty.txt" }));
  expect(empty.code).toBe("EMPTY_DOCUMENT");

  const blank = await refusalOf(parseDocument({ bytes: utf8("   \n\n\t\n"), filename: "blank.txt" }));
  expect(blank.code).toBe("EMPTY_DOCUMENT");
});

test("a ZIP that is neither container is not identified", async () => {
  const archive = zipSync({ "a.txt": strToU8("nothing to read here") });
  expect(sniffFormat(archive)).toBeNull();
  const error = await refusalOf(parseDocument({ bytes: archive }));
  expect(error.code).toBe("UNSUPPORTED_FORMAT");
});

test("a broken container keeps the parser's own code: INVALID_EPUB, or UNSUPPORTED_FORMAT for a legacy .doc", async () => {
  const epub = zipSync({ mimetype: strToU8("application/epub+zip") });
  expect(sniffFormat(epub)).toBe("epub");
  const invalid = await refusalOf(parseDocument({ bytes: epub }));
  expect(invalid.code).toBe("INVALID_EPUB");
  expect(invalid.message).toContain("META-INF/container.xml");

  const legacy = await refusalOf(parseDocument({ bytes: OLE2_HEADER, filename: "legacy.docx" }));
  expect(legacy.code).toBe("UNSUPPORTED_FORMAT");
  expect(legacy.message).toContain(".doc");
});

test("a PDF whose bytes are not a PDF is PARSE_FAILED, with the library's own message kept", async () => {
  const error = await refusalOf(parseDocument({ bytes: utf8("%PDF-1.7\nthis is not a PDF at all") }));
  expect(error.code).toBe("PARSE_FAILED");
  expect(error.message.length).toBeGreaterThan(0);
});

test("sniffFormat names each format from its signature alone", () => {
  expect(sniffFormat(FIXTURES["text.pdf"])).toBe("pdf");
  expect(sniffFormat(FIXTURES["book.epub"])).toBe("epub");
  expect(sniffFormat(FIXTURES["doc.docx"])).toBe("docx");
  expect(sniffFormat(FIXTURES["page.png"])).toBe("image");
  expect(sniffFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBe("image");
  expect(sniffFormat(utf8("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "))).toBe("image");
  expect(sniffFormat(FIXTURES["article.html"])).toBe("html");
  expect(sniffFormat(utf8('\n  <!DOCTYPE HTML>\n<html lang="en">'))).toBe("html");
  expect(sniffFormat(utf8("<html><body>prose</body></html>"))).toBe("html");
});

test("sniffFormat falls back to the declared type, then the extension, then text", () => {
  const text = utf8("Nothing but prose here.");
  expect(sniffFormat(text)).toBe("txt");
  expect(sniffFormat(text, { filename: "notes.md" })).toBe("txt");
  expect(sniffFormat(text, { filename: "notes.PDF", mime: "text/plain; charset=utf-8" })).toBe("txt");
  expect(sniffFormat(text, { mime: "text/html" })).toBe("html");
  expect(sniffFormat(text, { filename: "notes.html" })).toBe("html");
  expect(sniffFormat(NOT_UTF8)).toBeNull();
});

test("a declared type the bytes contradict is not trusted", () => {
  const wrongHint = { filename: "text.txt", mime: "text/plain" };
  expect(sniffFormat(FIXTURES["text.pdf"], wrongHint)).toBe("pdf");
  expect(sniffFormat(FIXTURES["page.png"], { filename: "page.epub", mime: "application/epub+zip" })).toBe("image");
});

test("the model keeps the format's own MIME type, not the one the caller declared", async () => {
  const pdf = await parseDocument({ bytes: FIXTURES["text.pdf"], filename: "text.txt", mime: "text/plain" });
  expect(pdf.document.source.mime).toBe("application/pdf");
  expect(pdf.document.source.kind).toBe("pdf");
});

test("the input's bytes are left exactly as they were", async () => {
  const bytes = new Uint8Array(FIXTURES["text.pdf"]);
  const before = [...bytes];
  const parsed = await parseDocument({ bytes });
  expect([...bytes]).toEqual(before);

  const document: DocumentModel = parsed.document;
  expect(document.source.mime).toBe("application/pdf");
});
