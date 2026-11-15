/**
 * Reading the operating system's selection, end to end (F§10.3, F§13 phase 3).
 *
 * These cases drive the built application under a real display, and what they ask is the question only a
 * running shell can answer: whether the text the operating system holds for the *selection* really reaches the
 * reader and comes back out as a played document, filed where F§10.3 says it is filed. So the selection is put
 * there the way an application puts it there — through Electron's own clipboard, from the main process — the
 * trigger is raised on the shell's own action bus (`emitAction`, the same call a shortcut makes), and every
 * assertion is read from the pages the operator would be looking at.
 *
 * Two facts about this host shape the cases, both measured before they were written. A selection does not
 * outlive the process that wrote it, so a case can never inherit the previous case's text — which is also why
 * the empty case clears the selection itself rather than trusting a fresh X server. And the desktop this runs
 * under has no notification service, while `Notification.isSupported()` answers `true`, so the notification is
 * what the shell *asked for*: `show()` is replaced in the main process, exactly as U-038's navigation case
 * replaces the OS hand-off, and the shell's own `new Notification(...)` is what is recorded.
 */

import { type ElectronApplication, _electron as electron, expect, type Page, test } from "@playwright/test";
import { closeApp, connect, emitAction, launchApp, openScreen, shellArguments, shellEnvironment } from "./launch";

/** The three sentences the case puts on the primary selection (F§10.3's own example of what a selection is). */
const SENTENCES = ["The morning ferry waits at the pier.", "Gulls circle above it.", "Nobody is in a hurry yet."];

/** What the selection holds. The first two sentences are 59 characters together, so the cap falls on a space. */
const TEXT = SENTENCES.join(" ");

/** How much of the text F§10.3 makes the document's title. */
const TITLE_CHARS = 60;

/** The folder F§10.3 files a selection in. */
const QUICK_READS = "Quick reads";

/** One window of the shell, as only the main process can describe it. */
interface WindowFacts {
  alwaysOnTop: boolean;
  visible: boolean;
}

/** Fold a string the way a page renders one: every run of whitespace is a single space, and the ends are trim. */
function collapsed(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** Every window of the running shell. */
function windows(app: ElectronApplication): Promise<WindowFacts[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({ alwaysOnTop: window.isAlwaysOnTop(), visible: window.isVisible() })),
  );
}

/** Whether the mini-player's strip is on the screen: the one window of the shell that is always on top. */
async function stripVisible(app: ElectronApplication): Promise<boolean> {
  const strip = (await windows(app)).find((facts) => facts.alwaysOnTop);
  return strip?.visible ?? false;
}

/** The mini-player's page, for the state it was handed (F§10.1's remote). */
async function stripPage(app: ElectronApplication): Promise<Page> {
  const main = await app.firstWindow();
  await expect.poll(() => app.windows().length).toBeGreaterThan(1);
  const found = app.windows().find((page) => page !== main);
  if (found === undefined) throw new Error("the shell has no second page");
  return found;
}

/** Every state the shell published over F§10.3's bridge, in the main window's own page. */
function states(window: Page): Promise<string[]> {
  return window.evaluate(() => (globalThis as { lecternStates?: string[] }).lecternStates ?? []);
}

/** Subscribe to the published player state, as the reader's own player bar does. */
async function recordStates(window: Page): Promise<void> {
  await window.evaluate(() => {
    const seen: string[] = [];
    (globalThis as { lecternStates?: string[] }).lecternStates = seen;
    const bridge = (globalThis as { lecternDesktop?: { player: { onSnapshot(cb: (snapshot: { state: string }) => void): () => void } } })
      .lecternDesktop;
    bridge?.player.onSnapshot((snapshot) => {
      seen.push(snapshot.state);
    });
  });
}

/** Put text on the primary selection, from the main process, the way another application would. */
async function select(app: ElectronApplication, text: string): Promise<void> {
  await app.evaluate(({ clipboard }, held) => clipboard.selection.writeText(held), text);
}

/** Record the notifications the shell shows, in place of a desktop that has no notification service. */
async function recordNotifications(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Notification }) => {
    const shown: { title: string; body: string }[] = [];
    (globalThis as { lecternNotifications?: { title: string; body: string }[] }).lecternNotifications = shown;
    Notification.prototype.show = function (this: { title: string; body: string }): void {
      shown.push({ title: this.title, body: this.body });
    } as () => void;
  });
}

/** What the shell has shown so far. */
function notifications(app: ElectronApplication): Promise<{ title: string; body: string }[]> {
  return app.evaluate(() => (globalThis as { lecternNotifications?: { title: string; body: string }[] }).lecternNotifications ?? []);
}

/**
 * A shell that is *configured*: one launch saves the run's hub, a second launch starts with it.
 *
 * F§10.1's start-up features run only for a connection that is already saved when the app starts, and the
 * desktop bridge's hand-offs are one of them (`apps/web/src/main.tsx` runs `bootFeatures` only when the saved
 * hub is not empty). A shell that is given a hub *during* its own session therefore has no bridge hand-offs
 * until it is started again — which is how an operator's shell ends up configured too, on the run after they
 * first saved a hub. The unit's evidence files that gating as a deviation proposal; the case works with it
 * rather than around it.
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

test("the selection is read, played and filed in Quick reads", async () => {
  const { app, window } = await configuredShell();
  try {
    await recordStates(window);
    await select(app, TEXT);

    await emitAction(app, "readSelection");

    // The app's own pipeline read the text: the reader is on a document of its own.
    await expect(window).toHaveURL(/#\/read\//u, { timeout: 15_000 });
    // ...and it is playing, which is the state the shell publishes for every remote (F§10.3's bus).
    await expect.poll(() => states(window), { timeout: 15_000 }).toContain("playing");

    // The strip comes up with the reading (F§10.3): a selection is read while the operator is somewhere else.
    await expect.poll(() => stripVisible(app), { timeout: 15_000 }).toBe(true);
    // It is a remote and nothing more, and what it was handed is this document.
    const strip = await stripPage(app);
    await expect(strip.getByRole("heading", { name: collapsed(TEXT.slice(0, TITLE_CHARS)) })).toBeVisible({ timeout: 15_000 });

    // The library holds exactly one document, and it is filed in the folder F§10.3 files selections in.
    await openScreen(window, "#/library");
    const documents = window.locator("li[data-doc-id]");
    await expect(documents).toHaveCount(1);
    const quickReads = window.locator("li[data-folder-id]").filter({ hasText: QUICK_READS });
    await expect(quickReads).toHaveCount(1);
    expect(await documents.first().locator("select").inputValue()).toBe(await quickReads.first().getAttribute("data-folder-id"));
    // The document is the selection, named by its first sixty characters and nothing else.
    expect(collapsed((await documents.first().locator("a").first().textContent()) ?? "")).toBe(collapsed(TEXT.slice(0, TITLE_CHARS)));
  } finally {
    await closeApp(app);
  }
});

test("an empty selection is reported, and no document is created", async () => {
  const { app, window } = await configuredShell();
  try {
    await recordNotifications(app);
    // Nothing is selected: the X server is shared by the whole run, so the selection is cleared explicitly.
    await app.evaluate(({ clipboard }) => {
      clipboard.selection.clear();
    });
    const before = window.url();

    await emitAction(app, "readSelection");

    // One notification carries the reason, and it is the only thing that happened: no document, no strip, and
    // the window never left for a reader.
    await expect.poll(() => notifications(app), { timeout: 15_000 }).toHaveLength(1);
    const shown = await notifications(app);
    expect(shown[0]?.title).not.toBe("");
    expect(shown[0]?.body).not.toBe("");
    expect(await stripVisible(app)).toBe(false);
    expect(await windows(app)).toHaveLength(1);
    expect(window.url()).toBe(before);

    await openScreen(window, "#/library");
    await expect(window.locator("li[data-doc-id]")).toHaveCount(0);
  } finally {
    await closeApp(app);
  }
});
