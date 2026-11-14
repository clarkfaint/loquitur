/**
 * The text map's own tests (F§10.2).
 *
 * They run against jsdom, on fixtures written for this file. Four things are pinned: the regions a page
 * gives up (the article's text and not its chrome, nothing the page hides); that reading starts at the
 * article root and falls back to the body; that `rangeFor` is exact for **every word of every sentence**,
 * across nested inline elements, a line break and runs of whitespace; and that the live document comes out
 * of the extraction byte-identical, with no element added, wrapped or re-tagged on the page itself.
 */

import { DocumentModelSchema, normalizeText } from "@lectern/core";
import { describe, expect, it } from "vitest";
import { CLONE_INDEX_ATTRIBUTE, findArticleRoot } from "../article-root";
import { extractPageDocument, extractSelectionDocument } from "../page-document";
import { buildTextMap } from "../text-map";
import { isReadableElement, type ReadableEnv } from "../visibility";

/** What the tests can measure: jsdom parses and styles, but lays nothing out. */
const NO_LAYOUT: ReadableEnv = { hasLayout: false };

/** Two paragraphs of ordinary prose, long enough that Readability scores them as an article. */
const PARAGRAPH_ONE =
  "A reader that speaks a page has to decide what the page is about before it can decide what to say. " +
  "Most pages are mostly furniture: a masthead, a menu, and a sidebar of links that lead somewhere else. " +
  "None of that is prose, and reading it aloud is worse than reading nothing at all, because a listener " +
  "cannot skim past a menu the way an eye can.";
const PARAGRAPH_TWO =
  "The words that matter are usually in one place, and Readability is the tool that finds it. It scores " +
  "the candidates, rejects the ones that look like navigation, and hands back the article, or nothing at " +
  "all when the page resists. When it hands back nothing, the fallback is the body of the document, " +
  "because a page with no article structure is still a page with text.";

/** Replace the page's own markup with a fixture, so each test reads the document it wrote. */
function fixture(html: string): Document {
  document.head.innerHTML = "";
  document.body.innerHTML = html;
  return document;
}

/** The one element a selector names, so a fixture that lost it fails loudly instead of silently. */
function element(doc: Document, selector: string): Element {
  const found = doc.querySelector(selector);
  if (found === null) throw new Error(`the fixture has no ${selector}`);
  return found;
}

/** The text of a map's blocks, one block per line. */
function textOf(doc: Document): string {
  return buildTextMap(doc.body, NO_LAYOUT)
    .blocks.map((block) => block.text)
    .join("\n");
}

describe("the regions a page gives up", () => {
  it("reads the article's text and not the page's chrome", () => {
    const doc = fixture(`
      <nav><ul><li>Home</li><li>Archive</li></ul></nav>
      <article>
        <h1>Reading a Page Aloud</h1>
        <p>${PARAGRAPH_ONE}</p>
        <p>${PARAGRAPH_TWO}</p>
      </article>
      <aside><p>Elsewhere on this site</p></aside>
      <footer><p>Copyright of nobody</p></footer>
    `);

    const { document: model } = extractPageDocument(doc, NO_LAYOUT);
    const text = model.blocks.map((block) => block.text).join("\n");

    expect(text).toContain(PARAGRAPH_ONE);
    expect(text).toContain(PARAGRAPH_TWO);
    expect(text).not.toContain("Archive");
    expect(text).not.toContain("Elsewhere on this site");
    expect(text).not.toContain("Copyright of nobody");
    expect(model.title).toBe("Reading a Page Aloud");
    expect(model.source.kind).toBe("html");
    expect(DocumentModelSchema.safeParse(model).success).toBe(true);
  });

  it("carries the page's own address and title", () => {
    const doc = fixture(`<article><p>${PARAGRAPH_ONE}</p></article>`);
    document.head.innerHTML = "<title>A probe page</title>";

    const { document: model } = extractPageDocument(doc, NO_LAYOUT);

    expect(model.source.uri).toBe(location.href);
    expect(model.title).toBe("A probe page");
  });

  it("leaves out what the page hides", () => {
    const doc = fixture(`
      <article>
        <h1>Partly hidden</h1>
        <p>Visible prose that the reader should hear.</p>
        <p hidden>Hidden sentence.</p>
        <p aria-hidden="true">Aria hidden sentence.</p>
        <p>More visible prose to read here.</p>
      </article>
    `);

    const text = textOf(doc);

    expect(text).toContain("Visible prose that the reader should hear.");
    expect(text).toContain("More visible prose to read here.");
    expect(text).not.toContain("Hidden sentence.");
    expect(text).not.toContain("Aria hidden sentence.");
  });

  it("applies F§10.2's exclusion list element by element", () => {
    const doc = fixture(`
      <nav>menu</nav><aside>side</aside><footer>foot</footer>
      <script>ignore()</script><style>p { color: red }</style>
      <noscript>none</noscript><template>tpl</template>
      <header role="banner">banner</header><header>article header</header>
      <p hidden>hidden</p><p aria-hidden="true">aria</p>
      <input value="field"><textarea>area</textarea>
      <div contenteditable="true">editable</div><p contenteditable="false">not editable</p>
      <p id="kept">read me</p>
    `);

    const excluded = [
      "nav",
      "aside",
      "footer",
      "script",
      "style",
      "noscript",
      "template",
      "header[role=banner]",
      "p[hidden]",
      "p[aria-hidden]",
      "input",
      "textarea",
      "div[contenteditable]",
    ];
    for (const selector of excluded) {
      expect(isReadableElement(element(doc, selector), NO_LAYOUT), selector).toBe(false);
    }
    expect(isReadableElement(element(doc, "#kept"), NO_LAYOUT)).toBe(true);
    expect(isReadableElement(element(doc, "header:not([role])"), NO_LAYOUT)).toBe(true);
    expect(isReadableElement(element(doc, "p[contenteditable=false]"), NO_LAYOUT)).toBe(true);
  });
});

describe("where reading starts", () => {
  it("starts at the element the article's own text sits in", () => {
    const doc = fixture(`
      <nav><ul><li>Home</li></ul></nav>
      <article><h1>Root</h1><p>${PARAGRAPH_ONE}</p></article>
      <footer><p>Foot</p></footer>
    `);

    const root = findArticleRoot(doc);
    expect(root.textContent ?? "").toContain(PARAGRAPH_ONE);
    expect(root.textContent ?? "").toContain("Root");

    const text = buildTextMap(root, NO_LAYOUT)
      .blocks.map((block) => block.text)
      .join("\n");
    expect(text).not.toContain("Home");
    expect(text).not.toContain("Foot");
  });

  it("falls back to the body when the page has no article structure", () => {
    const doc = fixture("Loose words with no structure at all.");

    expect(findArticleRoot(doc)).toBe(doc.body);
  });
});

describe("the offset mapping", () => {
  it("resolves every word of every sentence to a range holding exactly that word", () => {
    const doc = fixture(`
      <article>
        <h1>Word bounds</h1>
        <p>The <em>quick</em> brown <b>fox</b> jumps    over the <span>lazy</span> dog. It sleeps.</p>
        <p>Line one<br>line two.</p>
        <p>Spaced     out\twords  and a dash — right.</p>
      </article>
    `);

    const { document: model, textMap } = extractPageDocument(doc, NO_LAYOUT);
    let checked = 0;

    for (const block of model.blocks) {
      for (const sentence of block.sentences) {
        for (const word of sentence.words) {
          const charStart = sentence.charStart + word.charStart;
          const charEnd = sentence.charStart + word.charEnd;
          const range = textMap.rangeFor(block.index, charStart, charEnd);
          expect(range === null ? null : range.toString(), `${block.index}:${charStart}-${charEnd} ${word.text}`).toBe(word.text);
          checked += 1;
        }
      }
    }

    expect(checked).toBeGreaterThan(20);
  });

  it("records the text node behind each block's own text", () => {
    const doc = fixture("<article><p>Hello world.</p></article>");

    const map = buildTextMap(doc.body, NO_LAYOUT);

    expect(map.blocks.map((block) => block.text)).toEqual(["Hello world."]);
    expect(map.entries.length).toBe(1);
    const entry = map.entries[0];
    expect(entry?.node.data).toBe("Hello world.");
    expect(entry?.blockIndex).toBe(0);
    expect(entry?.start).toBe(0);
    expect(entry?.end).toBe(12);
    for (const block of map.blocks) expect(normalizeText(block.text)).toBe(block.text);
  });

  it("answers null for a block or a span the map does not hold", () => {
    const doc = fixture("<article><p>Hello world.</p></article>");
    const map = buildTextMap(doc.body, NO_LAYOUT);

    expect(map.rangeFor(1, 0, 5)).toBeNull();
    expect(map.rangeFor(0, 5, 5)).toBeNull();
    expect(map.rangeFor(0, 4, 3)).toBeNull();
    expect(map.rangeFor(0, -1, 2)).toBeNull();
    expect(map.rangeFor(0, 0, 999)).toBeNull();
    expect(map.rangeFor(0, 1.5, 3)).toBeNull();
  });

  it("reads a selection as a selection document", () => {
    const doc = fixture(`<article><p id="one">Alpha beta gamma.</p><p id="two">Delta epsilon.</p></article>`);
    const selection = window.getSelection();
    expect(selection).not.toBeNull();
    if (selection === null) return;

    const first = doc.getElementById("one")?.firstChild;
    const second = doc.getElementById("two")?.firstChild;
    if (!(first instanceof Text) || !(second instanceof Text)) throw new Error("the fixture has no text nodes");

    const range = doc.createRange();
    range.setStart(first, 6);
    range.setEnd(second, 5);
    selection.removeAllRanges();
    selection.addRange(range);

    const { document: model } = extractSelectionDocument(selection, NO_LAYOUT);

    expect(model.source.kind).toBe("selection");
    expect(model.blocks.map((block) => block.text)).toEqual(["beta gamma.", "Delta"]);
    expect(model.blocks.every((block) => block.kind === "paragraph")).toBe(true);
  });
});

describe("the live page", () => {
  it("comes out of the extraction byte-identical", () => {
    const doc = fixture(`<article><h1>Untouched</h1><p>${PARAGRAPH_ONE}</p></article>`);
    const before = doc.documentElement.outerHTML;

    extractPageDocument(doc, NO_LAYOUT);

    expect(doc.documentElement.outerHTML).toBe(before);
    expect(doc.querySelectorAll(`[${CLONE_INDEX_ATTRIBUTE}]`).length).toBe(0);
  });
});
