/**
 * Reading a region of the screen, end to end (F§10.3, F§13 phase 3).
 *
 * This is the one test of the region reader's *wiring*: whether a trigger really puts a dimmed window over the
 * display, whether a drag in that window really reaches `desktopCapturer`, and whether the pixels it crops really
 * become a document in `Quick reads` — through the real hub, its real import pipeline and F§5.5's real OCR
 * engine, since the shell is forbidden to recognise anything itself. So the fixture is put on the screen the way
 * an operator puts a document there (the app's own import screen), the text it carries is drawn by the app's own
 * reader in the app's own heading type, the trigger is raised on the shell's own action bus (`emitAction`, the
 * call the `Ctrl+Alt+S` hotkey makes), and the drag is a real mouse drag in the overlay's own page.
 *
 * Three facts about this host shape the cases, and all three were measured before they were written (the
 * evidence file's §6.1):
 *
 * - **The screen really is on the screen.** Under `xvfb-run` this host has one X screen, `desktopCapturer`
 *   reports it with a matching `display_id`, and a window's rendered text is in the capture — which is what makes
 *   "read this region" a testable claim here at all. The Wayland path is a system picker and is not verified.
 * - **A shell is *configured* only from its second launch.** F§10.1 runs the app's start-up features only for a
 *   connection saved before start-up, and the bridge's import hand-off is one of them (`apps/web/src/main.tsx`),
 *   so a case that drives a hand-off launches the shell twice — the pattern U-041's cases established, and the
 *   one the evidence files as a deviation proposal.
 * - **The heading's place on the screen is measured, not assumed.** The case reads the heading's box out of the
 *   page and adds the main window's content origin, so the drag covers the heading wherever the window happens
 *   to be, instead of a rectangle that only holds at one window size.
 */

import { type ElectronApplication, _electron as electron, expect, type Page, test } from "@playwright/test";
import { closeApp, connect, emitAction, launchApp, openScreen, shellArguments, shellEnvironment } from "./launch";

/** The fixture's title, and the heading the case draws in the reader's own heading type. */
const TITLE = "Region probe";

/** The fixture's text. The first line is a Markdown heading, which is what F§5.4's text row makes of `#`. */
const TEXT = ["# Region probe", "", "A region of the screen is handed to the hub to be read."].join("\n");

/** The folder F§10.3 files a screen region in. */
const QUICK_READS = "Quick reads";

/** How much room the drag leaves around the heading's own box, so the crop holds the whole word. */
const CROP_MARGIN = 10;

/** The time the contract gives the whole hand-off, from the drag to the document. */
const HAND_OFF_TIMEOUT_MS = 60_000;

/** One document, as the library's own list draws it. */
interface LibraryRow {
  docId: string | null;
  folderId: string | null;
  title: string;
}

/** A rectangle in the display's own device-independent pixels: where the drag's coordinates are measured from. */
interface DisplayBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How many windows the shell has open. */
function windowCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
}

/** The mini-player's strip, in the height U-039 gives it; the region overlay is the size of a whole display. */
const MINI_STRIP_HEIGHT = 72;

/** The packaged overlay page's own address: what identifies the overlay's window among the shell's windows. */
const OVERLAY_PAGE_SUFFIX = "overlay/index.html";

/**
 * Whether the region overlay is on the screen: the shell's visible, always-on-top window that is not the
 * mini-player's strip. Both of the shell's extra windows are always on top, and the strip is 72 px of content
 * where a display is not — the same distinction the deliverable itself draws.
 */
function overlayIsUp(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(
    ({ BrowserWindow }, stripHeight) =>
      BrowserWindow.getAllWindows().some(
        (window) => !window.isDestroyed() && window.isVisible() && window.isAlwaysOnTop() && window.getContentSize()[1] > stripHeight,
      ),
    MINI_STRIP_HEIGHT,
  );
}

/** Whether the mini-player's strip is on the screen: the shell's always-on-top window that is that small. */
function miniIsUp(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(
    ({ BrowserWindow }, stripHeight) =>
      BrowserWindow.getAllWindows().some(
        (window) => !window.isDestroyed() && window.isVisible() && window.isAlwaysOnTop() && window.getContentSize()[1] <= stripHeight,
      ),
    MINI_STRIP_HEIGHT,
  );
}

/** The primary display, as the drag needs it. */
function displayBox(app: ElectronApplication): Promise<DisplayBox> {
  return app.evaluate(({ screen }) => {
    const { bounds } = screen.getPrimaryDisplay();
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  });
}

/** The document a reader address names, or `null` when the window is not on a reader. */
function readerDocId(url: string): string | null {
  const match = /#\/read\/([^?]+)/u.exec(url);
  return match === null ? null : decodeURIComponent(match[1] ?? "");
}

/** Every document the library's own list holds, with the folder each is filed in. */
async function libraryRows(window: Page): Promise<LibraryRow[]> {
  return await window.evaluate(() =>
    [...document.querySelectorAll("li[data-doc-id]")].map((row) => {
      // The row's own folder picker: `""` is the "No folder" option, which is the absence of a folder.
      const chosen = (row.querySelector("select") as HTMLSelectElement | null)?.value ?? "";
      return {
        docId: row.getAttribute("data-doc-id"),
        folderId: chosen === "" ? null : chosen,
        title: (row.querySelector("a")?.textContent ?? "").trim(),
      };
    }),
  );
}

/** The library's own folder list, by id and name. */
async function libraryFolders(window: Page): Promise<{ id: string | null; name: string }[]> {
  return await window.evaluate(() =>
    [...document.querySelectorAll("li[data-folder-id]")].map((row) => ({
      id: row.getAttribute("data-folder-id"),
      name: (row.querySelector("button")?.textContent ?? "").trim(),
    })),
  );
}

/**
 * A shell that is *configured*: one launch saves the run's hub, a second launch starts with it.
 *
 * This is U-041's own helper, and it exists for the same reason: the app's start-up features — the bridge's
 * hand-offs among them — run only for a connection that is already saved when the app starts, so a shell
 * configured during its own session has nothing subscribed to the shell's import request. An operator's shell is
 * configured from their second run on; the evidence files the gating as a deviation proposal.
 *
 * The navigation bar is waited for because those features are registered *during* start-up, before the shell
 * renders: a request pushed to a page that is still starting has no listener to receive it — an `ipcRenderer`
 * push is not queued — so a case that asks too early asks nothing at all.
 */
async function configuredShell(): Promise<{ app: ElectronApplication; window: Page; userData: string }> {
  const first = await launchApp();
  const userData = first.userData;
  try {
    await connect(first.window);
  } finally {
    await closeApp(first.app);
  }
  const app = await electron.launch({ args: shellArguments(), env: shellEnvironment(userData) });
  const window = await app.firstWindow();
  await expect(window.getByRole("navigation", { name: "Primary" })).toBeVisible();
  return { app, window, userData };
}

/** Put the fixture in the library through the app's own import screen (F§10.1). */
async function importFixture(window: Page): Promise<void> {
  await openScreen(window, "#/import");
  await window.getByLabel("Title", { exact: true }).fill(TITLE);
  await window.getByLabel("Text", { exact: true }).fill(TEXT);
  await window.getByRole("button", { name: "Import text" }).click();
  await expect(window.locator("[data-import-item]").last()).toHaveAttribute("data-status", "done");
}

/**
 * Open the fixture in the reader, fill the display with it, and answer the heading's box *on the display*.
 *
 * The window is maximized because this case is about a region of the screen rather than about a window: the
 * heading should be where an operator reading it would have it. `maximize()` is what the contract says, and it
 * is the desktop's window manager that honours it; the heading's box is measured either way, so the drag
 * follows the window rather than presuming its size.
 */
async function openFixtureMaximized(app: ElectronApplication, window: Page): Promise<DisplayBox> {
  await openScreen(window, "#/library");
  await window.getByRole("link", { name: TITLE, exact: true }).click();
  await expect(window).toHaveURL(/#\/read\//u);

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.maximize();
  });

  const heading = await window.locator("article h1").first().boundingBox();
  if (heading === null) throw new Error("the reader has no heading to read");
  const origin = await app.evaluate(({ BrowserWindow }) => {
    const bounds = BrowserWindow.getAllWindows()[0]?.getContentBounds();
    return bounds === undefined ? null : { x: bounds.x, y: bounds.y };
  });
  if (origin === null) throw new Error("the shell has no main window to read from");
  return { x: heading.x + origin.x, y: heading.y + origin.y, width: heading.width, height: heading.height };
}

/** The overlay's own page: the window the shell opens over the display, once it is really usable. */
async function overlayPage(app: ElectronApplication): Promise<Page> {
  await expect.poll(() => overlayIsUp(app), { timeout: 15_000 }).toBe(true);
  // The overlay is picked out by its own address rather than by being "the other page": with the mini-player's
  // strip up, the shell has three windows, and only one of them is the packaged overlay page (U-039's lesson was
  // that a *route* of the app cannot identify a window; a file of the overlay can).
  await expect.poll(() => app.windows().some((page) => page.url().endsWith(OVERLAY_PAGE_SUFFIX)), { timeout: 15_000 }).toBe(true);
  const found = app.windows().find((page) => page.url().endsWith(OVERLAY_PAGE_SUFFIX));
  if (found === undefined) throw new Error("the shell opened no overlay page");
  // The drag and the `Esc` are the page's own listeners (`resources/overlay/overlay.js`), and both are installed
  // by the time its document has loaded — a page is in `app.windows()` before that.
  await found.waitForLoadState("domcontentloaded");
  return found;
}

/** The library's own list, once it has drawn at least one document. */
async function libraryReady(window: Page): Promise<void> {
  await expect(window.locator("li[data-doc-id]").first()).toBeVisible();
}

/** Drag out a rectangle in the overlay's page, in the coordinates that page's own viewport uses. */
async function dragRegion(overlay: Page, display: DisplayBox, heading: DisplayBox): Promise<void> {
  const from = { x: heading.x - CROP_MARGIN - display.x, y: heading.y - CROP_MARGIN - display.y };
  const to = { x: heading.x + heading.width + CROP_MARGIN - display.x, y: heading.y + heading.height + CROP_MARGIN - display.y };
  await overlay.mouse.move(from.x, from.y);
  await overlay.mouse.down();
  await overlay.mouse.move(to.x, to.y, { steps: 8 });
  await overlay.mouse.up();
}

/** The library's `Quick reads` folder, or `null` when the library has no folder of that name. */
async function quickReadsFolder(window: Page): Promise<string | null> {
  const folders = await libraryFolders(window);
  return folders.find((folder) => folder.name === QUICK_READS)?.id ?? null;
}

test("a dragged region is captured, read by the hub and filed in Quick reads", async () => {
  const { app, window } = await configuredShell();
  try {
    await importFixture(window);
    const heading = await openFixtureMaximized(app, window);
    const display = await displayBox(app);
    const fixtureDocId = readerDocId(window.url());

    await emitAction(app, "readRegion");
    const overlay = await overlayPage(app);
    await dragRegion(overlay, display, heading);

    // The overlay is gone: the screen is the app's own again, which is also what the capture depends on.
    await expect.poll(() => overlayIsUp(app), { timeout: 15_000 }).toBe(false);
    await expect.poll(() => windowCount(app)).toBe(1);

    // The app's own pipeline read the crop, so the reader is on a document that is not the fixture. The hub is
    // asked to recognise the PNG, so this waits for real OCR rather than for a file to appear (the contract's
    // 60 seconds).
    await expect.poll(() => readerDocId(window.url()), { timeout: HAND_OFF_TIMEOUT_MS }).not.toBe(fixtureDocId);
    const readDocId = readerDocId(window.url());
    if (readDocId === null) throw new Error("the shell read a region without opening a document");

    // It is filed in the folder F§10.3 files screen regions in, and it is the only document in any folder — the
    // fixture the case imported stays unfiled.
    await openScreen(window, "#/library");
    await libraryReady(window);
    const rows = await libraryRows(window);
    expect(rows.filter((row) => row.folderId !== null).map((row) => row.docId)).toEqual([readDocId]);
    const quickReads = await quickReadsFolder(window);
    if (quickReads === null) throw new Error("the library has no Quick reads folder");
    expect(rows.find((row) => row.docId === readDocId)?.folderId).toBe(quickReads);

    // The document's own text is the region that was drawn: the heading, read off the screen by the hub's OCR.
    await openScreen(window, `#/read/${encodeURIComponent(readDocId)}`);
    await expect.poll(() => window.locator("article").textContent(), { timeout: 30_000 }).toMatch(/region|probe/iu);
  } finally {
    await closeApp(app);
  }
});

test("Esc cancels the selection: nothing is captured, and no document is created", async () => {
  const { app, window } = await configuredShell();
  try {
    await importFixture(window);
    await openFixtureMaximized(app, window);
    const before = readerDocId(window.url());

    await emitAction(app, "readRegion");
    const overlay = await overlayPage(app);
    // `Escape` is pressed and never released, and that is deliberate: the page's own handler cancels the
    // selection as the key goes down and the shell destroys the window with it, so the key-*up* would be
    // delivered to a window that is already gone (measured: Playwright's `press` throws "Target page, context or
    // browser has been closed" on the release, with the overlay already cancelled by the press itself).
    await overlay.keyboard.down("Escape");

    // The overlay answers `null` (F§10.3) and nothing else happens: no capture, no import request, the reader
    // stays where it was, and the shell is back to its one window.
    await expect.poll(() => overlayIsUp(app), { timeout: 15_000 }).toBe(false);
    await expect.poll(() => windowCount(app)).toBe(1);
    expect(readerDocId(window.url())).toBe(before);

    // The library still holds the fixture alone, and nothing is filed in `Quick reads` — whether the folder was
    // made at all is not what is being asserted: nothing was read into it.
    await openScreen(window, "#/library");
    await libraryReady(window);
    const rows = await libraryRows(window);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe(TITLE);
    const quickReads = await quickReadsFolder(window);
    expect(rows.filter((row) => row.folderId !== null && row.folderId === quickReads)).toHaveLength(0);
  } finally {
    await closeApp(app);
  }
});

test("the mini-player is out of the frame while a region is being selected, and back afterwards", async () => {
  const { app, window } = await configuredShell();
  try {
    await importFixture(window);
    const heading = await openFixtureMaximized(app, window);
    const display = await displayBox(app);

    // The strip is brought up first (F§10.3's `toggleMini`, U-039's own trigger): it is the window a screen
    // capture must not photograph, because it would end up inside the region's own text.
    await emitAction(app, "toggleMini");
    await expect.poll(() => miniIsUp(app), { timeout: 15_000 }).toBe(true);

    await emitAction(app, "readRegion");
    const overlay = await overlayPage(app);
    // While the shell is asking for a region, the strip is off the screen — the overlay is the only extra window
    // up, which is what the hidden-strip branch of the handler exists for.
    await expect.poll(() => miniIsUp(app)).toBe(false);

    await dragRegion(overlay, display, heading);

    // ...and it is back once the region has been handed over, with the shell on the document that was read.
    await expect.poll(() => overlayIsUp(app), { timeout: 15_000 }).toBe(false);
    await expect.poll(() => miniIsUp(app), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => readerDocId(window.url()), { timeout: HAND_OFF_TIMEOUT_MS }).not.toBeNull();
  } finally {
    await closeApp(app);
  }
});
