/**
 * Sync, end to end (F§8, F§10.1): two browser contexts against the run's own hub, which is what two devices
 * are.
 *
 * A context is a device because that is where F§5.9's stores live: its own IndexedDB, its own settings, and
 * its own `localStorage`, so neither page can see the other's library except through the hub. Every case
 * therefore starts its two devices from nothing and watches what really travels.
 *
 * What a case reads back, it reads from the app: a document's records come out of the device's own database
 * (the same reader `reader.spec.ts` uses) and the library is asserted through the screen, re-shown by a
 * route change so the store is read again. Nothing here reloads a page to make a change appear — the
 * contract's own word for that is "without a reload" — and nothing here reaches into the app's modules: the
 * only levers are the screens a reader uses and F§10.1's sync switch.
 */

import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { connect, importText } from "./helpers";

/** Syncing has to be waited for, and a case makes two devices first, so the budget is generous. */
test.setTimeout(180_000);

/** The address `vite preview` serves, which is the `baseURL` the config gives the default context. */
function appUrl(): string {
  return (test.info().project.use.baseURL as string | undefined) ?? "http://127.0.0.1:4174";
}

/** The database the app keeps its library in. */
const DB_NAME = "lectern";

/** One device: its own storage, its own page, and the hub the run started. */
interface Device {
  context: BrowserContext;
  page: Page;
}

/** Read one record out of a device's own database, by store and key. */
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

/** A stored document's row, as much of it as a case asserts on. */
interface StoredDocument {
  docId: string;
  title: string;
  deleted?: boolean;
}

/** A stored progress record, as much of it as a case asserts on. */
interface StoredProgress {
  sentenceIndex: number;
  wordIndex: number;
}

/** One device, connected to the run's hub, with its start-up features already run. */
async function openDevice(browser: Browser): Promise<Device> {
  const context = await browser.newContext({ baseURL: appUrl() });
  const page = await context.newPage();
  await connect(page);
  // F§10.1's start-up features run for the connection the page already had, so a device that has just saved
  // one reloads once. Every later step of a case is on a page that has not been reloaded since.
  await page.reload();
  await expect(page.locator(".lectern-shell")).toBeVisible();
  return { context, page };
}

/** Close a device's context, whatever the case decided. */
async function close(device: Device): Promise<void> {
  await device.context.close();
}

/**
 * The library's rows, after the screen has been re-entered so the store is read again. A hash navigation
 * re-mounts the library and re-reads F§5.9's records; nothing here reloads the page.
 */
async function libraryRows(page: Page): Promise<string[]> {
  await page.goto("/#/import");
  await page.goto("/#/library");
  await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
  // Give the screen's own read of the store a moment to land: the heading is drawn before the records are.
  await page.waitForTimeout(250);
  return await page.locator(".lectern-library__document").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-doc-id") ?? ""));
}

/** Whether a device's library holds a document, re-shown while it waits. */
async function libraryHas(page: Page, docId: string, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if ((await libraryRows(page)).includes(docId)) return true;
    if (Date.now() >= until) return false;
    await page.waitForTimeout(250);
  }
}

/** The folders a device's library draws, after the screen has been re-entered. */
async function folderNames(page: Page): Promise<string[]> {
  await page.goto("/#/import");
  await page.goto("/#/library");
  await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
  await page.waitForTimeout(250);
  return await page.locator(".lectern-library__folder-row[data-folder-id]").evaluateAll((rows) => rows.map((row) => row.textContent ?? ""));
}

/** Whether a device's library lists a folder, re-shown while it waits. */
async function folderArrives(page: Page, name: string, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if ((await folderNames(page)).some((text) => text.includes(name))) return true;
    if (Date.now() >= until) return false;
    await page.waitForTimeout(250);
  }
}

/** As much of the stored model as a sentence index needs. */
interface StoredModel {
  blocks: { sentences: { index: number; text: string }[] }[];
}

/** The texts registered under one highlight name, as the page sees them. */
async function highlighted(page: Page, name: string): Promise<string> {
  return page.evaluate((highlightName) => {
    const highlight = CSS.highlights.get(highlightName);
    return highlight === undefined ? "" : [...highlight].map((range) => range.toString()).join("");
  }, name);
}

/** Which sentence the reader is on, resolved from the sentence highlight through the device's own model. */
async function activeSentenceIndex(page: Page, docId: string): Promise<number> {
  const model = await readRecord<StoredModel>(page, "models", docId);
  const text = await highlighted(page, "lectern-sentence");
  if (model === null || text === "") return -1;
  return model.blocks.flatMap((block) => block.sentences).find((sentence) => sentence.text === text)?.index ?? -1;
}

/** Import a document and open it, answering its `docId` as the reader's own address carries it. */
async function importAndOpen(page: Page, title: string, text: string): Promise<string> {
  await importText(page, title, text);
  await page.goto("/#/library");
  await page.getByRole("link", { name: title, exact: true }).click();
  await expect(page).toHaveURL(/#\/read\//);
  const match = /#\/read\/([^?]+)/u.exec(page.url());
  if (match === null || match[1] === undefined) throw new Error(`the reader did not open: ${page.url()}`);
  return decodeURIComponent(match[1]);
}

/** Open the reader's bookmarks panel, whether or not it is already open. */
async function openBookmarks(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: "Bookmarks" });
  // The control is a switch, not an opener: a case that asks twice must not close what it opened.
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(page.getByRole("complementary", { name: "Bookmarks" })).toBeVisible();
}

/** Add a bookmark at the reader's own position, with a note a case can recognise. */
async function addBookmark(page: Page, note: string): Promise<void> {
  await openBookmarks(page);
  await page.getByLabel("Note", { exact: true }).fill(note);
  await page.getByRole("button", { name: "Add bookmark" }).click();
}

/** The bookmarks a device's reader shows for a document, after opening it and its panel. */
async function bookmarkNotes(page: Page, docId: string): Promise<string[]> {
  await page.goto(`/#/read/${docId}`);
  await openBookmarks(page);
  return await page.locator("[data-bookmark-id]").evaluateAll((items) => items.map((item) => item.textContent ?? ""));
}

/** Whether a device's reader shows a bookmark with this note, reopened while it waits. */
async function bookmarkArrives(page: Page, docId: string, note: string, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if ((await bookmarkNotes(page, docId)).some((text) => text.includes(note))) return true;
    if (Date.now() >= until) return false;
    await page.waitForTimeout(300);
  }
}

/**
 * Wait until a device holds *A's own* position for a document — the sentence F§8.2 carries.
 *
 * The reader writes progress while it plays, so a device can pull an earlier position first; waiting for the
 * record to hold the sentence the reading stopped on is what makes the case about the final one.
 */
async function positionArrives(page: Page, docId: string, sentenceIndex: number, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const stored = await readRecord<StoredProgress>(page, "progress", docId);
    if (stored !== null && stored.sentenceIndex === sentenceIndex) return true;
    if (Date.now() >= until) return false;
    await page.waitForTimeout(200);
  }
}

test("a document imported in A appears in B's library", async ({ browser }) => {
  const a = await openDevice(browser);
  const b = await openDevice(browser);
  const title = "Sync import one";
  try {
    // Both devices are running an engine: the badge is drawn from the service's own state.
    await expect(a.page.locator("[data-sync-badge]")).toHaveAttribute("data-sync-badge", "synced", { timeout: 20_000 });
    await expect(b.page.locator("[data-sync-badge]")).toHaveAttribute("data-sync-badge", "synced", { timeout: 20_000 });

    const docId = await importAndOpen(
      a.page,
      title,
      "The tide turns at noon. Boats slip their moorings. A gull calls once. The quay empties.",
    );

    // B never reloads: the library is re-entered until it holds the row.
    expect(await libraryHas(b.page, docId, 10_000)).toBe(true);
    const stored = await readRecord<StoredDocument>(b.page, "documents", docId);
    expect(stored?.title).toBe(title);
  } finally {
    await close(a);
    await close(b);
  }
});

test("a position played in A starts the same sentence in B", async ({ browser }) => {
  const a = await openDevice(browser);
  const b = await openDevice(browser);
  const title = "Sync progress two";
  try {
    const docId = await importAndOpen(
      a.page,
      title,
      [
        "A lamp is lit in the window.",
        "The kettle hums on the stove.",
        "Rain taps the tin roof.",
        "The clock keeps its slow count.",
        "Papers wait on the desk.",
        "Nobody is in a hurry tonight.",
      ].join(" "),
    );

    // A reads, and stops somewhere past the first sentence.
    await a.page.getByRole("button", { name: "Play" }).click();
    await expect
      .poll(async () => await activeSentenceIndex(a.page, docId), { message: "A never reached a second sentence", timeout: 20_000 })
      .toBeGreaterThan(0);
    await a.page.getByRole("button", { name: "Pause" }).click();
    await expect(a.page.getByRole("button", { name: "Play" })).toBeVisible();
    const left = await activeSentenceIndex(a.page, docId);
    expect(left).toBeGreaterThan(0);

    // F§8.2's position arrives as a record of its own, and the sentence it holds is the one A stopped on.
    expect(await positionArrives(b.page, docId, left, 10_000)).toBe(true);

    // B opens the document — its model is F§8.2's lazy body, fetched on this very open — and the restored
    // sentence is the one A stopped on.
    await b.page.goto(`/#/read/${docId}`);
    await expect.poll(async () => await activeSentenceIndex(b.page, docId), { timeout: 20_000 }).toBe(left);
  } finally {
    await close(a);
    await close(b);
  }
});

test("a folder and a bookmark made in B appear in A", async ({ browser }) => {
  const a = await openDevice(browser);
  const b = await openDevice(browser);
  const title = "Sync folder three";
  const folder = "Sync folder three";
  const note = "Sync bookmark three";
  try {
    const docId = await importAndOpen(
      a.page,
      title,
      "Salt air moves through the house. The door stands open. Somebody is sweeping the step. The light is going.",
    );
    expect(await libraryHas(b.page, docId, 10_000)).toBe(true);

    // B files a folder, and marks a place in the document.
    await b.page.goto("/#/library");
    await b.page.getByLabel("New folder", { exact: true }).fill(folder);
    await b.page.getByRole("button", { name: "Create folder" }).click();
    await b.page.goto(`/#/read/${docId}`);
    await addBookmark(b.page, note);

    // A re-shows its library, and its reader, and finds both.
    expect(await folderArrives(a.page, folder, 10_000)).toBe(true);
    expect(await bookmarkArrives(a.page, docId, note, 10_000)).toBe(true);
  } finally {
    await close(a);
    await close(b);
  }
});

test("deleting the document in B removes it from A", async ({ browser }) => {
  const a = await openDevice(browser);
  const b = await openDevice(browser);
  const title = "Sync delete four";
  try {
    const docId = await importAndOpen(
      a.page,
      title,
      "The path runs past the gate. Brambles hold the fence. A dog barks twice. Then the lane is quiet.",
    );
    expect(await libraryHas(b.page, docId, 10_000)).toBe(true);

    await b.page.getByRole("button", { name: `Delete ${title}`, exact: true }).click();
    await b.page.getByRole("button", { name: `Confirm delete ${title}`, exact: true }).click();

    // F§5.9's delete is a tombstone, so the record itself is what A is left with.
    await expect
      .poll(async () => (await readRecord<StoredDocument>(a.page, "documents", docId))?.deleted ?? false, { timeout: 10_000 })
      .toBe(true);
    expect((await libraryRows(a.page)).includes(docId)).toBe(false);
  } finally {
    await close(a);
    await close(b);
  }
});

test("an import and a bookmark made while A cannot sync reach B when it can again", async ({ browser }) => {
  const a = await openDevice(browser);
  const b = await openDevice(browser);
  const title = "Sync offline five";
  const note = "Sync bookmark five";
  try {
    // A's half of F§8 is unreachable: the hub's own sync routes refuse, while its parse route still answers,
    // which is what a reader who has lost their link to the hub is left with. The engine notices on the next
    // round, which the import below is what asks for.
    await a.context.route(/\/v1\/sync\//u, (route) => route.abort());

    const docId = await importAndOpen(
      a.page,
      title,
      "Frost holds the field at dawn. The gate is stiff with ice. A crow walks the ridge. Nothing else moves.",
    );
    await addBookmark(a.page, note);
    await expect(a.page.locator("[data-sync-badge]")).toHaveAttribute("data-sync-badge", "offline", { timeout: 20_000 });

    // Nothing A wrote has left the device.
    await a.page.waitForTimeout(3000);
    expect((await libraryRows(b.page)).includes(docId)).toBe(false);

    // A is reachable again, and its own devices catch up without anything being pressed.
    await a.context.unroute(/\/v1\/sync\//u);
    expect(await libraryHas(b.page, docId, 10_000)).toBe(true);
    expect(await bookmarkArrives(b.page, docId, note, 10_000)).toBe(true);
  } finally {
    await close(a);
    await close(b);
  }
});

test("an import made with sync switched off never reaches B", async ({ browser }) => {
  const a = await openDevice(browser);
  const b = await openDevice(browser);
  const title = "Sync disabled six";
  try {
    await a.page.goto("/#/settings");
    await a.page.getByLabel("Sync this device with the hub", { exact: true }).uncheck();
    // Nothing is syncing on this device, so the badge is gone and the section says so.
    await expect(a.page.locator("[data-sync-badge]")).toHaveCount(0);
    await expect(a.page.locator("[data-sync-state]")).toHaveAttribute("data-sync-state", "off");

    const docId = await importAndOpen(
      a.page,
      title,
      "The mill wheel is still. Moss fills the channel. Swallows cross the yard. The day is warm and slow.",
    );

    // B is running an engine, so this is the switch that kept it away and not a device that never synced.
    await expect(b.page.locator("[data-sync-badge]")).toHaveAttribute("data-sync-badge", "synced", { timeout: 20_000 });
    await a.page.waitForTimeout(4000);
    expect((await libraryRows(b.page)).includes(docId)).toBe(false);
    expect(await readRecord<StoredDocument>(b.page, "documents", docId)).toBeNull();
  } finally {
    await close(a);
    await close(b);
  }
});
