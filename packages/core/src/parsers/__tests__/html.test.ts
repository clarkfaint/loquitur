/**
 * F§5.4's HTML parser, run against the fixture article U-005 generated.
 *
 * The fixtures are resolved through the `@lectern/fixtures` devDependency, so this test follows the
 * artefacts by name. Reading them needs `node:fs`, and linkedom ships declarations this package's
 * type-check program cannot load (U-006's evidence file records both), so this file is outside that
 * program: vitest erases types and runs it as written.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { DOMParser } from "linkedom";
import { expect, test } from "vitest";
import { z } from "zod";
import type { RawBlock } from "../../builder";
import { buildDocument } from "../../builder";
import { DocumentModelSchema } from "../../model";
import { parseHtml } from "../html";
import { mapElementToRawBlocks } from "../html-map";

const require = createRequire(import.meta.url);

/** The generated article, and the expectations U-005 recorded for it. */
const ARTICLE = readFileSync(require.resolve("@lectern/fixtures/generated/article.html"), "utf8");

/** The fields of `expected.json` this test reads; the fixture carries more. */
const ExpectationsSchema = z.object({
  title: z.string(),
  chapterTitles: z.array(z.string()),
  firstSentenceOfChapter: z.array(z.string()),
});

const EXPECTED = ExpectationsSchema.parse(JSON.parse(readFileSync(require.resolve("@lectern/fixtures/generated/expected.json"), "utf8")));

const HTML_SOURCE = { kind: "html" } as const;

/** A page with no article in it: Readability refuses it, so the body is mapped instead. */
const PLAIN_PAGE =
  "<!doctype html><html><head><title>Short page</title></head>" +
  "<body><div>Only a little prose.</div><div>And a second thought.</div></body></html>";

/** One linkedom element as the DOM interface the walker declares. */
function bodyElement(html: string): Element {
  const document = new DOMParser().parseFromString(html, "text/html") as unknown as Document;
  return document.body;
}

test("the fixture article yields its title and chapter headings", () => {
  const parsed = parseHtml(ARTICLE);
  expect(parsed.title).toBe(EXPECTED.title);
  expect(parsed.lang).toBe("en");

  const headings = parsed.rawBlocks.filter((block) => block.kind === "heading");
  expect(headings.map((block) => block.text)).toEqual(EXPECTED.chapterTitles);
  expect(headings.every((block) => block.level === 2)).toBe(true);
});

test("the fixture article builds into a valid model whose chapters open as expected", () => {
  const parsed = parseHtml(ARTICLE);
  const document = buildDocument(parsed.rawBlocks, { source: HTML_SOURCE, title: parsed.title });
  expect(DocumentModelSchema.safeParse(document).success).toBe(true);
  expect(document.title).toBe(EXPECTED.title);

  const headings = document.blocks.filter((block) => block.kind === "heading");
  const openings = headings.map((heading) => document.blocks[heading.index + 1]?.sentences[0]?.text);
  expect(openings).toEqual(EXPECTED.firstSentenceOfChapter);
});

test("the fixture article keeps the list items and the quote of the second chapter", () => {
  const parsed = parseHtml(ARTICLE);
  expect(parsed.rawBlocks.filter((block) => block.kind === "list-item")).toHaveLength(3);
  expect(parsed.rawBlocks.filter((block) => block.kind === "quote")).toHaveLength(1);
});

test("no block carries text from the page's navigation, aside or footer", () => {
  const text = parseHtml(ARTICLE)
    .rawBlocks.map((block) => block.text)
    .join("\n");

  // The navigation repeats the chapter titles, so a mapped navigation would read each one twice.
  for (const title of EXPECTED.chapterTitles) expect(text.split(title)).toHaveLength(2);
  expect(text).not.toContain("Fixture notes");
  expect(text).not.toContain("Original prose written for the Lectern parser tests.");
  expect(text).not.toContain("Lectern fixtures");
});

test("a document with no article structure falls back to its body", () => {
  const parsed = parseHtml(PLAIN_PAGE);
  expect(parsed.rawBlocks).toEqual([
    { kind: "paragraph", text: "Only a little prose." },
    { kind: "paragraph", text: "And a second thought." },
  ]);
  expect(parsed.title).toBe("Short page");
  expect(parsed.lang).toBeUndefined();
});

test("script and style content never reaches a block", () => {
  const page =
    "<!doctype html><html><head><title>Short page</title></head><body>" +
    '<script>const leak = "script-leak";</script>' +
    "<style>.leak { color: style-leak; }</style>" +
    "<p>Readable prose.</p></body></html>";
  const text = parseHtml(page)
    .rawBlocks.map((block) => block.text)
    .join("\n");

  expect(text).toContain("Readable prose.");
  expect(text).not.toContain("script-leak");
  expect(text).not.toContain("style-leak");
});

test("the url option gives the document a base and leaves the blocks alone", () => {
  const plain = parseHtml(PLAIN_PAGE);
  expect(parseHtml(PLAIN_PAGE, { url: "https://example.test/notes/" }).rawBlocks).toEqual(plain.rawBlocks);
  expect(parseHtml(PLAIN_PAGE, { url: "not a url" }).rawBlocks).toEqual(plain.rawBlocks);
});

test("every tag F§5.4 names becomes one block of its own kind", () => {
  const blocks = mapElementToRawBlocks(
    bodyElement(
      "<html><body>" +
        "<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6>" +
        "<p>Paragraph.</p><ul><li>Item one.</li><li>Item two.</li></ul>" +
        "<blockquote>Quoted.</blockquote><figure><figcaption>A caption.</figcaption></figure>" +
        "</body></html>",
    ),
  );

  expect(blocks).toEqual([
    { kind: "heading", level: 1, text: "One" },
    { kind: "heading", level: 2, text: "Two" },
    { kind: "heading", level: 3, text: "Three" },
    { kind: "heading", level: 4, text: "Four" },
    { kind: "heading", level: 5, text: "Five" },
    { kind: "heading", level: 6, text: "Six" },
    { kind: "paragraph", text: "Paragraph." },
    { kind: "list-item", text: "Item one." },
    { kind: "list-item", text: "Item two." },
    { kind: "quote", text: "Quoted." },
    { kind: "caption", text: "A caption." },
  ] satisfies RawBlock[]);
});

test("loose text in a container is a paragraph, and inline text joins the block around it", () => {
  const blocks = mapElementToRawBlocks(
    bodyElement(
      "<html><body><div>Loose <em>prose</em> in a container.<br>Its second line.</div>" +
        "<section><p>Wrapped <strong>words</strong> stay in one block.</p></section></body></html>",
    ),
  );

  expect(blocks).toEqual([
    { kind: "paragraph", text: "Loose prose in a container. Its second line." },
    { kind: "paragraph", text: "Wrapped words stay in one block." },
  ]);
});
