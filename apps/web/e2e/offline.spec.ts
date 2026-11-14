/**
 * Offline packs and the app shell, end to end (F§10.1, F§13 phase 2).
 *
 * The case below is the whole feature in one run: a document is imported from a real hub, downloaded for
 * offline reading, and then read with the network cut off — both the hub's address refused outright and the
 * browser itself taken offline. What makes it work is that the shell comes back from the service worker's
 * precache and the audio comes back from the app's own `BlobCache`, so nothing about this run needs a socket.
 *
 * Two things are read back from the app rather than restated here. The document's model comes out of the
 * app's own IndexedDB, so the sentence the reader is on is named by the offsets the parser gave it. And the
 * voice the pack was prepared with is the app's own choice — never typed into a form by this file — which is
 * what proves a reader who never picked one still reads offline.
 */

import { expect, type Page, test } from "@playwright/test";
import { connect, importText, testHub } from "./helpers";

/** This case builds a pack over a real hub and then plays it with the network gone, so it is given room. */
test.setTimeout(120_000);

/** The document this spec pastes in: short sentences, so three of them play inside a test's patience. */
const TITLE = "The Lamplighter";
const TEXT = [
  "The lamplighter walks the street.",
  "His ladder rests against the post.",
  "A small flame answers his hand.",
  "The dark keeps its distance.",
  "Morning will find him asleep.",
].join(" ");

/** The database the app keeps its library in, and the store this spec reads a model back from. */
const DB_NAME = "lectern";

/** As much of the stored document as this spec needs: its blocks and their sentences. */
interface StoredSentence {
  index: number;
  text: string;
}
interface StoredBlock {
  sentences: StoredSentence[];
}
interface StoredModel {
  blocks: StoredBlock[];
}

/** Read one record out of the app's own database, by store and key. */
async function readModel(page: Page, docId: string): Promise<StoredModel | null> {
  return page.evaluate(
    (args) =>
      new Promise<StoredModel | null>((resolve, reject) => {
        const request = indexedDB.open(args.db);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const get = db.transaction("models", "readonly").objectStore("models").get(args.docId);
          get.onsuccess = () => resolve((get.result ?? null) as StoredModel | null);
          get.onerror = () => reject(get.error);
        };
      }),
    { db: DB_NAME, docId },
  );
}

/** The sentence highlight's text, as the page sees it. */
async function highlighted(page: Page): Promise<string> {
  return page.evaluate(() => {
    const highlight = CSS.highlights.get("lectern-sentence");
    return highlight === undefined ? "" : [...highlight].map((range) => range.toString()).join("");
  });
}

/** Which sentence the reader is on, resolved from the sentence highlight through the stored model. */
async function activeSentenceIndex(page: Page, docId: string): Promise<number> {
  const model = await readModel(page, docId);
  const text = await highlighted(page);
  if (model === null || text === "") return -1;
  const sentences = model.blocks.flatMap((block) => block.sentences);
  return sentences.find((sentence) => sentence.text === text)?.index ?? -1;
}

test("a document downloaded for offline opens and plays with the network cut off", async ({ page, context }) => {
  await connect(page);
  await importText(page, TITLE, TEXT);
  await page.goto("/#/library");

  const link = page.getByRole("link", { name: TITLE, exact: true });
  const href = await link.getAttribute("href");
  if (href === null) throw new Error("the library did not list the imported document");
  const docId = decodeURIComponent(href.replace("#/read/", ""));

  // F§10.1's "download for offline", driven from the row it belongs to.
  const row = page.locator(`[data-doc-id="${docId}"]`);
  await row.getByRole("button", { name: `Download ${TITLE} for offline` }).click();
  await expect(row.locator("[data-offline]")).toHaveAttribute("data-offline", "complete");

  // The worker that keeps the shell must be active before the network goes away: `ready` is what says its
  // install — the precache of this very build — has finished.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));

  const hub = await testHub();
  const hubOrigin = new URL(hub.baseUrl).origin;
  await context.route(
    (url) => url.origin === hubOrigin,
    (route) => route.abort(),
  );
  await context.setOffline(true);

  await page.reload();

  // The shell came back from the worker, not from the network, and the library is drawn again.
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  await expect(page.locator("h1")).toHaveText("Library");
  await expect(page.getByRole("link", { name: TITLE, exact: true })).toBeVisible();

  await page.getByRole("link", { name: TITLE, exact: true }).click();
  await expect(page).toHaveURL(/#\/read\//);

  await page.getByRole("button", { name: "Play" }).click();
  await expect.poll(() => activeSentenceIndex(page, docId), { timeout: 30_000 }).toBeGreaterThan(2);
  await page.getByRole("button", { name: "Pause" }).click();
});
