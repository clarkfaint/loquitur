/**
 * The reader in a real browser (U-025). A highlight range, a caret position under a pointer and the
 * question of whether React rebuilt the page are answered by the browser and by nothing else, so every
 * case here runs in Chromium against the harness page, which mounts the shipped `ReaderView`.
 *
 * The fixture is Lectern's own text, and its structure is read back from the page rather than assumed:
 * the harness builds the `DocumentModel` with the shipped builder, and each case points at a word by the
 * sentence and word indexes the model gives it.
 */

import type { DocumentModel } from "@lectern/core";
import { expect, type Page, test } from "@playwright/test";

/** One block per line: `# ` heading, `> ` quote, `- ` list item, `! ` furniture, anything else prose. */
const FIXTURE_TEXT = [
  "# A document to read",
  "Lectern reads the page aloud. The reader follows along.",
  "A second paragraph carries more words. It gives the highlighter something to find.",
  "> A quoted line stands apart from the prose. It is read like any other block.",
  "- The first item of a list. It holds two sentences.",
  "- The second item of a list. It closes the fixture.",
  "! Lectern reader harness",
].join("\n");

/** The block kinds the fixture uses, and the element each one has to render as (F§10.1). */
const EXPECTED_TAG: Record<string, string> = {
  heading: "h1",
  paragraph: "p",
  quote: "blockquote",
  "list-item": "li",
  header: "p",
};

/** A position in the document, in the shape the reader's own props take it. */
interface TextPosition {
  sentenceIndex: number;
  wordIndex: number;
}

/** The word the click case aims at, with the offsets its range needs and the text it must cover. */
interface Aim extends TextPosition {
  blockIndex: number;
  charStart: number;
  charEnd: number;
  sentenceText: string;
  wordText: string;
}

declare global {
  interface Window {
    readerDocumentJson: (text: string) => string;
    mountReader: (documentJson: string, options?: { showSkipped?: boolean }) => void;
    setReaderActive: (active: TextPosition | null) => void;
    readerSeeked: () => TextPosition | null;
  }
}

/** Build the fixture with the shipped builder, mount the reader on it, and hand back the model. */
async function mountFixture(page: Page, options: { showSkipped?: boolean } = {}): Promise<DocumentModel> {
  const documentJson = await page.evaluate((text) => window.readerDocumentJson(text), FIXTURE_TEXT);
  await page.evaluate(
    (args) => {
      window.mountReader(args.json, { showSkipped: args.showSkipped });
    },
    { json: documentJson, showSkipped: options.showSkipped ?? false },
  );
  return JSON.parse(documentJson) as DocumentModel;
}

/** Every word of the document, in reading order, as a position the reader can be pointed at. */
function positionsOf(model: DocumentModel): TextPosition[] {
  return model.blocks.flatMap((block) =>
    block.sentences.flatMap((sentence) => sentence.words.map((word) => ({ sentenceIndex: sentence.index, wordIndex: word.index }))),
  );
}

/** The word the click case aims at: the second word of the first paragraph, never the first one. */
function aimAt(model: DocumentModel): Aim {
  const block = model.blocks[1];
  const sentence = block?.sentences[0];
  const word = sentence?.words[1];
  if (block === undefined || sentence === undefined || word === undefined) throw new Error("the fixture is too short");
  return {
    sentenceIndex: sentence.index,
    wordIndex: word.index,
    blockIndex: block.index,
    charStart: sentence.charStart + word.charStart,
    charEnd: sentence.charStart + word.charEnd,
    sentenceText: sentence.text,
    wordText: word.text,
  };
}

/** The texts registered under one highlight name, as the page sees them. */
async function highlightTexts(page: Page, name: string): Promise<string[]> {
  return page.evaluate((highlightName) => {
    const highlight = CSS.highlights.get(highlightName);
    return highlight === undefined ? [] : [...highlight].map((range) => range.toString());
  }, name);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => typeof window.mountReader === "function");
});

test("registers one sentence range and one word range on the active position", async ({ page }) => {
  const model = await mountFixture(page);
  const aim = aimAt(model);

  await page.evaluate((position) => window.setReaderActive(position), aim);

  expect(await highlightTexts(page, "lectern-sentence")).toEqual([aim.sentenceText]);
  expect(await highlightTexts(page, "lectern-word")).toEqual([aim.wordText]);
});

test("seeks to the word a click lands on", async ({ page }) => {
  const model = await mountFixture(page);
  const aim = aimAt(model);

  // The word is found from the model's own offsets over the block's text node, never with the shipped
  // locator, so this case cannot agree with a locator that is wrong in the same way it is.
  const landing = await page.evaluate((args) => {
    const blockEl = document.querySelector(`[data-block="${args.blockIndex}"]`);
    if (blockEl === null) throw new Error("the block is not rendered");
    const node = blockEl.firstChild;
    if (node === null || node.nodeType !== Node.TEXT_NODE) throw new Error("the block is not one text node");
    const range = document.createRange();
    range.setStart(node, args.charStart);
    range.setEnd(node, args.charEnd);
    blockEl.scrollIntoView({ block: "center" });
    const rect = range.getBoundingClientRect();
    return { blockText: node.textContent ?? "", text: range.toString(), x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, aim);

  expect(landing.blockText).toBe(model.blocks[aim.blockIndex]?.text);
  expect(landing.text).toBe(aim.wordText);

  await page.mouse.click(landing.x, landing.y);

  expect(await page.evaluate(() => window.readerSeeked())).toEqual({ sentenceIndex: aim.sentenceIndex, wordIndex: aim.wordIndex });
});

test("never rebuilds the reader's elements as the position moves", async ({ page }) => {
  const model = await mountFixture(page);
  const positions = positionsOf(model).slice(0, 50);
  expect(positions).toHaveLength(50);

  const report = await page.evaluate(async (list) => {
    const container = document.getElementById("reader");
    if (container === null) throw new Error("the reader is not mounted");
    const readWord = (): string => {
      const highlight = CSS.highlights.get("lectern-word");
      return highlight === undefined ? "" : [...highlight].map((range) => range.toString()).join("");
    };
    const counts: number[] = [container.querySelectorAll("*").length];
    const highlights: string[] = [];
    for (const position of list) {
      window.setReaderActive(position);
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
      counts.push(container.querySelectorAll("*").length);
      highlights.push(readWord());
    }
    return { counts, first: highlights[0], last: highlights[highlights.length - 1] };
  }, positions);

  expect(new Set(report.counts).size).toBe(1);
  expect(report.first).not.toBe("");
  expect(report.first).not.toBe(report.last);
});

test("renders each block kind as its element, and furniture dimmed or hidden", async ({ page }) => {
  const model = await mountFixture(page, { showSkipped: true });

  const drawn = await page.evaluate(() => {
    const container = document.getElementById("reader");
    if (container === null) throw new Error("the reader is not mounted");
    return [...container.querySelectorAll("[data-block]")].map((element) => ({
      index: Number(element.getAttribute("data-block")),
      tag: element.tagName.toLowerCase(),
      skipped: element.getAttribute("data-skipped") === "true",
      dimmed: (element.getAttribute("style") ?? "").includes("opacity"),
      textNodes: element.childNodes.length,
    }));
  });

  expect(drawn.length).toBe(model.blocks.length);
  for (const entry of drawn) {
    const block = model.blocks[entry.index];
    expect(block).toBeDefined();
    expect(entry.tag).toBe(EXPECTED_TAG[block?.kind ?? ""]);
    expect(entry.skipped).toBe(block?.skip);
    expect(entry.dimmed).toBe(block?.skip);
    expect(entry.textNodes).toBe(1);
  }
  expect(drawn.some((entry) => entry.skipped)).toBe(true);

  await page.evaluate((text) => {
    window.mountReader(window.readerDocumentJson(text), { showSkipped: false });
  }, FIXTURE_TEXT);
  const hidden = await page.evaluate(() => document.querySelectorAll("[data-skipped]").length);
  expect(hidden).toBe(0);
});
