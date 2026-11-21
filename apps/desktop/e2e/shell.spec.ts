/**
 * The shell, end to end (F§10.3, F§13 phase 3).
 *
 * These cases drive the built application under a real display: the app's own page loaded from disk, the bridge
 * the preload exposes to it, the import pipeline over HTTP to a real hub, playback, the window's own close
 * behaviour, and a second launch of the same shell. Facts only the main process knows — the window list, a
 * navigation the page asked for — are read back from the main process with `app.evaluate`, and facts the reader
 * can see are read from the page, so nothing here restates what the app could answer for itself.
 */

import { spawnSync } from "node:child_process";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { closeApp, connect, electronPath, emitAction, launchApp, openScreen, secondLaunchArguments } from "./launch";

/** The document this spec pastes in: short sentences, so it plays inside a case's patience. */
const TITLE = "Morning Ferry";
const TEXT = ["The morning ferry waits. Gulls circle the pier.", "Nobody is in a hurry yet."].join(" ");

/** How many windows the shell has open. */
function windowCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
}

/** Whether the first window is on the screen. */
function firstWindowIsVisible(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false);
}

/** What the page's own bridge reports: which platform, and how many members the shell exposed. */
function bridgeShape(page: Page): Promise<{ platform: string | null; members: number }> {
  return page.evaluate(() => {
    const held = (globalThis as { lecternDesktop?: Record<string, unknown> }).lecternDesktop;
    return { platform: (held?.["platform"] as string | undefined) ?? null, members: held === undefined ? 0 : Object.keys(held).length };
  });
}

test("the window is the app's own page, and the renderer carries no Node", async () => {
  const { app, window } = await launchApp();
  try {
    expect(await window.title()).toBe("Loquitur");
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle())).toBe("Loquitur");

    const bridge = await bridgeShape(window);
    // F§10.3's union has two members; the shell is built for Linux and Windows.
    expect(["linux", "win32"]).toContain(bridge.platform);
    // The bridge is the whole of what the page was given: F§10.3's seven members.
    expect(bridge.members).toBe(7);

    // F§11: the page is a browser page. It cannot reach Node, and it cannot reach Electron either.
    expect(
      await window.evaluate(() => ({
        require: typeof (globalThis as { require?: unknown }).require,
        process: typeof (globalThis as { process?: unknown }).process,
        electron: typeof (globalThis as { electron?: unknown }).electron,
      })),
    ).toEqual({ require: "undefined", process: "undefined", electron: "undefined" });
  } finally {
    await closeApp(app);
  }
});

test("a navigation off the app's own files is refused", async () => {
  const { app, window } = await launchApp();
  try {
    const before = await window.evaluate(() => window.location.href);

    // The OS hand-off is replaced here, because it is the one step of this path a test cannot observe and must
    // not perform: on a host with no browser, `xdg-open` starts one that never returns, and the browser it
    // leaves behind holds the run's own pipes open. What F§11 promises is that the shell *hands the address
    // over* and refuses the navigation, and both halves are recorded — the guard, in the main process, and the
    // addresses that really reached the operating system.
    const stubbed = await app.evaluate(({ shell }) => {
      const handed: string[] = [];
      (globalThis as { lecternExternals?: string[] }).lecternExternals = handed;
      shell.openExternal = (url) => {
        handed.push(String(url));
        return Promise.resolve();
      };
      return typeof shell.openExternal;
    });
    expect(stubbed).toBe("function");

    // Every navigation the page asks for, recorded in the main process — the place the guard judges it.
    await app.evaluate(({ BrowserWindow }) => {
      const asked: string[] = [];
      (globalThis as { lecternNavigations?: string[] }).lecternNavigations = asked;
      for (const open of BrowserWindow.getAllWindows()) {
        open.webContents.on("will-navigate", (event, url) => {
          asked.push(`${url} prevented=${String(event.defaultPrevented)}`);
        });
      }
    });

    // The attempt is made on the next turn of the loop, so the call that makes it has already returned.
    const navigateTo = async (target: string): Promise<void> => {
      await window.evaluate((address) => {
        setTimeout(() => {
          window.location.href = address;
        }, 0);
      }, target);
      await expect
        .poll(() => app.evaluate(() => (globalThis as { lecternNavigations?: string[] }).lecternNavigations ?? []))
        .toContain(`${target} prevented=true`);
    };

    await navigateTo("https://example.org/");

    // F§11: an `http:` link is the operator's browser's business, so the address really was handed over...
    await expect
      .poll(() => app.evaluate(() => (globalThis as { lecternExternals?: string[] }).lecternExternals ?? []))
      .toEqual(["https://example.org/"]);

    // ...and every other scheme is dropped rather than opened, while the navigation is refused just the same.
    await navigateTo("file:///tmp/lectern-is-not-this-page.txt");
    expect(await app.evaluate(() => (globalThis as { lecternExternals?: string[] }).lecternExternals ?? [])).toEqual([
      "https://example.org/",
    ]);

    // The page never left the app: same address, same document, and still one window.
    expect(await window.evaluate(() => window.location.href)).toBe(before);
    expect(await window.evaluate(() => document.title)).toBe("Loquitur");
    expect(await windowCount(app)).toBe(1);
  } finally {
    await closeApp(app);
  }
});

test("importing text and pressing play reaches the playing state", async () => {
  const { app, window } = await launchApp();
  try {
    await connect(window);

    // Every state the shell hands a renderer over F§10.3's bridge. The reader that is on screen is the host,
    // so what it publishes leaves through the bridge and comes back through it; subscribing to the bridge is
    // therefore reading the round trip the shell really performs, not a copy of the app's own state.
    await window.evaluate(() => {
      const states: string[] = [];
      (globalThis as { lecternStates?: string[] }).lecternStates = states;
      const bridge = (globalThis as { lecternDesktop?: { player: { onSnapshot(cb: (snapshot: { state: string }) => void): () => void } } })
        .lecternDesktop;
      bridge?.player.onSnapshot((snapshot) => {
        states.push(snapshot.state);
      });
    });

    await openScreen(window, "#/import");
    await window.getByLabel("Title", { exact: true }).fill(TITLE);
    await window.getByLabel("Text", { exact: true }).fill(TEXT);
    await window.getByRole("button", { name: "Import text" }).click();
    await expect(window.locator("[data-import-item]").last()).toHaveAttribute("data-status", "done");

    await openScreen(window, "#/library");
    await window.getByRole("link", { name: TITLE, exact: true }).click();
    await expect(window).toHaveURL(/#\/read\//u);

    await window.getByRole("button", { name: "Play" }).click();
    // The transport control is the reader's own account of the state...
    await expect(window.getByRole("button", { name: "Pause" })).toBeVisible();
    // ...and the state itself is what the shell published over the bridge for every remote view (F§10.3).
    await expect
      .poll(() => window.evaluate(() => (globalThis as { lecternStates?: string[] }).lecternStates ?? []), {
        timeout: 60_000,
      })
      .toContain("playing");
  } finally {
    await closeApp(app);
  }
});

test("closing hides the window, an action brings it back, and a second launch exits", async () => {
  const { app, window, userData } = await launchApp();
  try {
    await expect.poll(() => firstWindowIsVisible(app)).toBe(true);

    // Closing is not destroying: playback outlives the window (F§10.3).
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await expect.poll(() => firstWindowIsVisible(app)).toBe(false);
    expect(await windowCount(app)).toBe(1);

    // The bus reaches the window: `showMain` is the action the shell's own triggers raise (F§10.3).
    await emitAction(app, "showMain");
    await expect.poll(() => firstWindowIsVisible(app)).toBe(true);

    // A second launch of the same shell is a request to see it: that process exits, and this window comes back
    // up (F§10.3's single-instance lock).
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await expect.poll(() => firstWindowIsVisible(app)).toBe(false);

    const second = spawnSync(electronPath(), secondLaunchArguments(), {
      env: { ...process.env, LECTERN_USER_DATA: userData } as NodeJS.ProcessEnv,
      timeout: 90_000,
    });
    expect(second.error).toBeUndefined();
    expect(second.status).toBe(0);
    await expect.poll(() => firstWindowIsVisible(app), { timeout: 30_000 }).toBe(true);

    expect(await window.title()).toBe("Loquitur");
    expect(await bridgeShape(window)).toEqual({ platform: expect.stringMatching(/linux|win32/u), members: 7 });
  } finally {
    await closeApp(app);
  }
});
