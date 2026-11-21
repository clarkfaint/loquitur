/**
 * The main window (F§10.3, F§11): the web app's own production build, loaded from disk, with the security
 * settings F§10.3 fixes and nothing else within the page's reach.
 *
 * Four decisions are the window's:
 *
 * - **The page is a file, never a URL.** `contextIsolation`, `sandbox` and a preload script are all on, so the
 *   page is an ordinary browser page with no Node and no Electron module in it, and it can only ever load the
 *   files packaged beside it: a navigation anywhere else is cancelled, and a link to the wider world is handed
 *   to the operator's browser instead. That is F§11's Electron line, and it is why the app needs no network.
 * - **Closing hides.** Playback outlives the window (F§10.3), so a close puts the window away and the shell
 *   keeps running; only a quit — from the tray, a shortcut, or the session ending — destroys it.
 * - **Autoplay is allowed.** The reader starts playback from its own control, but a `?autoplay=1` hand-off
 *   (F§10.3's import request) is a script's decision, and a browser demanding a gesture first would refuse it
 *   for a reason that has nothing to do with the app.
 * - **It answers `showMain`.** The action bus's trigger is answered here, where the window is, rather than by
 *   whoever raised it.
 */

import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { app, type BrowserWindow, BrowserWindow as ElectronBrowserWindow, shell } from "electron";
import { onAction } from "../actions";

/** The page the window loads, relative to the application directory. */
export const MAIN_WINDOW_PAGE = "resources/web/index.html";

/** Where the main window opens, and how small it may be dragged: wide enough for the reader's text column
 * beside the player bar (F§10.1). */
export const MAIN_WINDOW_SIZE = { width: 1180, height: 820, minWidth: 720, minHeight: 480 };

/** How the window is built. Both paths are absolute: they are packaged files, not URLs. */
export interface MainWindowOptions {
  /** Where the copied web build's `index.html` is. */
  page: string;
  /** The preload script that exposes F§10.3's bridge. */
  preload: string;
}

/** `createMainWindow(options)` — the app's window, with every one of the rules above already in force. */
export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const window = new ElectronBrowserWindow({
    ...MAIN_WINDOW_SIZE,
    title: "Loquitur",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: options.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required",
    },
  });

  // The directory the packaged page lives in, as a URL prefix: the only place this window may navigate to.
  const appFiles = pathToFileURL(`${dirname(options.page)}/`).href;

  /** Hand an address the app itself must not load to the operator's browser (F§11). */
  function openOutside(target: string): void {
    let protocol: string;
    try {
      protocol = new URL(target).protocol;
    } catch {
      return;
    }
    if (protocol !== "http:" && protocol !== "https:") return;
    void shell.openExternal(target);
  }

  // A click on a link, or any script's `location.href`, is judged before it happens: the app's own files are
  // allowed and everything else is either handed to the browser or dropped. A fragment change — the app's own
  // routing — never reaches this event at all.
  window.webContents.on("will-navigate", (event, target) => {
    if (target.startsWith(appFiles)) return;
    event.preventDefault();
    openOutside(target);
  });

  // A window the page tries to open never opens: the shell has one window in this unit (U-039 adds the
  // mini-player), and a link that belongs to the wider world goes to the browser instead.
  window.webContents.setWindowOpenHandler((details) => {
    openOutside(details.url);
    return { action: "deny" };
  });

  onAction("showMain", () => {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  // A quit must be allowed to close the window; every other close hides it (F§10.3).
  let quitting = false;
  app.on("before-quit", () => {
    quitting = true;
  });
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });

  window.once("ready-to-show", () => {
    window.show();
  });

  void window.loadFile(options.page);
  return window;
}
