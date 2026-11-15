/**
 * Watching a folder, end to end (F§10.3, F§13 phase 3).
 *
 * These cases drive the built application, and they ask the question only a running shell can answer: whether a
 * file that appears in a folder the operator added *really* becomes a document in the library, once, in the
 * folder F§10.3 names, without the shell ever writing to the folder it is reading.
 *
 * Four facts about the shell shape every case, and each was measured before it was written.
 *
 * - **The start-up features need a connection that is already saved.** `apps/web/src/main.tsx` runs
 *   `bootFeatures` only when a hub is in the record, and the subscriber for F§10.3's import hand-off is one of
 *   them — so a folder is watched by a shell that is *restarted* with a saved hub, not by the shell that was
 *   given one during its own session (U-041's finding, filed as a deviation proposal there). Every case
 *   therefore launches twice: once to save the run's hub and to add the folder the way the settings screen adds
 *   one, and once to be watched.
 * - **A file is copied in, and the folder is read the way a reader reads it.** The library screen reads the
 *   library once when it appears, so the case leaves the screen and comes back rather than watching a list that
 *   does not repaint itself; polling that is polling the reader's own view (F§10.1's library route).
 * - **The ledger is the positive signal.** "Nothing was imported the second time" is invisible in a library
 *   that de-duplicates by `docId`, so the case reads the shell's own record: `processedFiles` gains a key for
 *   every *reading* of a file, which is what tells a file that was read again from one that was never read.
 * - **The watched folder is a temporary directory of the run's own**, so nothing an earlier case did can be
 *   inherited and nothing is left behind in the operator's home.
 *
 * The picker is the one thing a case cannot press: `settings.pickFolder()` opens a native dialog, so the folder
 * is added by the write the section makes from the picker's answer — read the record, add the path, write it —
 * and the section itself is then read back from the screen.
 */

import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ElectronApplication, _electron as electron, expect, type Page, test } from "@playwright/test";
import { closeApp, connect, launchApp, openScreen, shellArguments, shellEnvironment } from "./launch";

/** `apps/desktop`, from `apps/desktop/e2e`. */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The committed fixtures a case copies into a folder: the documents the hub is asked to read. */
const FIXTURES = join(PACKAGE_ROOT, "..", "..", "packages", "fixtures", "generated");

/** The folder F§10.3 files a watched file in. */
const INBOX = "Inbox";

/** How long the contract allows between a file appearing and the library holding it. */
const ARRIVAL_TIMEOUT_MS = 30_000;

/** How often the library is re-entered while a file is arriving. */
const POLL_INTERVAL_MS = 500;

/** What the bridge's settings half is, as the page can reach it (F§10.3). */
interface SettingsBridge {
  get(): Promise<{ watchFolders: string[] }>;
  set(patch: { watchFolders: string[] }): Promise<unknown>;
}

/** A folder to watch: the run's own temporary directory, so two cases can never share one. */
async function makeFolder(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "lectern-watched-folder-"));
}

/** The shell's own record, read from the user-data directory the launch was given. */
async function record(userData: string): Promise<{ watchFolders: string[]; processedFiles: string[] }> {
  const text = await readFile(join(userData, "desktop-settings.json"), "utf8");
  return JSON.parse(text) as { watchFolders: string[]; processedFiles: string[] };
}

/** The ledger of every reading of a file the shell has done on its own (F§10.3). */
async function ledger(userData: string): Promise<string[]> {
  return (await record(userData)).processedFiles;
}

/** The digest of a file, so "the shell left it alone" is a fact rather than a hope. */
async function digest(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

/**
 * Add a folder, the way the settings screen adds one once the operator has answered the picker.
 *
 * The answer itself is what the case supplies: F§10.3's bridge writes the path the operator chose into the
 * record, and that write is the whole of what the screen does with it.
 */
async function addWatchFolder(window: Page, folder: string): Promise<void> {
  await window.evaluate(async (path) => {
    const settings = (globalThis as { lecternDesktop?: { settings: SettingsBridge } }).lecternDesktop?.settings;
    if (settings === undefined) throw new Error("the page has no desktop bridge");
    const held = await settings.get();
    await settings.set({ watchFolders: [...held.watchFolders, path] });
  }, folder);
}

/**
 * The documents the library screen shows as filed in `Inbox`, read the way a reader reads them.
 *
 * The screen is left and entered again, because it reads the library once when it appears: that re-entry is
 * what makes a *poll* of this a poll of what the operator would see, rather than of a list that was drawn when
 * the screen first opened. The folder's own id is read from its row, so a document counted here really is one
 * the library has filed under it.
 */
async function filedInInbox(window: Page): Promise<string[]> {
  await openScreen(window, "#/import");
  await openScreen(window, "#/library");
  const inbox = window.locator("li[data-folder-id]").filter({ hasText: INBOX }).first();
  if ((await inbox.count()) === 0) return [];
  const folderId = await inbox.getAttribute("data-folder-id");
  if (folderId === null) return [];
  const filed: string[] = [];
  for (const document of await window.locator("li[data-doc-id]").all()) {
    if ((await document.locator("select").inputValue()) !== folderId) continue;
    const docId = await document.getAttribute("data-doc-id");
    if (docId !== null) filed.push(docId);
  }
  return filed;
}

/** How many documents the library screen shows as filed in `Inbox`. */
async function inboxCount(window: Page): Promise<number> {
  return (await filedInInbox(window)).length;
}

/**
 * A shell that is watched: one launch saves the run's hub and adds `folder`, a second launch starts with both.
 *
 * The second launch is where the case's own work begins, because F§10.1's start-up features — F§10.3's import
 * hand-off among them — run only for a connection that was already saved when the app started. The navigation
 * bar is waited for because those features are registered *during* start-up, before the shell renders: a
 * request pushed to a page that is still starting has no listener to receive it, and a push is not queued.
 */
async function watchedShell(folder: string): Promise<{ app: ElectronApplication; window: Page; userData: string }> {
  const first = await launchApp();
  const userData = first.userData;
  try {
    await connect(first.window);
    await addWatchFolder(first.window, folder);
  } finally {
    await closeApp(first.app);
  }
  const app = await electron.launch({ args: shellArguments(), env: shellEnvironment(userData) });
  const window = await app.firstWindow();
  await expect(window.getByRole("navigation", { name: "Primary" })).toBeVisible();
  return { app, window, userData };
}

/** Wait for the library to hold this many documents in `Inbox`, re-entering the screen as a reader would. */
async function expectInbox(window: Page, count: number): Promise<void> {
  await expect.poll(() => inboxCount(window), { timeout: ARRIVAL_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }).toBe(count);
}

test("a file copied into a watched folder is read once and filed in Inbox", async () => {
  const folder = await makeFolder();
  const partial = join(folder, "x.pdf.part");
  const text = join(folder, "sample.txt");
  const pdf = join(folder, "text.pdf");
  const { app, window, userData } = await watchedShell(folder);
  try {
    // A file that is still being written is in the folder and is not a document. It is copied in *before* the
    // two that are, so the ledger read below is what says the shell looked at it and left it alone.
    await copyFile(join(FIXTURES, "sample.txt"), partial);
    await copyFile(join(FIXTURES, "sample.txt"), text);
    await copyFile(join(FIXTURES, "text.pdf"), pdf);

    // Both files arrive, filed in the folder F§10.3 files a watched file in, within the contract's thirty
    // seconds, and each of them once.
    await expectInbox(window, 2);
    expect(await ledger(userData)).toHaveLength(2);
    expect((await ledger(userData)).filter((key) => key.includes("x.pdf.part"))).toEqual([]);

    // The record says what the shell is reading, and the settings section shows what it reports about each.
    expect((await record(userData)).watchFolders).toContain(folder);
    await openScreen(window, "#/settings");
    await expect(window.locator(`[data-watch-folder="${folder}"]`)).toHaveAttribute("data-state", "watching");

    // Copying the same document in again is a new *reading* of it and not a new document: the ledger takes a
    // third key, and the library still holds the two, because F§5.2's `docId` is the document's identity.
    await copyFile(join(FIXTURES, "sample.txt"), text);
    await expect.poll(async () => (await ledger(userData)).length, { timeout: ARRIVAL_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }).toBe(3);
    await expectInbox(window, 2);

    // Nothing the shell read was written to: both files are byte for byte the fixtures a case copied in, the
    // one it refused included.
    expect(await digest(text)).toBe(await digest(join(FIXTURES, "sample.txt")));
    expect(await digest(pdf)).toBe(await digest(join(FIXTURES, "text.pdf")));
    expect(await digest(partial)).toBe(await digest(join(FIXTURES, "sample.txt")));
  } finally {
    await closeApp(app);
  }
});

test("a restart reads nothing again, and the files it read are untouched", async () => {
  const folder = await makeFolder();
  const text = join(folder, "sample.txt");
  const pdf = join(folder, "text.pdf");
  const first = await watchedShell(folder);
  const userData = first.userData;
  const before = { text: "", pdf: "" };
  try {
    await copyFile(join(FIXTURES, "sample.txt"), text);
    await copyFile(join(FIXTURES, "text.pdf"), pdf);
    await expectInbox(first.window, 2);
    before.text = await digest(text);
    before.pdf = await digest(pdf);
  } finally {
    await closeApp(first.app);
  }
  const read = await ledger(userData);
  expect(read).toHaveLength(2);

  // The same shell again, with the same user-data directory and the same folder.
  const app = await electron.launch({ args: shellArguments(), env: shellEnvironment(userData) });
  const window = await app.firstWindow();
  await expect(window.getByRole("navigation", { name: "Primary" })).toBeVisible();
  try {
    await expectInbox(window, 2);

    // The positive control: a document the shell has never read arrives, so the restarted watcher is
    // demonstrably reading the folder — and the two readings of the files that were already there come first,
    // because one file is read at a time. It is a document of its own rather than another copy of the text:
    // measured, the fixtures' `sample.txt` and `sample.md` carry the *same* `docId` (`cd670b28…`), so a
    // second copy of one of them could not tell a re-import from the `docId` de-duplication F§10.3 also asks
    // for. `article.html` is a document the library has never held (`df93c412…`, §6.1).
    const article = join(folder, "article.html");
    await copyFile(join(FIXTURES, "article.html"), article);
    await expectInbox(window, 3);

    // Three files, three readings, and the two the restart saw again are the two it had already read: the
    // ledger holds each key once and gained nothing but the new document.
    const after = await ledger(userData);
    expect(after).toHaveLength(3);
    expect(after.filter((key) => key.includes("article.html"))).toHaveLength(1);
    for (const key of read) expect(after).toContain(key);

    // And the files the shell read are the fixtures, byte for byte, across a restart.
    expect(await digest(text)).toBe(before.text);
    expect(await digest(pdf)).toBe(before.pdf);
    expect(await digest(article)).toBe(await digest(join(FIXTURES, "article.html")));
  } finally {
    await closeApp(app);
  }
});
