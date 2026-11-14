/**
 * Read-from-here's own tests (F§10.2).
 *
 * The question is one question — *which* sentence and word does a point on the page name? — and it is asked of
 * a real extracted document, because the answer depends on everything the extraction does: which element the
 * article root is, which blocks the map holds, how the block text was normalized and how core's tokenizer
 * numbered its sentences and words.
 *
 * The caret API is stubbed, and only that: a jsdom document has no layout, so nothing can be pointed at, but a
 * caret is just a node and an offset and the mapping is arithmetic over the map. What must hold either way is
 * that a point outside the readable text — the page's chrome, a hidden region, a script — names nothing at all,
 * because an `Alt`+click that names nothing must be left for the page to handle (the contract's *Forbidden
 * Actions*).
 */

import type { DocumentModel, Sentence, Word } from "@lectern/core";
import { beforeEach, describe, expect, it } from "vitest";
import { isReadFromHereClick, type PagePosition, positionForPoint } from "../click-to-read";
import { type Extraction, extractPageDocument } from "../page-document";
import type { ReadableEnv } from "../visibility";

/** What the tests can measure: jsdom parses, but lays nothing out. */
const NO_LAYOUT: ReadableEnv = { hasLayout: false };

/** Three paragraphs of ordinary prose, so Readability scores the article as one. */
const FIRST_PARAGRAPH =
  "The harbour keeps a clock of its own. At the top of the hour the water stands still, and the boats that " +
  "were leaning one way lean the other. Nobody on the quay looks up; everyone already knows.";
const SECOND_PARAGRAPH =
  "A tide is not a wave that travels. It is the whole basin rising and falling at once, twice a day, on a " +
  "schedule set by a body far too large to see. What a sailor watches is the consequence, not the cause.";
const THIRD_PARAGRAPH =
  "In the winter the light leaves early and the water keeps its colour last. The lamps along the mole come on " +
  "in a row, one after another, and the reflections take longer to settle than the lamps themselves.";

/** Replace the page's markup with the fixture this file reads, and answer the document. */
function fixture(): Document {
  document.head.innerHTML = "<title>Working a Tide</title>";
  document.body.innerHTML = `
    <header role="banner"><p>Harbour Notes — a quarterly about small ports</p></header>
    <nav aria-label="Sections"><ul><li><a href="#tide">The tide machine</a></li></ul></nav>
    <main>
      <article>
        <h1>Working a Tide</h1>
        <p>${FIRST_PARAGRAPH}</p>
        <p>${SECOND_PARAGRAPH}</p>
        <p>${THIRD_PARAGRAPH}</p>
        <div aria-hidden="true">Decoration nobody reads</div>
        <script>const skipped = "code";</script>
      </article>
    </main>
    <footer role="contentinfo"><p>A footer nobody reads</p></footer>`;
  return document;
}

/** The extraction every case reads: the article's model and the map its ranges come from. */
function extractionOf(): Extraction {
  return extractPageDocument(document, NO_LAYOUT);
}

/** One paragraph of the fixture, by position in document order. */
function paragraph(index: number): Element {
  const found = document.querySelectorAll("p")[index];
  if (found === undefined) throw new Error(`the fixture has no paragraph ${index}`);
  return found;
}

/** One element of the fixture, by selector. */
function element(selector: string): Element {
  const found = document.querySelector(selector);
  if (found === null) throw new Error(`the fixture has no ${selector}`);
  return found;
}

/**
 * A caret inside the first occurrence of `literal` in an element's text, `delta` characters into it. The node
 * is the *live* page's, which is what the map's entries hold.
 */
function caretInside(target: Element, literal: string, delta = 1): { node: Text; offset: number } {
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text;
    const at = text.data.indexOf(literal);
    if (at !== -1) return { node: text, offset: at + delta };
  }
  throw new Error(`the fixture holds no "${literal}" in that element`);
}

/** Make the caret API answer one caret — or, with `null`, answer nothing at all. */
function placeCaret(caret: { node: Node; offset: number } | null): void {
  Object.defineProperty(document, "caretPositionFromPoint", {
    configurable: true,
    value: (): CaretPosition | null => (caret === null ? null : ({ offsetNode: caret.node, offset: caret.offset } as CaretPosition)),
  });
}

/** The position a point names, insisting that it names one. */
function positionAt(extraction: Extraction, x = 10, y = 10): PagePosition {
  const found = positionForPoint(extraction.textMap, extraction.document, x, y);
  if (found === null) throw new Error("the point named no position");
  return found;
}

/** The sentence and the word a position names in the model, or `null` when the model has neither. */
function at(model: DocumentModel, position: PagePosition): { sentence: Sentence; word: Word } | null {
  for (const block of model.blocks) {
    for (const sentence of block.sentences) {
      if (sentence.index !== position.sentenceIndex) continue;
      const word = sentence.words[position.wordIndex];
      return word === undefined ? null : { sentence, word };
    }
  }
  return null;
}

beforeEach(() => {
  fixture();
  placeCaret(null);
});

describe("a point over the readable text", () => {
  it("names the word under the caret and the sentence it sits in", () => {
    const extraction = extractionOf();
    placeCaret(caretInside(paragraph(1), "clock"));
    const found = at(extraction.document, positionAt(extraction));
    expect(found?.word.text).toBe("clock");
    expect(found?.sentence.text).toContain("clock");
  });

  it("names a later sentence for a point further down the page", () => {
    const extraction = extractionOf();
    placeCaret(caretInside(paragraph(1), "clock"));
    const earlier = positionAt(extraction).sentenceIndex;
    placeCaret(caretInside(paragraph(3), "lamps"));
    const later = positionAt(extraction);
    expect(later.sentenceIndex).toBeGreaterThan(earlier);
    expect(at(extraction.document, later)?.word.text).toBe("lamps");
  });

  it("keeps a caret on a word's last boundary with that word", () => {
    const extraction = extractionOf();
    // One past the last character of "harbour" is the space before "keeps" — a boundary the range holds.
    placeCaret(caretInside(paragraph(1), "harbour", "harbour".length));
    expect(at(extraction.document, positionAt(extraction))?.word.text).toBe("harbour");
  });

  it("names a word of a sentence that ends its block", () => {
    const extraction = extractionOf();
    placeCaret(caretInside(paragraph(2), "cause"));
    const found = at(extraction.document, positionAt(extraction));
    expect(found?.word.text).toBe("cause.");
    expect(found?.sentence.text.endsWith("not the cause.")).toBe(true);
  });
});

describe("a point that names nothing readable", () => {
  it("names nothing over the page's navigation", () => {
    const extraction = extractionOf();
    placeCaret(caretInside(element("nav"), "tide machine"));
    expect(positionForPoint(extraction.textMap, extraction.document, 10, 10)).toBeNull();
  });

  it("names nothing over the page's footer", () => {
    const extraction = extractionOf();
    placeCaret(caretInside(element("footer"), "footer"));
    expect(positionForPoint(extraction.textMap, extraction.document, 10, 10)).toBeNull();
  });

  it("names nothing over a region the page declares hidden", () => {
    const extraction = extractionOf();
    placeCaret(caretInside(element("[aria-hidden='true']"), "Decoration"));
    expect(positionForPoint(extraction.textMap, extraction.document, 10, 10)).toBeNull();
  });

  it("names nothing over a script", () => {
    const extraction = extractionOf();
    placeCaret(caretInside(element("script"), "skipped"));
    expect(positionForPoint(extraction.textMap, extraction.document, 10, 10)).toBeNull();
  });

  it("names nothing when the caret lands on an element rather than on text", () => {
    const extraction = extractionOf();
    placeCaret({ node: paragraph(1), offset: 0 });
    expect(positionForPoint(extraction.textMap, extraction.document, 10, 10)).toBeNull();
  });

  it("names nothing when the browser places no caret at all", () => {
    const extraction = extractionOf();
    placeCaret(null);
    expect(positionForPoint(extraction.textMap, extraction.document, 10, 10)).toBeNull();
  });
});

describe("isReadFromHereClick", () => {
  it("accepts the primary button with Alt and nothing else held", () => {
    expect(isReadFromHereClick(new MouseEvent("click", { altKey: true, button: 0 }))).toBe(true);
  });

  it("leaves every other click to the page", () => {
    expect(isReadFromHereClick(new MouseEvent("click", { button: 0 }))).toBe(false);
    expect(isReadFromHereClick(new MouseEvent("click", { altKey: true, shiftKey: true }))).toBe(false);
    expect(isReadFromHereClick(new MouseEvent("click", { altKey: true, ctrlKey: true }))).toBe(false);
    expect(isReadFromHereClick(new MouseEvent("click", { altKey: true, metaKey: true }))).toBe(false);
    expect(isReadFromHereClick(new MouseEvent("click", { altKey: true, button: 2 }))).toBe(false);
  });
});
