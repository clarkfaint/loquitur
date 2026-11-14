/**
 * In-page highlighting, end to end (F§10.2, F§13 phase 2).
 *
 * One case drives the whole content-script path: the popup asks the extension to read the active tab's page, the
 * service worker asks that tab's content script, the content script extracts the article and hands it over, the
 * offscreen document plays it through the hub's mock engine, and every snapshot it publishes comes back to the
 * page as a painted word.
 *
 * Four things are asserted, and each is the contract's own wording. The highlight exists and its text is a word
 * of the *article* — a reading that painted the navigation or the footer would pass a weaker check. It moves at
 * least five times in ten seconds, which is what "the player is actually reading" means for a page. The page is
 * untouched: the element count and the article's `innerHTML` are identical before the reading and during it,
 * because F§10.2 paints with the highlight registry rather than by wrapping text. And `Alt`+click on a word of
 * the last paragraph starts the reading there, which is F§10.2's read-from-here.
 *
 * What the highlight registry holds is readable from the page's own world — measured in this session, and the
 * reason these assertions can be written in `page.evaluate` at all: a `Highlight` registered by a content script
 * belongs to the document, not to the isolated world that created it.
 */

import type { Page } from "@playwright/test";
import { expect, test, testEnvironment } from "./fixtures";

/** The word the `Alt`+click case aims at: it is in the article's last paragraph, and only there. */
const CLICK_WORD = "reflections";

/** How long each of the two timed observations runs: the contract's ten seconds. */
const OBSERVE_MS = 10_000;

/** How often the running reading is sampled while observing it. */
const SAMPLE_MS = 200;

/**
 * The speed the case reads at (F§10.1 allows 0.5–5.0). The player publishes F§5.7's position, which moves a
 * sentence at a time, so what "the highlighted word changes" measures here is how many sentence boundaries fall
 * inside ten seconds. At 1× this article's own long sentences put three of them there — the case would be
 * measuring the article rather than the highlight — so it reads at 2.5×, where seven do.
 */
const READING_RATE = 2.5;

/** What the page looked like, and what it holds: read before the reading and again during it. */
interface PageShape {
  elements: number;
  article: string;
}

/** The page's element count and the article's own markup. */
async function shapeOf(page: Page): Promise<PageShape> {
  return await page.evaluate(() => ({
    elements: document.querySelectorAll("*").length,
    article: document.querySelector("article")?.innerHTML ?? "",
  }));
}

/** The text of the registered word highlight, or `null` while nothing is highlighting a word. */
async function highlightedWord(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    const highlight = CSS.highlights.get("lectern-word");
    if (highlight === undefined) return null;
    for (const range of highlight) return range.toString();
    return null;
  });
}

/** The text of the registered sentence highlight, or `null` while nothing is highlighting a sentence. */
async function highlightedSentence(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    const highlight = CSS.highlights.get("lectern-sentence");
    if (highlight === undefined) return null;
    for (const range of highlight) return range.toString();
    return null;
  });
}

/** Whether the highlighted word is drawn inside the article, and inside nothing else. */
async function wordIsInsideArticle(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const article = document.querySelector("article");
    const highlight = CSS.highlights.get("lectern-word");
    if (article === null || highlight === undefined) return false;
    const frame = article.getBoundingClientRect();
    for (const registered of highlight) {
      // The registry's typings name the abstract base; what the browser hands back is a `Range`, which is what
      // a box can be asked of.
      const box = (registered as Range).getBoundingClientRect();
      const inside =
        box.top >= frame.top - 1 && box.bottom <= frame.bottom + 1 && box.left >= frame.left - 1 && box.right <= frame.right + 1;
      return inside && box.width > 0 && box.height > 0;
    }
    return false;
  });
}

/** The article's last paragraph, and the point in it worth clicking on (the middle of one word). */
async function lastParagraphPoint(page: Page, literal: string): Promise<{ x: number; y: number; text: string }> {
  const found = await page.evaluate((word) => {
    const paragraphs = [...document.querySelectorAll("article p")];
    const last = paragraphs.at(-1);
    const node = last?.firstChild ?? null;
    if (last === undefined || node === null || node.nodeType !== Node.TEXT_NODE) return null;
    const text = node as Text;
    const at = text.data.indexOf(word);
    if (at === -1) return null;
    // Two characters into the word, so the point is over a letter rather than over its first edge.
    const range = document.createRange();
    range.setStart(text, at + 2);
    range.setEnd(text, at + 3);
    const box = range.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2, text: (last.textContent ?? "").trim() };
  }, literal);
  if (found === null) throw new Error(`the fixture's last paragraph holds no "${literal}"`);
  return found;
}

test("highlights the page as it is read, without touching it, and reads from an Alt-click", async ({
  context,
  serviceWorker,
  extensionId,
  configure,
}) => {
  await configure({ rate: READING_RATE });
  const environment = await testEnvironment();

  const page = await context.newPage();
  await page.goto(`${environment.pagesUrl}/article.html`);
  const before = await shapeOf(page);
  expect(before.elements).toBeGreaterThan(0);

  // The request comes from an extension page, because a page's own world has no `chrome` object and a service
  // worker cannot message itself. The article is then brought forward, because `ext/read-active-tab` reads the
  // *active* tab and the view that asked is a tab of its own.
  const view = await context.newPage();
  await view.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.bringToFront();
  const asked = await view.evaluate(async () => await chrome.runtime.sendMessage({ type: "ext/read-active-tab" }));
  expect(asked).toMatchObject({ ok: true });

  // The highlight appears, and it is a word of the article rather than of the page's furniture.
  await expect.poll(async () => await highlightedWord(page), { timeout: OBSERVE_MS }).not.toBeNull();
  const first = await highlightedWord(page);
  expect(first).not.toBeNull();
  expect(first ?? "").toMatch(/^\S+$/);
  await expect.poll(async () => await wordIsInsideArticle(page), { timeout: OBSERVE_MS }).toBe(true);
  expect(await highlightedSentence(page)).not.toBeNull();

  // It moves: five changes are six different words in a row.
  const words: string[] = [];
  const deadline = Date.now() + OBSERVE_MS;
  while (Date.now() < deadline) {
    const word = await highlightedWord(page);
    if (word !== null && words.at(-1) !== word) words.push(word);
    await page.waitForTimeout(SAMPLE_MS);
  }
  expect(words.length - 1).toBeGreaterThanOrEqual(5);

  // Nothing was inserted, wrapped or restyled while all of that happened.
  expect(await shapeOf(page)).toEqual(before);

  // `Alt`+click on a word of the last paragraph reads from there: the sentence highlight moves into that
  // paragraph, which is what "the sentence index moved to the point" looks like from the page.
  const target = await lastParagraphPoint(page, CLICK_WORD);
  await page.keyboard.down("Alt");
  await page.mouse.click(target.x, target.y);
  await page.keyboard.up("Alt");
  await expect
    .poll(
      async () => {
        const sentence = await highlightedSentence(page);
        return sentence !== null && target.text.includes(sentence);
      },
      { timeout: OBSERVE_MS },
    )
    .toBe(true);

  // The click was consumed by the reading and left the page alone, and the worker really did relay to the tab.
  expect(await shapeOf(page)).toEqual(before);
  const contexts = await serviceWorker.evaluate(
    async () => (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length,
  );
  expect(contexts).toBe(1);
});
