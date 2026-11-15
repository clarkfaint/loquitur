/**
 * The mini-player's window (F§10.3, F§10.1): the strip of transport controls that stays visible over whatever
 * the operator is reading.
 *
 * Four of its properties are F§10.3's own. It is **frameless** and fixed at 360×72, because it is a row of
 * controls rather than a window; it is **always on top**, because it is meant to be read past rather than
 * switched to; it is **skipped in the task list**, because it is not a place to switch to at all; and it is
 * **shown inactive**, so bringing it up never takes the operator's typing away from the application they are
 * in — the one rule that makes an always-on-top window bearable.
 *
 * The page it loads is the web app's own build at `#/mini` — the same file the main window loads — so there is
 * one reader UI in the repository rather than two. That page is F§10.1's remote: it paints the state the shell
 * hands it and answers with the commands its buttons mean, and it holds no player and no audio of its own
 * (F§10.3's rule).
 *
 * Where it sits is F§10.3's `miniBounds`: a position the shell remembers between runs, clamped to a display
 * that exists, so a window left on a monitor that has since been unplugged comes back on one that is there.
 * The size is not part of the record — it never changes.
 *
 * This module owns the window and nothing else. `features/shell-features.ts` wires the actions that show and
 * hide it, and `player-relay.ts` owns the player's channels and the page-side half of the bridge.
 */

import { join } from "node:path";
import { BrowserWindow, screen } from "electron";
import { MAIN_WINDOW_PAGE } from "./main-window";

/** The route the mini-player's page is (F§10.1). */
export const MINI_WINDOW_ROUTE = "/mini";

/** The window's fixed size (F§10.3): the compact bar and nothing to drag. */
export const MINI_WINDOW_SIZE = { width: 360, height: 72 } as const;

/** The distance the default position keeps from the work area's corner, so the window does not touch the edge. */
export const MINI_WINDOW_MARGIN = 24;

/** How long the window must hold still before a position is remembered: `move` fires for every pixel of a drag. */
export const MOVE_SETTLE_MS = 250;

/** Where the window is: F§10.3's `miniBounds`, which is a position and never a size. */
export interface MiniBounds {
  x: number;
  y: number;
}

/** A work area, as Electron reports one: the part of a display that is not the panel or the task bar. */
export interface MiniWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The packaged page the window loads, from the built main bundle in `out/main`. */
export function miniWindowPage(): string {
  return join(__dirname, "..", "..", MAIN_WINDOW_PAGE);
}

/** Pull one axis into a work area's span, so a window smaller than the display never leaves it. */
function clampAxis(value: number, minimum: number, maximum: number): number {
  return Math.round(Math.min(Math.max(minimum, maximum), Math.max(minimum, value)));
}

/**
 * `nearestWorkArea(bounds, workAreas)` — the display a mini-player belongs to.
 *
 * The distance is measured to the *area a window of this size could occupy inside it*, so a position that fits
 * an area distances 0 from it and wins over every other; a position off every display — an unplugged monitor —
 * distances by how far it would have to travel. The first area is the fallback, and the caller puts the
 * primary display there.
 */
function nearestWorkArea(bounds: MiniBounds, workAreas: readonly MiniWorkArea[]): MiniWorkArea {
  const fallback: MiniWorkArea = { x: bounds.x, y: bounds.y, width: MINI_WINDOW_SIZE.width, height: MINI_WINDOW_SIZE.height };
  const first = workAreas[0] ?? fallback;
  const distanceTo = (area: MiniWorkArea): number => {
    const dx = Math.max(area.x - bounds.x, 0, bounds.x - (area.x + Math.max(0, area.width - MINI_WINDOW_SIZE.width)));
    const dy = Math.max(area.y - bounds.y, 0, bounds.y - (area.y + Math.max(0, area.height - MINI_WINDOW_SIZE.height)));
    return dx * dx + dy * dy;
  };
  let best = first;
  for (const area of workAreas) {
    if (distanceTo(area) < distanceTo(best)) best = area;
  }
  return best;
}

/** `clampToWorkAreas(bounds, workAreas)` — F§10.3's "clamped to a visible display", in one function. */
export function clampToWorkAreas(bounds: MiniBounds, workAreas: readonly MiniWorkArea[]): MiniBounds {
  const area = nearestWorkArea(bounds, workAreas);
  const limitX = area.x + Math.max(0, area.width - MINI_WINDOW_SIZE.width);
  const limitY = area.y + Math.max(0, area.height - MINI_WINDOW_SIZE.height);
  return { x: clampAxis(bounds.x, area.x, limitX), y: clampAxis(bounds.y, area.y, limitY) };
}

/** `defaultMiniBounds(workAreas)` — where the window opens before the operator has ever moved it: the bottom
 * right corner of the primary display's work area, a margin in from the edge. */
export function defaultMiniBounds(workAreas: readonly MiniWorkArea[]): MiniBounds {
  const area = workAreas[0] ?? { x: 0, y: 0, width: MINI_WINDOW_SIZE.width, height: MINI_WINDOW_SIZE.height };
  return {
    x: Math.round(area.x + Math.max(0, area.width - MINI_WINDOW_SIZE.width - MINI_WINDOW_MARGIN)),
    y: Math.round(area.y + Math.max(0, area.height - MINI_WINDOW_SIZE.height - MINI_WINDOW_MARGIN)),
  };
}

/** How the window is built and what the shell is told about it. */
export interface MiniWindowOptions {
  /** The preload script F§10.3's bridge is exposed by. */
  preload: string;
  /** Where the packaged page is; `miniWindowPage()` is the shell's own answer. */
  page: string;
  /** F§10.3's `miniBounds`, or `null` when the operator has never moved the window. */
  bounds: MiniBounds | null;
  /** Called with the position once the operator has finished moving the window, so it can be remembered. */
  onMoved(bounds: MiniBounds): void;
  /** Called when the page has loaded — the relay joins the page to F§10.3's channels there. */
  onReady(window: BrowserWindow): void;
}

/** The window, as the shell's feature uses it. */
export interface MiniWindow {
  /** Whether it is on the screen. A window that has been destroyed is not. */
  isVisible(): boolean;
  /** Bring it up without taking focus (F§10.3), where it was last left. */
  show(): void;
  /** Take it off the screen without destroying it, so an already-loaded page is kept. */
  hide(): void;
  /** The window underneath, for the facts only the main process can read (the suite reads them too). */
  window(): BrowserWindow;
}

/** The work areas of the displays, the primary one first: the order `clampToWorkAreas` decides with. */
export function orderedWorkAreas(displays: readonly { id: number; workArea: MiniWorkArea }[], primaryId: number): MiniWorkArea[] {
  const primary = displays.find((display) => display.id === primaryId);
  const rest = displays.filter((display) => display.id !== primaryId);
  return [...(primary === undefined ? [] : [primary]), ...rest].map((display) => display.workArea);
}

/**
 * `createMiniWindow(options)` — the window F§10.3 describes, loading the app's own mini page.
 *
 * The page is loaded from disk, never from a URL, and the window gets the same sandboxed, context-isolated
 * page as the main window: it is the app's own build, and F§11's rule about what a page may reach does not
 * change because the page is small.
 */
export function createMiniWindow(options: MiniWindowOptions): MiniWindow {
  const workAreas = orderedWorkAreas(screen.getAllDisplays(), screen.getPrimaryDisplay().id);
  const placement = options.bounds === null ? defaultMiniBounds(workAreas) : options.bounds;
  const bounds = clampToWorkAreas(placement, workAreas);

  const window = new BrowserWindow({
    ...MINI_WINDOW_SIZE,
    useContentSize: true,
    x: bounds.x,
    y: bounds.y,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    autoHideMenuBar: true,
    title: "Lectern",
    webPreferences: {
      preload: options.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // The strip has to keep up with a reading that is going on in another window, and a hidden page is
      // throttled by default (the main window is given the same setting for the same reason).
      backgroundThrottling: false,
    },
  });

  window.webContents.on("did-finish-load", () => {
    options.onReady(window);
  });

  // A moved window is the operator's decision, so it is written down as F§10.3's `miniBounds`. Linux has no
  // one-shot `moved` event and `move` fires for every pixel of a drag, so the write waits for the drag to
  // settle rather than writing a file per frame.
  let settling: ReturnType<typeof setTimeout> | null = null;
  const remember = (): void => {
    settling = null;
    const at = window.getBounds();
    options.onMoved({ x: at.x, y: at.y });
  };
  window.on("move", () => {
    if (settling !== null) clearTimeout(settling);
    settling = setTimeout(remember, MOVE_SETTLE_MS);
  });
  window.on("closed", () => {
    if (settling !== null) clearTimeout(settling);
    settling = null;
  });

  void window.loadFile(options.page, { hash: MINI_WINDOW_ROUTE });

  return {
    isVisible: () => !window.isDestroyed() && window.isVisible(),
    show: () => {
      if (!window.isDestroyed()) window.showInactive();
    },
    hide: () => {
      if (!window.isDestroyed()) window.hide();
    },
    window: () => window,
  };
}
