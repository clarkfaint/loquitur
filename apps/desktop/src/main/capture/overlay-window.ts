/// <reference types="electron-vite/node" />

/**
 * The region overlay (F§10.3): a full-display window that answers with the rectangle the operator drags out.
 *
 * F§10.3 gives this feature one line — "a transparent full-screen overlay window for drag selection" — and this
 * module is that window and nothing else. It opens over the display the operator's pointer is on, dimmed and
 * crosshaired, and it *resolves*: a drag answers with the rectangle, `Esc` answers with `null`, and a window that
 * goes away for any other reason answers with `null` too rather than leaving the shell's trigger waiting for an
 * answer that never comes.
 *
 * Four things about it are deliberate:
 *
 * - **It is on top, and it does not pretend to be a window.** `transparent`, `frame: false`, `alwaysOnTop`,
 *   `skipTaskbar`, not resizable and not movable: the display is the whole surface, and there is nothing to drag
 *   the frame by because there is no frame.
 * - **It covers the display under the cursor.** F§10.3's selection is of what the operator is looking at, and
 *   that is `screen.getDisplayNearestPoint(screen.getCursorScreenPoint())` — a second monitor is not covered by
 *   the first monitor's overlay.
 * - **Its page is a packaged file and its preload is a packaged file.** The page is
 *   `resources/overlay/index.html` (U-043 packages the directory), loaded from disk and never from a URL, and
 *   the preload is the one this unit ships for it — `src/preload/overlay.ts`, emitted beside the main bundle as
 *   an asset of it, because this repository's build emits exactly one preload entry and that entry is the app's
 *   own (§7 (1) of the evidence). The window keeps F§11's settings either way: context isolation, sandbox, no
 *   Node in the page.
 * - **What the page sends is checked.** The two members the overlay's preload exposes reach `ipcMain` directly,
 *   so the payload is whatever a script in that page put on the channel; it is parsed against a schema before a
 *   single one of its numbers is used, and a payload that does not parse is reported and ignored rather than
 *   handed to `nativeImage`.
 *
 * One selection at a time: a trigger that arrives while the operator is already being asked for a region answers
 * `null` immediately, so the shell can never be talking to two overlays at once and the screen can never wear
 * two dims.
 */

import { join } from "node:path";
import { BrowserWindow, type IpcMainEvent, ipcMain, screen } from "electron";
import { z } from "zod";
import overlayPreload from "../../preload/overlay.ts?asset";
import { normalizeRect, type RegionRect } from "./region-math";

/** The overlay page, relative to the application directory. U-043 packages `resources/overlay` with it. */
export const OVERLAY_PAGE = "resources/overlay/index.html";

/** The two channels the overlay's preload sends on: the literals `src/preload/overlay.ts` names as well. */
export const OVERLAY_SUBMIT_CHANNEL = "lectern:overlay-submit";
export const OVERLAY_CANCEL_CHANNEL = "lectern:overlay-cancel";

/** The window's own title, before the page's `<title>` replaces it; `Lectern`, as every window of the shell. */
const OVERLAY_TITLE = "Loquitur";

/**
 * The rectangle as it arrives from the overlay page: four numbers in that page's own pixels, and nothing else.
 *
 * `z.number()` is the whole check a coordinate needs — the installed zod refuses `NaN` and both infinities
 * (`$ZodNumber`'s parse admits only a finite `number`; `zod@4.6.7`'s `v4/core/schemas.js:642`) — and the object
 * is *strict*, so a payload that carries anything else is refused rather than partly used.
 */
const DrawnRegionSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

/**
 * One display, as the two halves of a region capture need it.
 *
 * `bounds` is in device-independent pixels and is where the overlay window is put; `scaleFactor` is how many
 * thumbnail pixels one of those pixels is, which is the number `toDevicePixels` multiplies by; `id` is the
 * display's own identifier, which is what `desktopCapturer`'s sources are matched against.
 */
export interface RegionDisplay {
  id: string;
  bounds: RegionRect;
  scaleFactor: number;
}

/** The packaged overlay page, from the built main bundle in `out/main`, beside `resources`. */
export function overlayPagePath(): string {
  return join(__dirname, "..", "..", OVERLAY_PAGE);
}

/** `displayUnderCursor()` — F§10.3's "the display under the cursor", and the three facts a capture needs. */
export function displayUnderCursor(): RegionDisplay {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return { id: String(display.id), bounds: display.bounds, scaleFactor: display.scaleFactor };
}

/** The selection currently on the screen, so a second trigger joins nothing and opens nothing. */
let open: BrowserWindow | null = null;

/**
 * `selectRegion(display)` — ask the operator for a rectangle on `display`.
 *
 * Answers the rectangle the drag describes (normalized, in the display's own pixels) or `null` — for `Esc`, for
 * a window that went away some other way, and for a trigger that arrived while another selection was already
 * open. The window is destroyed before the promise settles, so whoever asked for the region knows the screen is
 * its own again by the time it gets an answer; the capture that follows depends on exactly that.
 */
export async function selectRegion(display: RegionDisplay): Promise<RegionRect | null> {
  if (open !== null && !open.isDestroyed()) return null;

  const window = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    useContentSize: true,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    autoHideMenuBar: true,
    show: false,
    title: OVERLAY_TITLE,
    webPreferences: {
      preload: overlayPreload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  open = window;

  /** What the operator decided, once; `null` until then, and `null` for every ending but a real drag. */
  let answer: RegionRect | null = null;
  let settled = false;

  const closed = new Promise<void>((resolve) => {
    window.once("closed", () => {
      resolve();
    });
  });

  /** Take the window off the screen and let the wait finish: the answer is whatever was put in `answer`. */
  function finish(rect: RegionRect | null): void {
    if (settled) return;
    settled = true;
    answer = rect;
    if (!window.isDestroyed()) window.destroy();
  }

  /** The rectangle the page drew. A rectangle with a negative extent is normalized into the same region. */
  function submitted(payload: unknown): void {
    if (settled) return;
    const parsed = DrawnRegionSchema.safeParse(payload);
    if (!parsed.success) {
      // A page that sends something else is a page this shell cannot read; the overlay stays up so the operator
      // can still drag a region rather than being left with a window that answers to nothing.
      console.error(`the region overlay sent ${OVERLAY_SUBMIT_CHANNEL} a payload that is not a rectangle`);
      return;
    }
    const drawn = parsed.data;
    finish(normalizeRect({ x: drawn.x, y: drawn.y }, { x: drawn.x + drawn.width, y: drawn.y + drawn.height }));
  }

  /** `Esc`, or the page's own `cancel()`. */
  function cancelled(): void {
    finish(null);
  }

  /**
   * The two listeners as `ipcMain` calls them: the first argument is the message's own event object and the
   * payload is the one after it. (Measured the hard way: a listener that took its first argument as the
   * rectangle was handed Electron's event and refused it as "not a rectangle".)
   */
  const onSubmitted = (_event: IpcMainEvent, payload: unknown): void => {
    submitted(payload);
  };
  const onCancelled = (): void => {
    cancelled();
  };

  ipcMain.on(OVERLAY_SUBMIT_CHANNEL, onSubmitted);
  ipcMain.on(OVERLAY_CANCEL_CHANNEL, onCancelled);

  try {
    // Shown once the page is there, so the operator never sees a transparent window with nothing in it, and
    // focused, because the drag's `Esc` is delivered to the window the operator is looking at.
    window.once("ready-to-show", () => {
      if (window.isDestroyed()) return;
      window.show();
      window.focus();
    });
    void window.loadFile(overlayPagePath());

    await closed;
    return answer;
  } finally {
    ipcMain.removeListener(OVERLAY_SUBMIT_CHANNEL, onSubmitted);
    ipcMain.removeListener(OVERLAY_CANCEL_CHANNEL, onCancelled);
    if (!window.isDestroyed()) window.destroy();
    open = null;
  }
}
