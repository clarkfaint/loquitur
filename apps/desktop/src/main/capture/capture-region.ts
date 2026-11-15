/**
 * Reading a region of the screen (F§10.3): the `readRegion` action, from the trigger to the reading.
 *
 * F§10.3's screen-region reader is one chain — "a transparent full-screen overlay window for drag selection →
 * `desktopCapturer` screenshot → crop → PNG → `POST /v1/parse` → play in the mini-player" — and this module is
 * the shell's half of it. One trigger, one selection, one capture, one hand-off: nothing here watches the
 * pointer, polls the screen, or remembers a rectangle for later.
 *
 * Five decisions are this module's:
 *
 * - **The strip is taken off the screen first, and only when it is really up.** F§10.3 has the mini-player
 *   standing in for the window, and a screen capture is of *the screen*: a strip left up would be photographed
 *   along with the text the operator is selecting. The shell's own trigger for the strip is `toggleMini` (U-039),
 *   and a toggle is not a hide — it *creates* the strip when there is none — so the window list is asked first,
 *   with U-039's own definition of the strip (its always-on-top window of the mini-player's own size), and the
 *   same toggle is raised exactly once to put it back.
 * - **What is worth reading is decided by the tested arithmetic.** A cancelled selection and a rectangle smaller
 *   than 8×8 in either direction do nothing at all: no capture, no import, no document. The rectangle is clamped
 *   to the display *before* its size is judged, because a selection half off the edge of the screen is only as
 *   big as the part that is on it.
 * - **The screen is read after the selection is over, and a settled moment after it.** The overlay's own dim and
 *   its own rectangle are pixels on the screen, so the capture waits for the overlay to be gone
 *   (`selectRegion` destroys it before it answers) and then for the desktop to repaint what was underneath.
 * - **The bytes are `nativeImage`'s own, and they go straight to the app.** The crop is a `NativeImage`, its PNG
 *   is a `Uint8Array`, and that array is the import request's payload — nothing is written to disk, and nothing
 *   survives the request (the contract's *Forbidden Actions*). The shell neither parses nor recognises anything:
 *   the app's ordinary import pipeline sends the PNG to the hub, where F§5.5's OCR engine reads it.
 * - **A failed capture is reported, not thrown.** The trigger is a hotkey or the bridge, where an exception has
 *   nowhere to go, so a display that cannot be captured, an empty thumbnail and a desktop with no screen at all
 *   are one line in the shell's log and no reading (the shape U-039 uses for its tray-driven failures).
 *
 * Nothing is injected here: the shell's own surfaces are the ones this module uses, and the parts of the chain a
 * test could hold still — the arithmetic, the endings, the clamping — are the ones `./region-math` exports and
 * that this unit's unit tests cover. What is left is the wiring, and the unit's end-to-end case is what proves
 * it: a drag over a heading becomes a document in `Quick reads`, and `Esc` becomes nothing.
 */

import { BrowserWindow, desktopCapturer } from "electron";
import type { MainContext } from "../context";
import type { ShellFeature } from "../features";
import { IPC_CHANNELS } from "../ipc";
import { MINI_WINDOW_SIZE } from "../windows/mini-window";
import { displayUnderCursor, type RegionDisplay, selectRegion } from "./overlay-window";
import { clampToDisplay, isTooSmall, type RegionRect, toDevicePixels } from "./region-math";

/** The folder F§10.3 files a screen region in: its own, and the app's (`desktop-integration.ts`). */
export const QUICK_READS_FOLDER = "Quick reads";

/** The name and type the PNG is handed over as; F§5.4 sniffs the bytes, so the name is for the operator. */
export const REGION_FILE_NAME = "screen-region.png";
export const REGION_MIME = "image/png";

/**
 * How long the desktop is given to repaint after the overlay is gone, before the screen is read.
 *
 * Destroying the window is what `selectRegion` answers on, and the screen underneath it is drawn again by the
 * desktop in the moment after that: a capture taken in between photographs the overlay's own dim over the
 * operator's text, which is exactly the pixels this feature must not read. Measured on this host: the window is
 * gone from the screen within a frame or two, and 150 ms is an order of magnitude more than that.
 */
export const SCREEN_SETTLE_MS = 150;

/** `wait(ms)` — the settle, and the only clock in this module. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The mini-player's window, as U-039 makes it: the shell's always-on-top window whose content is the strip.
 *
 * The always-on-top test is what tells the strip apart from the main window — it is the one window of the shell
 * that is meant to be read past rather than switched to — and the height tells it apart from this feature's own
 * overlay, which is always on top too and is the size of a whole display. The comparison is `<=` rather than an
 * exact match on U-039's own size because a desktop may round a window's size by a pixel (measured on this host:
 * a window asked for a 1280×1024 display is given 1279×1023), and a strip that is one pixel short of 72 is still
 * the strip.
 */
function miniPlayerWindow(): BrowserWindow | null {
  const found = BrowserWindow.getAllWindows().find((window) => {
    if (window.isDestroyed() || !window.isAlwaysOnTop()) return false;
    const height = window.getContentSize()[1];
    return height !== undefined && height <= MINI_WINDOW_SIZE.height;
  });
  return found ?? null;
}

/**
 * `captureDisplay(display, rect)` — the display's pixels, cropped to `rect`, as a PNG.
 *
 * The thumbnail is asked for at the display's *device* size, the source is the one whose `display_id` is that
 * display (F§10.3's overlay covers one display, so one display is what is read; the first source is the fallback
 * for a platform that reports no id), and the crop is the rectangle in device pixels. Both conversions are
 * `./region-math`'s, and the rectangle is clamped there too, because `nativeImage.crop` *scales* an image when
 * the rectangle leaves it rather than refusing it.
 */
async function captureDisplay(display: RegionDisplay, rect: RegionRect): Promise<Uint8Array> {
  const wholeDisplay: RegionRect = { x: 0, y: 0, width: display.bounds.width, height: display.bounds.height };
  const deviceSize = toDevicePixels(wholeDisplay, display.scaleFactor);
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: deviceSize.width, height: deviceSize.height },
  });

  const source = sources.find((candidate) => candidate.display_id === display.id) ?? sources[0];
  if (source === undefined) throw new Error("the desktop reported no screen to capture");
  if (source.thumbnail.isEmpty()) throw new Error("the captured screen has no pixels");

  const crop = toDevicePixels(clampToDisplay(rect, display.bounds), display.scaleFactor);
  const image = source.thumbnail.crop({ x: crop.x, y: crop.y, width: crop.width, height: crop.height });
  return new Uint8Array(image.toPNG());
}

/**
 * `captureRegion(ctx)` — the whole of one reading: strip away, select, capture, hand over, strip back.
 *
 * The strip is put back in a `finally` on every path, including the paths where nothing was read and the one
 * where a capture failed — a feature that hides a window must not be able to leave it hidden because something
 * else went wrong.
 */
async function captureRegion(ctx: MainContext): Promise<void> {
  const display = displayUnderCursor();
  const strip = miniPlayerWindow();
  const stripWasUp = strip?.isVisible() ?? false;
  if (stripWasUp) ctx.windows.toggleMini();

  try {
    const selected = await selectRegion(display);
    if (selected === null) return;
    const rect = clampToDisplay(selected, display.bounds);
    if (isTooSmall(rect)) return;

    await wait(SCREEN_SETTLE_MS);
    const bytes = await captureDisplay(display, rect);

    // F§10.3's hand-off: the app's own import pipeline takes it from here, files it in `Quick reads` and opens
    // it playing, because a region the operator drew is a region they want read now.
    ctx.sendToMain(IPC_CHANNELS.importRequest, {
      files: [{ name: REGION_FILE_NAME, mime: REGION_MIME, bytes }],
      play: true,
      folderName: QUICK_READS_FOLDER,
    });
  } finally {
    if (stripWasUp) ctx.windows.toggleMini();
  }
}

/** A failure that has nowhere to be shown — the trigger is a hotkey — is one line in the shell's log. */
function report(cause: unknown): void {
  console.error(`the screen region could not be read: ${cause instanceof Error ? cause.message : String(cause)}`);
}

/**
 * `captureRegionFeature` — what `features.ts` registers (the registry U-038 marked).
 *
 * F§10.3's trigger is one action and this answers it. The bridge's `captureRegion()` reaches the same handler
 * without a channel of its own: U-038's context already binds `lectern:capture-region` to raising this action,
 * which is the shape the contract's "handler for `readRegion` and `captureRegion()`" asks for.
 */
export const captureRegionFeature: ShellFeature = (ctx: MainContext): void => {
  ctx.actions.on("readRegion", () => {
    void captureRegion(ctx).catch(report);
  });
};
