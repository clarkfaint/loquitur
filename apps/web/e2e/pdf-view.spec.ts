/**
 * The PDF page view, end to end (F§10.1, F§13 phase 2).
 *
 * These cases drive the production build against a real hub (`global-setup.ts` starts one with the mock
 * engine) through the screens a reader uses: the fixture PDF imported, the reader switched to its Pages,
 * the reading started, a word clicked, and the switch taken back to Text.
 *
 * Two things are read back from the app rather than restated here. The document's model comes out of the
 * app's own IndexedDB, so the word a highlight is compared with is the word the app's own model holds at
 * the position the app itself recorded — a word this file picked could be wrong in the same way the app
 * is. And the running header a highlight must never land on comes from the fixtures' own `expected.json`,
 * which is what the generator promised the fixture carries.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { connect } from "./helpers";

/** The fixture PDF, and the record of what its generator promised about it. */
const PDF = fileURLToPath(new URL("../../../packages/fixtures/generated/text.pdf", import.meta.url));
const EXPECTED = fileURLToPath(new URL("../../../packages/fixtures/generated/expected.json", import.meta.url));

/** These cases read a five-page document and play real audio in a real browser, so they get room. */
test.setTimeout(180_000);

/** What `expected.json` says about the fixture: the title it arrives under, and its running header. */
interface FixtureExpectations {
  title: string;
  headerText: string;
}

/** The database the app keeps its library in, and the records these cases read back from it. */
const DB_NAME = "lectern";

interface StoredWord {
  index: number;
  text: string;
}

interface StoredSentence {
  index: number;
  text: string;
  words: StoredWord[];
}

interface StoredBlock {
  sentences: StoredSentence[];
}

interface StoredModel {
  docId: string;
  blocks: StoredBlock[];
}

interface StoredProgress {
  sentenceIndex: number;
  wordIndex: number;
}

/** A word of a page: what it says, where it is in its line, and the point it was clicked at. */
interface PageWord {
  text: string;
  x: number;
  y: number;
  line: string;
  start: number;
  end: number;
}

/** What the fixtures' generator said about the fixture. */
async function expectations(): Promise<FixtureExpectations> {
  return JSON.parse(await readFile(EXPECTED, "utf8")) as FixtureExpectations;
}

/** Read one record out of the app's own database, by store and key. */
async function readRecord<T>(page: Page, store: string, key: string): Promise<T | null> {
  return page.evaluate(
    (args) =>
      new Promise<T | null>((resolve, reject) => {
        const request = indexedDB.open(args.db);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const get = db.transaction(args.store, "readonly").objectStore(args.store).get(args.key);
          get.onsuccess = () => resolve((get.result ?? null) as T | null);
          get.onerror = () => reject(get.error);
        };
      }),
    { db: DB_NAME, store, key },
  );
}

/** Import the fixture PDF and open it from the library, answering the `docId` the address bar carries. */
async function openFixture(page: Page, title: string): Promise<string> {
  await page.goto("/#/import");
  await page.setInputFiles("#lectern-import-file", PDF);
  await expect(page.locator('[data-import-item][data-status="done"]')).toHaveCount(1);
  await page.goto("/#/library");
  await page.getByRole("link", { name: title, exact: true }).click();
  await expect(page).toHaveURL(/#\/read\//);
  const match = /#\/read\/([^?]+)/u.exec(page.url());
  if (match === null || match[1] === undefined) throw new Error(`the reader did not open: ${page.url()}`);
  return decodeURIComponent(match[1]);
}

/** Switch to the page view, and wait for the first page to be drawn rather than merely laid out. */
async function showPages(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Pages", exact: true }).click();
  await expect(page.locator('[data-pdf-page="1"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-pdf-page="1"][data-rendered="true"]')).toBeVisible({ timeout: 30_000 });
}

/** The texts registered under one highlight name, as the page sees them. */
async function highlighted(page: Page, name: string): Promise<string> {
  return page.evaluate((highlightName) => {
    const highlight = CSS.highlights.get(highlightName);
    return highlight === undefined ? "" : [...highlight].map((range) => range.toString()).join("");
  }, name);
}

/**
 * The number of the page whose text layer holds the word being read, or `null` when the highlight is
 * not on a page at all — which is what "the highlight lies inside the page's text layer" means.
 */
async function wordHighlightPage(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const ranges = [...(CSS.highlights.get("lectern-word") ?? [])];
    const first = ranges[0];
    if (first === undefined) return null;
    const start = first.startContainer;
    const layer = (start instanceof Element ? start : start.parentElement)?.closest("[data-pdf-text-layer]") ?? null;
    if (layer === null) return null;
    const inside = ranges.every((range) => layer.contains(range.startContainer) && layer.contains(range.endContainer));
    if (!inside) return null;
    const box = layer.closest("[data-pdf-page]");
    const pageNumber = Number(box?.getAttribute("data-pdf-page"));
    return Number.isInteger(pageNumber) ? pageNumber : null;
  });
}

/** The dark pixels on a page's raster: proof a page was drawn rather than merely declared. */
async function canvasInk(page: Page, pageNumber: number): Promise<number> {
  return page.evaluate((number) => {
    const canvas = document.querySelector(`[data-pdf-page="${number}"] [data-pdf-canvas]`);
    if (!(canvas instanceof HTMLCanvasElement)) return 0;
    const context = canvas.getContext("2d");
    if (context === null || canvas.width === 0 || canvas.height === 0) return 0;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let ink = 0;
    for (let at = 0; at < data.length; at += 4) {
      if ((data[at] ?? 255) < 200 || (data[at + 1] ?? 255) < 200 || (data[at + 2] ?? 255) < 200) ink += 1;
    }
    return ink;
  }, pageNumber);
}

/** The word the app's own model holds at a position, or `null` when the model has none there. */
function wordAt(model: StoredModel, position: StoredProgress): string | null {
  for (const block of model.blocks) {
    for (const sentence of block.sentences) {
      if (sentence.index !== position.sentenceIndex) continue;
      return sentence.words.find((word) => word.index === position.wordIndex)?.text ?? null;
    }
  }
  return null;
}

/** Which sentence the reflowed reader is on, resolved from its sentence highlight through the model. */
async function textSentenceIndex(page: Page, model: StoredModel): Promise<number> {
  const text = await highlighted(page, "lectern-sentence");
  if (text === "") return -1;
  for (const block of model.blocks) {
    for (const sentence of block.sentences) {
      if (sentence.text === text) return sentence.index;
    }
  }
  return -1;
}

/**
 * Click a word inside a line in the middle of the first page, and answer the word and the point it was
 * clicked at. The line is measured from the page's own text layer, and a word at a line's edge is left
 * alone: the first word of a line can be the second half of a word a line break split, and such a word's
 * characters are not the word the model holds.
 */
async function clickPageWord(page: Page): Promise<PageWord> {
  const target = await page.evaluate(() => {
    const box = document.querySelector('[data-pdf-page="1"]');
    if (box === null) throw new Error("the first page is not rendered");
    const boxRect = box.getBoundingClientRect();
    const spans = [...document.querySelectorAll('[data-pdf-page="1"] [data-pdf-text-layer] span')].filter((span) => {
      const rect = span.getBoundingClientRect();
      return rect.height > 0 && rect.top > boxRect.top + 40 && rect.top < boxRect.bottom - 120;
    });
    const span = spans.at(Math.floor(spans.length / 2));
    const node = span?.firstChild ?? null;
    if (span === undefined || node === null || node.nodeType !== Node.TEXT_NODE) {
      throw new Error("no line of the first page holds a text node");
    }
    const text = (node as Text).data;
    const words = [...text.matchAll(/\S+/gu)];
    const chosen = words.find((word, at) => at > 0 && at < words.length - 1 && !word[0].endsWith("-") && word[0].length > 2);
    if (chosen === undefined || chosen.index === undefined) throw new Error("the line has no word to click");
    const range = document.createRange();
    range.setStart(node, chosen.index);
    range.setEnd(node, chosen.index + chosen[0].length);
    const rect = range.getBoundingClientRect();
    return {
      text: chosen[0],
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      line: text,
      start: chosen.index,
      end: chosen.index + chosen[0].length,
    };
  });

  await page.mouse.click(target.x, target.y);
  return target;
}

/**
 * Whether the word being read is the very characters that were clicked: the same line's text node, and
 * the same offsets inside it. The ranges are read after the click, because the reader's own auto-scroll
 * moves the page as soon as the reading follows the click (F§10.1), which makes a point measured before
 * it meaningless — the offsets do not move with the page.
 */
async function highlightIsClickedWord(page: Page, word: PageWord): Promise<{ found: boolean; boxes: number }> {
  return page.evaluate((clicked) => {
    const lines = [...document.querySelectorAll("[data-pdf-page] [data-pdf-text-layer] span")];
    const line = lines.find((span) => span.textContent === clicked.line) ?? null;
    const ranges = [...(CSS.highlights.get("lectern-word") ?? [])];
    const boxes = ranges.filter((range) => range.getBoundingClientRect().width > 0).length;
    if (line === null) return { found: false, boxes };
    return {
      found: ranges.some(
        (range) => range.startContainer === line.firstChild && range.startOffset === clicked.start && range.endOffset === clicked.end,
      ),
      boxes,
    };
  }, word);
}

test("the word being read is painted on the page's own text layer, and only nearby pages are drawn", async ({ page }) => {
  await connect(page);
  const { title } = await expectations();
  const docId = await openFixture(page, title);
  await showPages(page);
  await page.getByRole("button", { name: "4.5×" }).click();
  await page.getByRole("button", { name: "Play" }).click();

  // The highlight is a range on the page's text layer, not a second rendering of the text.
  await expect.poll(() => wordHighlightPage(page), { timeout: 20_000 }).toBe(1);
  expect(await highlighted(page, "lectern-word")).not.toBe("");

  // Every page has its box, so the document's height is right, and only the pages near the viewport
  // are drawn: five boxes, at most three rasters at the test's own viewport.
  expect(await page.locator("[data-pdf-page]").count()).toBe(5);
  const drawn = await page.locator('[data-pdf-page][data-rendered="true"]').count();
  expect(drawn).toBeGreaterThanOrEqual(1);
  expect(drawn).toBeLessThanOrEqual(3);
  expect(await canvasInk(page, 1)).toBeGreaterThan(0);

  // Pausing settles the position at once, so the word the player reports and the word painted are read
  // from the same instant.
  await page.getByRole("button", { name: "Pause" }).click();
  const painted = await highlighted(page, "lectern-word");
  const written = await readRecord<StoredProgress>(page, "progress", docId);
  const model = await readRecord<StoredModel>(page, "models", docId);
  if (written === null || model === null) throw new Error("the reader recorded no position to compare with");
  expect(model.docId).toBe(docId);
  expect(painted).toBe(wordAt(model, written));
  expect(painted).not.toBe("");
});

test("with furniture skipping on, no highlight ever lands on the running header", async ({ page }) => {
  await connect(page);
  const { title, headerText } = await expectations();
  await openFixture(page, title);
  await showPages(page);

  // The reader's own default, and the setting this case is about: furniture is not read (F§5.4).
  await expect(page.getByLabel("Skip headers, footers and footnotes")).toBeChecked();
  await page.getByRole("button", { name: "4.5×" }).click();
  await page.getByRole("button", { name: "Play" }).click();

  // Watch what is painted while the first sentences are read. A sentence is counted when the sentence
  // highlight names one it has not named before; the header's own span is the one the fixture wrote.
  const watched = await page.evaluate(
    async (args: { header: string; sentences: number }) => {
      const headerSpan = (): Element | null => {
        const spans = [...document.querySelectorAll("[data-pdf-text-layer] span")];
        return spans.find((span) => span.textContent === args.header) ?? null;
      };
      let onHeader = 0;
      let read = 0;
      let previous = "";
      const words = new Set<string>();
      const deadline = Date.now() + 60_000;
      while (read < args.sentences && Date.now() < deadline) {
        for (const range of CSS.highlights.get("lectern-word") ?? []) {
          const span = headerSpan();
          if (span !== null && (span.contains(range.startContainer) || span.contains(range.endContainer))) onHeader += 1;
          const text = range.toString();
          if (text !== "") words.add(text);
        }
        const sentence = [...(CSS.highlights.get("lectern-sentence") ?? [])].map((range) => range.toString()).join("");
        if (sentence !== "" && sentence !== previous) {
          previous = sentence;
          read += 1;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 100);
        });
      }
      return { onHeader, read, words: [...words] };
    },
    { header: headerText, sentences: 5 },
  );

  expect(watched.read).toBeGreaterThanOrEqual(5);
  expect(watched.words.length).toBeGreaterThan(0);
  expect(watched.onHeader).toBe(0);
});

test("a click on a word of a page seeks to that word", async ({ page }) => {
  await connect(page);
  const { title } = await expectations();
  await openFixture(page, title);
  await showPages(page);

  const clicked = await clickPageWord(page);

  await expect.poll(() => highlighted(page, "lectern-word"), { timeout: 20_000 }).toBe(clicked.text);
  // …and the highlight is the occurrence that was clicked, rather than another word of the same text:
  // the same line, the same offsets inside it, and a box that really has a size.
  const painted = await highlightIsClickedWord(page, clicked);
  expect(painted.found).toBe(true);
  expect(painted.boxes).toBeGreaterThan(0);
});

test("switching back to Text keeps the position the pages were read at", async ({ page }) => {
  await connect(page);
  const { title } = await expectations();
  const docId = await openFixture(page, title);
  await page.getByRole("button", { name: "4.5×" }).click();
  await page.getByRole("button", { name: "Play" }).click();

  const model = await readRecord<StoredModel>(page, "models", docId);
  if (model === null) throw new Error("the document's model is not in the library");
  await expect.poll(() => textSentenceIndex(page, model), { timeout: 30_000 }).toBeGreaterThan(1);

  // Pausing settles the position, so the record the switch must keep is already written.
  await page.getByRole("button", { name: "Pause" }).click();
  const written = await readRecord<StoredProgress>(page, "progress", docId);
  if (written === null) throw new Error("the reader wrote no progress record");

  await showPages(page);
  await expect.poll(() => wordHighlightPage(page), { timeout: 20_000 }).toBe(1);
  await page.getByRole("button", { name: "Text", exact: true }).click();

  await expect.poll(() => textSentenceIndex(page, model), { timeout: 20_000 }).toBe(written.sentenceIndex);
  await expect.poll(() => highlighted(page, "lectern-word"), { timeout: 20_000 }).toBe(wordAt(model, written));
});
