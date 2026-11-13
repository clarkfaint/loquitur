/**
 * F§5.4's EPUB parser, run against the fixture book U-005 generated and against synthetic containers
 * built here for the two refusals and for the documents a spine must never read.
 *
 * The fixture is resolved through the `@lectern/fixtures` devDependency, so this test follows the
 * artefact by name. Reading it needs `node:fs`, and linkedom ships declarations this package's
 * type-check program cannot load (U-006 recorded both), so this file stays outside that program:
 * vitest erases types and runs it as written.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { strToU8, zipSync } from "fflate";
import { expect, test } from "vitest";
import { z } from "zod";
import { buildDocument } from "../../builder";
import { DocumentModelSchema } from "../../model";
import { EPUB_MIME, EpubParseError, parseEpub } from "../epub";

const require = createRequire(import.meta.url);

/** The generated book, and the expectations U-005 recorded for it. */
const BOOK = new Uint8Array(readFileSync(require.resolve("@lectern/fixtures/generated/book.epub")));

/** The fields of `expected.json` this test reads; the fixture carries more. */
const ExpectationsSchema = z.object({
  title: z.string(),
  chapterTitles: z.array(z.string()),
  firstSentenceOfChapter: z.array(z.string()),
});

const EXPECTED = ExpectationsSchema.parse(JSON.parse(readFileSync(require.resolve("@lectern/fixtures/generated/expected.json"), "utf8")));

const EPUB_SOURCE = { kind: "epub" } as const;

const XML_HEADER = '<?xml version="1.0" encoding="utf-8"?>';

/** One XHTML document: a whole document, not a fragment, the way a real chapter is written. */
function xhtmlDocument(title: string, body: string): string {
  return `${XML_HEADER}<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body>${body}</body></html>`;
}

/** The OCF container file, naming one package document. */
function containerXml(packagePath: string): string {
  return `${XML_HEADER}<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="${packagePath}" media-type="application/oebps-package+xml"/></rootfiles></container>`;
}

/** One synthetic OPF: its manifest, its spine, and whichever Dublin Core fields are given. */
function packageXml(spec: {
  items: { id?: string; href: string; mediaType?: string; properties?: string }[];
  spine: string[];
  title?: string;
  language?: string;
}): string {
  const metadata = [
    spec.title === undefined ? "" : `<dc:title>${spec.title}</dc:title>`,
    spec.language === undefined ? "" : `<dc:language>${spec.language}</dc:language>`,
  ].join("");
  const manifest = spec.items
    .map((item) => {
      const id = item.id === undefined ? "" : ` id="${item.id}"`;
      const properties = item.properties === undefined ? "" : ` properties="${item.properties}"`;
      return `<item${id} href="${item.href}" media-type="${item.mediaType ?? "application/xhtml+xml"}"${properties}/>`;
    })
    .join("");
  const spine = spec.spine.map((idref) => `<itemref idref="${idref}"/>`).join("");
  return `${XML_HEADER}<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">${metadata}</metadata><manifest>${manifest}</manifest><spine>${spine}</spine></package>`;
}

/** A synthetic EPUB: the `mimetype` entry first and stored, then one entry per part. */
function epubArchive(parts: Record<string, string>): Uint8Array {
  return zipSync({
    mimetype: [strToU8(EPUB_MIME), { level: 0 }],
    ...Object.fromEntries(Object.entries(parts).map(([name, text]) => [name, strToU8(text)])),
  });
}

/** The refusal a parse must make: its class and its code, so a wrong failure cannot pass. */
async function refusalOf(promise: Promise<unknown>): Promise<EpubParseError> {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(EpubParseError);
  if (!(error instanceof EpubParseError)) throw new Error("expected the parse to be refused");
  return error;
}

test("the fixture book yields its package title and its chapters in spine order", async () => {
  const parsed = await parseEpub(BOOK);
  expect(parsed.title).toBe(EXPECTED.title);
  expect(parsed.lang).toBe("en");

  const headings = parsed.rawBlocks.filter((block) => block.kind === "heading");
  expect(headings.map((block) => block.text)).toEqual(EXPECTED.chapterTitles);
  expect(headings.every((block) => block.level === 2)).toBe(true);
});

test("the fixture book builds into a valid model whose chapters open as expected", async () => {
  const parsed = await parseEpub(BOOK);
  const document = buildDocument(parsed.rawBlocks, { source: EPUB_SOURCE, title: parsed.title });
  expect(DocumentModelSchema.safeParse(document).success).toBe(true);
  expect(document.title).toBe(EXPECTED.title);

  const headings = document.blocks.filter((block) => block.kind === "heading");
  const openings = headings.map((heading) => document.blocks[heading.index + 1]?.sentences[0]?.text);
  expect(openings).toEqual(EXPECTED.firstSentenceOfChapter);
});

test("no block carries the fixture's navigation document, which the spine does not name", async () => {
  const parsed = await parseEpub(BOOK);
  const text = parsed.rawBlocks.map((block) => block.text).join("\n");

  // The navigation document repeats the chapter titles as list items and heads them with "Contents".
  expect(text).not.toContain("Contents");
  for (const title of EXPECTED.chapterTitles) expect(text.split(title)).toHaveLength(2);
  // The book's own list is chapter two's three duties, and nothing else.
  expect(parsed.rawBlocks.filter((block) => block.kind === "list-item")).toHaveLength(3);
});

test("a spine that names the navigation and cover documents yields no block from them", async () => {
  const archive = epubArchive({
    "META-INF/container.xml": containerXml("OEBPS/content.opf"),
    "OEBPS/content.opf": packageXml({
      items: [
        { id: "navigation", href: "nav.xhtml", properties: "nav svg" },
        { id: "cover", href: "cover.xhtml" },
        { id: "cover-image", href: "cover.png", mediaType: "image/png", properties: "cover-image" },
        { id: "chapter", href: "chapter.xhtml" },
      ],
      spine: ["navigation", "cover", "cover-image", "chapter"],
      title: "A Synthetic Book",
    }),
    "OEBPS/nav.xhtml": xhtmlDocument(
      "Contents",
      '<nav epub:type="toc"><h1>Contents</h1><ol><li><a href="chapter.xhtml">Chapter One</a></li></ol></nav>',
    ),
    "OEBPS/cover.xhtml": xhtmlDocument("A Synthetic Book", '<div class="cover"><img src="cover.png" alt="A Synthetic Book"/></div>'),
    "OEBPS/chapter.xhtml": xhtmlDocument("Chapter One", "<h2>Chapter One</h2><p>The only prose in this book.</p>"),
  });

  const parsed = await parseEpub(archive);
  expect(parsed.title).toBe("A Synthetic Book");
  expect(parsed.rawBlocks).toEqual([
    { kind: "heading", level: 2, text: "Chapter One" },
    { kind: "paragraph", text: "The only prose in this book." },
  ]);
});

test("a percent-encoded href resolves to its entry, and references that leave the container are skipped", async () => {
  const archive = epubArchive({
    "META-INF/container.xml": containerXml("OEBPS/content.opf"),
    "OEBPS/content.opf": packageXml({
      items: [
        { id: "encoded", href: "one%20two.xhtml" },
        { id: "remote", href: "https://example.test/remote.xhtml" },
        { id: "climbing", href: "../../outside.xhtml" },
        { href: "nameless.xhtml" },
        { id: "image", href: "picture.png", mediaType: "image/png" },
        { id: "chapter", href: "chapter.xhtml" },
      ],
      spine: ["encoded", "remote", "climbing", "not-in-the-manifest", "image", "chapter"],
      title: "Hrefs",
    }),
    "OEBPS/one two.xhtml": xhtmlDocument("One", "<p>The encoded chapter.</p>"),
    "OEBPS/remote.xhtml": xhtmlDocument("Remote", "<p>The remote chapter.</p>"),
    "outside.xhtml": xhtmlDocument("Outside", "<p>The escaping chapter.</p>"),
    "OEBPS/nameless.xhtml": xhtmlDocument("Nameless", "<p>The nameless chapter.</p>"),
    "OEBPS/picture.png": "not really a PNG",
    "OEBPS/chapter.xhtml": xhtmlDocument("Chapter", "<p>The last chapter.</p>"),
  });

  const parsed = await parseEpub(archive);
  expect(parsed.rawBlocks).toEqual([
    { kind: "paragraph", text: "The encoded chapter." },
    { kind: "paragraph", text: "The last chapter." },
  ]);
});

test("a ZIP without META-INF/container.xml fails with INVALID_EPUB", async () => {
  const archive = epubArchive({
    "OEBPS/content.opf": packageXml({ items: [{ id: "chapter", href: "chapter.xhtml" }], spine: ["chapter"] }),
  });
  const error = await refusalOf(parseEpub(archive));
  expect(error.code).toBe("INVALID_EPUB");
  expect(error.message).toContain("META-INF/container.xml");
});

test("a container whose rootfiles name no package the archive holds fails with INVALID_EPUB", async () => {
  const container = `${XML_HEADER}<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile media-type="application/oebps-package+xml"/><rootfile full-path="OEBPS/missing.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
  const archive = epubArchive({
    "META-INF/container.xml": container,
    "OEBPS/content.opf": packageXml({ items: [{ id: "chapter", href: "chapter.xhtml" }], spine: ["chapter"], title: "A Synthetic Book" }),
  });
  const error = await refusalOf(parseEpub(archive));
  expect(error.code).toBe("INVALID_EPUB");
  expect(error.message).toContain("container.xml");
});

test("bytes that are not a ZIP archive fail with INVALID_EPUB", async () => {
  const error = await refusalOf(parseEpub(strToU8("This is a text file, not an EPUB.")));
  expect(error.code).toBe("INVALID_EPUB");
  expect(error.message).toContain("ZIP");
});

test("a spine that names a document the container does not hold fails with INVALID_EPUB", async () => {
  const archive = epubArchive({
    "META-INF/container.xml": containerXml("OEBPS/content.opf"),
    "OEBPS/content.opf": packageXml({ items: [{ id: "chapter", href: "chapter.xhtml" }], spine: ["chapter"], title: "A Synthetic Book" }),
  });
  const error = await refusalOf(parseEpub(archive));
  expect(error.code).toBe("INVALID_EPUB");
  expect(error.message).toContain("OEBPS/chapter.xhtml");
});

test("an encryption.xml that names a spine document fails with DRM_PROTECTED", async () => {
  const encryption = `${XML_HEADER}<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><enc:EncryptedData xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/><enc:CipherData><enc:CipherReference URI="OEBPS/chapter.xhtml"/></enc:CipherData></enc:EncryptedData></encryption>`;
  const archive = epubArchive({
    "META-INF/container.xml": containerXml("OEBPS/content.opf"),
    "META-INF/encryption.xml": encryption,
    "OEBPS/content.opf": packageXml({ items: [{ id: "chapter", href: "chapter.xhtml" }], spine: ["chapter"], title: "A Synthetic Book" }),
    "OEBPS/chapter.xhtml": xhtmlDocument("Chapter One", "<p>A chapter that must never be read.</p>"),
  });
  const error = await refusalOf(parseEpub(archive));
  expect(error.code).toBe("DRM_PROTECTED");
  expect(error.message).toContain("OEBPS/chapter.xhtml");
});

test("an encryption.xml that names only a picture is not a refusal", async () => {
  const encryption = `${XML_HEADER}<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><enc:EncryptedData xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:CipherData><enc:CipherReference URI="OEBPS/picture.png"/></enc:CipherData></enc:EncryptedData></encryption>`;
  const archive = epubArchive({
    "META-INF/container.xml": containerXml("OEBPS/content.opf"),
    "META-INF/encryption.xml": encryption,
    "OEBPS/content.opf": packageXml({
      items: [
        { id: "cover-image", href: "picture.png", mediaType: "image/png", properties: "cover-image" },
        { id: "chapter", href: "chapter.xhtml" },
      ],
      spine: ["chapter"],
      title: "A Synthetic Book",
    }),
    "OEBPS/picture.png": "obfuscated bytes",
    "OEBPS/chapter.xhtml": xhtmlDocument("Chapter One", "<p>Readable prose beside an obfuscated picture.</p>"),
  });
  const parsed = await parseEpub(archive);
  expect(parsed.rawBlocks).toEqual([{ kind: "paragraph", text: "Readable prose beside an obfuscated picture." }]);
});

test("a package with no dc:title falls back to the first document's own title, and declares no language", async () => {
  const archive = epubArchive({
    "META-INF/container.xml": containerXml("OEBPS/content.opf"),
    "OEBPS/content.opf": packageXml({ items: [{ id: "chapter", href: "chapter.xhtml" }], spine: ["chapter"] }),
    "OEBPS/chapter.xhtml": xhtmlDocument("An Untitled Chapter", "<p>Some prose.</p>"),
  });
  const parsed = await parseEpub(archive);
  expect(parsed.title).toBe("An Untitled Chapter");
  expect(parsed.lang).toBeUndefined();
});
