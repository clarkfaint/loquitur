/**
 * The tray and the always-on-top mini-player, end to end (F§10.3, F§13 phase 3).
 *
 * These cases drive the built application under a real display. The tray's own entry is what a case can press
 * from outside the app — `emitAction` raises the action that entry raises, in the main process, which is the
 * same trigger the menu sends — and everything else here is read back from the application itself: how many
 * windows exist, whether the mini-player is on top of them, what size it is, and what its own page shows and
 * sends. The reading the last case closes the main window on is real: the hub is the run's own, with F§7.1's
 * mock engine, so a sentence advances in milliseconds rather than in the time a voice would take.
 *
 * Two facts are deliberately read from the mini-player's page rather than from the main process, because the
 * question is what the *page* was handed: whether it shows the reading at all (`F§10.1`'s bus, carried over
 * F§10.3's bridge), and which sentence it is on while the window that owns the audio is hidden.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, _electron as electron, expect, type Page, test } from "@playwright/test";
import { closeApp, connect, emitAction, launchApp, openScreen, shellArguments, shellEnvironment } from "./launch";

/** The document the playback cases read: long enough that the reading outlasts the window it started in. */
const TITLE = "Harbour Light";
const TEXT = Array.from({ length: 24 }, (_unused, index) => `Sentence ${index + 1} of the harbour light drifts past the pier.`).join(" ");

/** The route the mini-player's window loads (F§10.3). */
const MINI_ROUTE = "#/mini";

/** One of the shell's windows, as only the main process can describe it. */
interface WindowFacts {
  url: string;
  alwaysOnTop: boolean;
  contentSize: number[];
  visible: boolean;
  focused: boolean;
  bounds: { x: number; y: number; width: number; height: number };
}

/** Every window of the running shell. */
function windows(app: ElectronApplication): Promise<WindowFacts[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      url: window.webContents.getURL(),
      alwaysOnTop: window.isAlwaysOnTop(),
      contentSize: window.getContentSize(),
      visible: window.isVisible(),
      focused: window.isFocused(),
      bounds: window.getBounds(),
    })),
  );
}

/** The mini-player's window, among them: the one thing no other window of the shell is, always on top. */
async function miniFacts(app: ElectronApplication): Promise<WindowFacts> {
  const found = (await windows(app)).find((facts) => facts.alwaysOnTop);
  if (found === undefined) throw new Error("the shell has no always-on-top window");
  return found;
}

/** The mini-player's page, for the controls the operator would press and the state it paints. */
async function miniPage(app: ElectronApplication): Promise<Page> {
  const main = await app.firstWindow();
  await expect.poll(() => app.windows().length).toBeGreaterThan(1);
  const found = app.windows().find((page) => page !== main);
  if (found === undefined) throw new Error("the shell has no second page");
  return found;
}

/** Close the app's own window (never the mini-player's) from the main process, as its close button does. */
async function closeMainWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    for (const open of BrowserWindow.getAllWindows()) {
      if (!open.isAlwaysOnTop()) open.close();
    }
  });
}

/** Move the mini-player, as a drag would: the shell is expected to remember where it was left. */
async function moveMiniWindow(app: ElectronApplication, at: { x: number; y: number }): Promise<void> {
  await app.evaluate(({ BrowserWindow }, where) => {
    for (const open of BrowserWindow.getAllWindows()) {
      // The strip is the only window of the shell that is always on top, whatever route its page is on.
      if (open.isAlwaysOnTop()) open.setBounds({ x: where.x, y: where.y });
    }
  }, at);
}

/** The shell's own settings record, read from the user-data directory the launch was given. */
async function recordBounds(userData: string): Promise<{ x: number; y: number } | null> {
  try {
    const text = await readFile(join(userData, "desktop-settings.json"), "utf8");
    return (JSON.parse(text) as { miniBounds: { x: number; y: number } | null }).miniBounds;
  } catch {
    return null;
  }
}

/** Import the document through the app's own import screen, one paste (F§10.1). */
async function importDocument(window: Page): Promise<void> {
  await openScreen(window, "#/import");
  await window.getByLabel("Title", { exact: true }).fill(TITLE);
  await window.getByLabel("Text", { exact: true }).fill(TEXT);
  await window.getByRole("button", { name: "Import text" }).click();
  await expect(window.locator("[data-import-item]").last()).toHaveAttribute("data-status", "done");
  await openScreen(window, "#/library");
  await window.getByRole("link", { name: TITLE, exact: true }).click();
  await expect(window).toHaveURL(/#\/read\//u);
}

/** Start the reading, and wait for the state the reader shows while it is running. */
async function startReading(window: Page): Promise<void> {
  await window.getByRole("button", { name: "Play" }).click();
  await expect(window.getByRole("button", { name: "Pause" })).toBeVisible();
}

test("the mini-player is a 360×72 always-on-top strip the toggle shows and hides", async () => {
  const { app } = await launchApp();
  try {
    // A shell nobody has asked anything of has one window.
    expect(await windows(app)).toHaveLength(1);

    await emitAction(app, "toggleMini");
    await expect.poll(async () => (await windows(app)).length).toBe(2);

    const mini = await miniFacts(app);
    expect(mini.alwaysOnTop).toBe(true);
    expect(mini.contentSize).toEqual([360, 72]);
    expect(mini.visible).toBe(true);
    // One window is on top of the others, and it is that one.
    expect((await windows(app)).filter((facts) => facts.alwaysOnTop)).toHaveLength(1);
    // Shown without activating it (F§10.3): the strip never takes the operator's focus.
    expect(mini.focused).toBe(false);

    // The same action takes it away again, and the window is kept rather than destroyed.
    await emitAction(app, "toggleMini");
    await expect.poll(async () => (await miniFacts(app)).visible).toBe(false);
    expect(await windows(app)).toHaveLength(2);

    // ...and shows it again where it was.
    await emitAction(app, "toggleMini");
    await expect.poll(async () => (await miniFacts(app)).visible).toBe(true);
  } finally {
    await closeApp(app);
  }
});

test("the mini-player mirrors the reading, and its own controls drive the window that owns the audio", async () => {
  const { app, window } = await launchApp();
  try {
    await connect(window);
    await importDocument(window);
    await startReading(window);
    await emitAction(app, "toggleMini");
    const mini = await miniPage(app);
    expect(mini.url().endsWith(MINI_ROUTE)).toBe(true);

    // F§10.1's state reaches the other window: the strip paints what the reader published.
    await expect(mini.getByRole("heading", { name: TITLE })).toBeVisible();
    await expect(mini.getByRole("button", { name: "Pause" })).toBeVisible();
    // It is a remote and nothing more: no document, no player, and no audio of its own (F§10.3).
    expect(await mini.evaluate(() => document.querySelectorAll("audio").length)).toBe(0);

    // A control in the strip is a command for the host, which is the only window that plays anything.
    await mini.getByRole("button", { name: "Pause" }).click();
    await expect(window.getByRole("button", { name: "Play" })).toBeVisible();
    await expect(mini.getByRole("button", { name: "Play" })).toBeVisible();

    // The other direction is F§10.3's action bus: the tray's Play entry and a shortcut raise the same action.
    await emitAction(app, "togglePlay");
    await expect(window.getByRole("button", { name: "Pause" })).toBeVisible();
    await expect(mini.getByRole("button", { name: "Pause" })).toBeVisible();
  } finally {
    await closeApp(app);
  }
});

test("the reading outlives the window it started in", async () => {
  const { app, window } = await launchApp();
  try {
    await connect(window);
    await importDocument(window);
    await startReading(window);
    await emitAction(app, "toggleMini");
    const mini = await miniPage(app);
    await expect(mini.getByRole("button", { name: "Pause" })).toBeVisible();

    // What the strip is handed is the reading: record the sentence it is told while the window is closed.
    await mini.evaluate(() => {
      const held = (
        globalThis as { lecternDesktop?: { player: { onSnapshot(cb: (snapshot: { sentenceIndex: number }) => void): () => void } } }
      ).lecternDesktop;
      const seen: number[] = [];
      (globalThis as { lecternSeen?: number[] }).lecternSeen = seen;
      held?.player.onSnapshot((snapshot) => {
        seen.push(snapshot.sentenceIndex);
      });
    });

    // The strip is a remote that opened late, so its first state arrives with the reader's own publish beat.
    const seen = (): Promise<number[]> => mini.evaluate(() => (globalThis as { lecternSeen?: number[] }).lecternSeen ?? []);
    await expect.poll(async () => (await seen()).length, { timeout: 30_000 }).toBeGreaterThan(0);

    await closeMainWindow(app);
    // Closing hides rather than destroys (F§10.3): both windows are still there, one of them is not on screen.
    expect(await windows(app)).toHaveLength(2);
    await expect.poll(async () => (await windows(app)).filter((facts) => facts.visible)).toHaveLength(1);

    const before = (await seen()).at(-1) ?? -1;
    expect(before).toBeGreaterThanOrEqual(0);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const after = (await seen()).at(-1) ?? -1;
    expect(after).toBeGreaterThan(before);
    // The strip is still counting: the window that owns the audio was hidden, not stopped.
    await expect(mini.getByRole("button", { name: "Pause" })).toBeVisible();
  } finally {
    await closeApp(app);
  }
});

test("the mini-player opens where it was last left, across a restart of the shell", async () => {
  const { app, userData } = await launchApp();
  const moved = { x: 40, y: 90 };
  try {
    await emitAction(app, "toggleMini");
    await expect.poll(async () => (await windows(app)).length).toBe(2);
    await miniFacts(app);

    await moveMiniWindow(app, moved);
    // The shell writes F§10.3's `miniBounds` once the move has settled.
    await expect.poll(async () => recordBounds(userData)).toEqual(moved);
  } finally {
    await closeApp(app);
  }

  // A second launch of the same shell: the same user-data directory, so the same record to open with.
  const second = await electron.launch({ args: shellArguments(), env: shellEnvironment(userData) });
  try {
    await second.firstWindow();
    await emitAction(second, "toggleMini");
    await expect.poll(async () => (await windows(second)).length).toBe(2);
    const restored = await miniFacts(second);
    expect({ x: restored.bounds.x, y: restored.bounds.y }).toEqual(moved);
  } finally {
    await closeApp(second);
  }
});
