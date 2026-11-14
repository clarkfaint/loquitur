/**
 * The reader, end to end (F§10.1, F§13 phase 2).
 *
 * These cases drive the production build against a real hub (`global-setup.ts` starts one with F§7.1's mock
 * engine) through the screens a reader uses: a document pasted in, opened from the library, played, sped up,
 * switched to another voice, clicked in, paused, reloaded, mirrored in a second tab and bookmarked.
 *
 * Two things are read back from the app rather than restated here. The document's model comes out of the
 * app's own IndexedDB, so a sentence or a word is named by the offsets the parser gave it — a locator written
 * by hand could be wrong in the same way the app is. And the progress a reload restores is compared with the
 * `progress` record the app itself wrote, not with a number this file picked.
 */

import { expect, type Page, test } from "@playwright/test";
import { connect, importText } from "./helpers";

/** These cases play real audio in a real browser, so they are given room to be slow. */
test.setTimeout(90_000);

/** The document this spec pastes in: short sentences, so several of them play inside a test's patience. */
const TITLE = "Harbour Light";
const TEXT = [
  "The harbour holds the light.",
  "Boats wait for the tide.",
  "Nothing here is in a hurry.",
  "The water keeps its own time.",
  "Gulls cross a pale sky.",
  "Morning finds the quay empty.",
].join(" ");

/** The database the app keeps its library in, and the two stores this spec reads back. */
const DB_NAME = "lectern";

/** As much of the stored document as this spec needs: its blocks, its sentences and their words. */
interface StoredWord {
  index: number;
  charStart: number;
  charEnd: number;
  text: string;
}
interface StoredSentence {
  index: number;
  charStart: number;
  charEnd: number;
  text: string;
  words: StoredWord[];
}
interface StoredBlock {
  index: number;
  text: string;
  sentences: StoredSentence[];
}
interface StoredModel {
  docId: string;
  title: string;
  blocks: StoredBlock[];
}
interface StoredProgress {
  sentenceIndex: number;
  wordIndex: number;
}

/** A word of the document, as a click needs it: where it is, and what text it must cover. */
interface WordTarget {
  blockIndex: number;
  charStart: number;
  charEnd: number;
  text: string;
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

/** Open the document from the library and answer its `docId`, as the address bar carries it. */
async function open(page: Page, title: string, text: string): Promise<string> {
  await importText(page, title, text);
  await page.goto("/#/library");
  await page.getByRole("link", { name: title, exact: true }).click();
  await expect(page).toHaveURL(/#\/read\//);
  const match = /#\/read\/([^?]+)/u.exec(page.url());
  if (match === null || match[1] === undefined) throw new Error(`the reader did not open: ${page.url()}`);
  return decodeURIComponent(match[1]);
}

/** Every word of a document, in reading order, as a click target. */
function wordsOf(model: StoredModel): WordTarget[] {
  return model.blocks.flatMap((block) =>
    block.sentences.flatMap((sentence) =>
      sentence.words.map((word) => ({
        blockIndex: block.index,
        charStart: sentence.charStart + word.charStart,
        charEnd: sentence.charStart + word.charEnd,
        text: word.text,
      })),
    ),
  );
}

/** Every sentence of a document, in reading order. */
function sentencesOf(model: StoredModel): StoredSentence[] {
  return model.blocks.flatMap((block) => block.sentences);
}

/** The texts registered under one highlight name, as the page sees them. */
async function highlighted(page: Page, name: string): Promise<string> {
  return page.evaluate((highlightName) => {
    const highlight = CSS.highlights.get(highlightName);
    return highlight === undefined ? "" : [...highlight].map((range) => range.toString()).join("");
  }, name);
}

/** Which sentence the reader is on, resolved from the sentence highlight through the stored model. */
async function activeSentenceIndex(page: Page, docId: string): Promise<number> {
  const model = await readRecord<StoredModel>(page, "models", docId);
  const text = await highlighted(page, "lectern-sentence");
  if (model === null || text === "") return -1;
  return sentencesOf(model).find((sentence) => sentence.text === text)?.index ?? -1;
}

/** The progress record the app wrote for a document, or `null` while it has written none. */
async function storedProgress(page: Page, docId: string): Promise<StoredProgress | null> {
  return readRecord<StoredProgress>(page, "progress", docId);
}

/**
 * Click one word of the reader's text.
 *
 * The word is found from the model's own offsets over the block's single text node, so the click lands where
 * the document says the word is rather than where a selector guesses. The block is scrolled into view first
 * — which is a scroll the reader's own policy treats as the user's and suspends auto-scroll for — and the
 * point is then measured again, so a page that moved between the two steps cannot put the click elsewhere.
 */
async function clickWord(page: Page, target: WordTarget): Promise<void> {
  const aim = async (): Promise<{ x: number; y: number }> =>
    page.evaluate((word) => {
      const block = document.querySelector(`[data-block="${word.blockIndex}"]`);
      if (block === null) throw new Error("the block is not rendered");
      const node = block.firstChild;
      if (node === null || node.nodeType !== Node.TEXT_NODE) throw new Error("the block is not one text node");
      const range = document.createRange();
      range.setStart(node, word.charStart);
      range.setEnd(node, word.charEnd);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }, target);

  await page.evaluate((word) => {
    document.querySelector(`[data-block="${word.blockIndex}"]`)?.scrollIntoView({ block: "center" });
  }, target);
  await page.waitForTimeout(150);
  const point = await aim();
  await page.mouse.click(point.x, point.y);
}

/**
 * Record every audio element the app creates, before any app code runs, so a case can read the rate and the
 * pitch setting of the element that is really playing. The sink keeps its elements out of the document
 * (F§5.8), so watching the constructor is the only way to reach them.
 */
async function watchAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const created: HTMLAudioElement[] = [];
    const native = window.Audio;
    window.Audio = new Proxy(native, {
      construct: (target, args) => {
        const element = Reflect.construct(target, args) as HTMLAudioElement;
        created.push(element);
        return element;
      },
    }) as typeof window.Audio;
    (window as unknown as { lecternAudio: HTMLAudioElement[] }).lecternAudio = created;
  });
}

/** What the sink's playing element is set to, or `null` before the sink exists. */
async function audioProbe(page: Page): Promise<{ rate: number; preservesPitch: boolean } | null> {
  return page.evaluate(() => {
    const created = (window as unknown as { lecternAudio?: HTMLAudioElement[] }).lecternAudio ?? [];
    const element = created.find((candidate) => !candidate.paused) ?? created[0];
    return element === undefined ? null : { rate: element.playbackRate, preservesPitch: element.preservesPitch };
  });
}

test("playing paints the word being read and moves past the first sentences", async ({ page }) => {
  await connect(page);
  const docId = await open(page, TITLE, TEXT);

  await page.getByRole("button", { name: "Play" }).click();

  await expect.poll(() => highlighted(page, "lectern-word"), { timeout: 10_000 }).not.toBe("");
  await expect.poll(() => activeSentenceIndex(page, docId), { timeout: 10_000 }).toBeGreaterThan(1);

  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
});

test("4.5× reaches the audio element with the pitch preserved, and the second voice keeps playing", async ({ page }) => {
  await watchAudio(page);
  await connect(page);
  await open(page, TITLE, TEXT);
  await page.getByRole("button", { name: "Play" }).click();
  await expect.poll(() => highlighted(page, "lectern-word"), { timeout: 10_000 }).not.toBe("");

  // The other mock voice is chosen while the reader is playing; the reading carries on with it.
  await page.getByRole("button", { name: "Mock B" }).click();
  await expect(page.getByRole("button", { name: "Mock B" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();

  await page.getByRole("button", { name: "4.5×" }).click();
  await expect.poll(() => audioProbe(page), { timeout: 10_000 }).toEqual({ rate: 4.5, preservesPitch: true });
});

test("a click on a later word moves the reading there, and Space pauses it", async ({ page }) => {
  await connect(page);
  const docId = await open(page, TITLE, TEXT);
  await page.getByRole("button", { name: "Play" }).click();
  await expect.poll(() => highlighted(page, "lectern-word"), { timeout: 10_000 }).not.toBe("");

  // `Space` is F§10.1's toggle. The title is clicked first so the key is not delivered to a button.
  await page.getByRole("heading", { name: TITLE }).click();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();

  const model = await readRecord<StoredModel>(page, "models", docId);
  if (model === null) throw new Error("the document's model is not in the library");
  const target = wordsOf(model).at(-1);
  if (target === undefined) throw new Error("the document has no words");

  await clickWord(page, target);
  await expect.poll(() => highlighted(page, "lectern-word"), { timeout: 10_000 }).toBe(target.text);
});

test("a reload restores the position the app wrote, and comes up paused", async ({ page }) => {
  await connect(page);
  const docId = await open(page, TITLE, TEXT);
  await page.getByRole("button", { name: "Play" }).click();
  await expect.poll(() => activeSentenceIndex(page, docId), { timeout: 10_000 }).toBeGreaterThan(1);

  // Pausing settles the position, so the record the reload must restore is already written.
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
  const written = await storedProgress(page, docId);
  if (written === null) throw new Error("the reader wrote no progress record");
  expect(written.sentenceIndex).toBeGreaterThan(1);

  await page.reload();

  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
  await expect.poll(() => activeSentenceIndex(page, docId), { timeout: 10_000 }).toBe(written.sentenceIndex);
});

test("a second tab on #/mini shows the title, follows the reader, and pauses it", async ({ page }) => {
  await connect(page);
  await open(page, TITLE, TEXT);
  await page.getByRole("button", { name: "Play" }).click();
  await expect.poll(() => highlighted(page, "lectern-word"), { timeout: 10_000 }).not.toBe("");

  const mini = await page.context().newPage();
  await mini.goto("/#/mini");
  await expect(mini.getByRole("heading", { name: TITLE })).toBeVisible({ timeout: 10_000 });
  await expect(mini.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 10_000 });

  await mini.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible({ timeout: 10_000 });
  await mini.close();
});

test("a bookmark is added at the word being read, listed, and jumped to", async ({ page }) => {
  await connect(page);
  const docId = await open(page, TITLE, TEXT);
  const model = await readRecord<StoredModel>(page, "models", docId);
  if (model === null) throw new Error("the document's model is not in the library");
  const words = wordsOf(model);
  const target = words.at(-1);
  const first = words[0];
  if (target === undefined || first === undefined) throw new Error("the document has no words");

  await page.getByRole("button", { name: "Bookmarks" }).click();
  await clickWord(page, target);
  await expect.poll(() => highlighted(page, "lectern-word"), { timeout: 10_000 }).toBe(target.text);

  await page.getByLabel("Note", { exact: true }).fill("the harbour line");
  await page.getByRole("button", { name: "Add bookmark" }).click();
  await expect(page.getByText("the harbour line")).toBeVisible();

  // Somewhere else, and then back through the bookmark.
  await clickWord(page, first);
  await expect.poll(() => highlighted(page, "lectern-word"), { timeout: 10_000 }).toBe(first.text);

  await page.getByRole("button", { name: "Jump to bookmark 1" }).click();
  await expect.poll(() => highlighted(page, "lectern-word"), { timeout: 10_000 }).toBe(target.text);
});
