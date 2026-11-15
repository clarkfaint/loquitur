/**
 * The screen-region reader's arithmetic (F§10.3), and nothing else.
 *
 * A region capture moves between two coordinate spaces, and this module is the whole of that movement:
 *
 * - **The overlay page's pixels.** The overlay window is the display, frameless, so the page's own CSS pixels
 *   *are* that display's device-independent pixels, with the display's top-left corner as the origin. What the
 *   operator drags out is a rectangle in this space.
 * - **The thumbnail's pixels.** `desktopCapturer` is asked for the display at its *device* size
 *   (`bounds.width × scaleFactor`), so a display at scale factor 1.25 has a quarter more pixels per axis than
 *   the page had. `toDevicePixels` is that multiplication.
 *
 * Three decisions are the module's, and each of them is a place where a plausible implementation is subtly
 * wrong:
 *
 * - **A drag is normalized, not assumed.** A rectangle drawn bottom-right to top-left arrives with a negative
 *   extent, or as two corners; `normalizeRect` turns either into the one rectangle the two points describe, so
 *   all four drag directions produce the same region.
 * - **The device rectangle rounds its *edges*, not its size.** Rounding a width leaves a seam: at scale factor
 *   1.25 a 100-pixel selection is 125 device pixels wide, and rounding the *right edge* is what keeps two
 *   neighbouring selections exactly adjacent instead of one pixel apart or overlapping.
 * - **A display's bounds are the limit, and the clamp is a real operation.** The rectangle is clamped before it
 *   reaches `nativeImage.crop`, which scales an image rather than refusing an out-of-range rectangle — so an
 *   unclamped rectangle would silently produce a *rescaled* crop of the wrong part of the screen.
 *
 * Everything here is pure: no Electron, no clock, no I/O. The overlay's own module owns the window, and the
 * shell's handler owns the capture; this module is what both of them agree about.
 */

/** A point in the overlay page's coordinates: one CSS pixel of the display the overlay covers. */
export interface RegionPoint {
  x: number;
  y: number;
}

/** A rectangle: `x` and `y` are its top-left corner, `width` and `height` its extent, in the same space. */
export interface RegionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A size, for the one thing that has no corner: the display itself. */
export interface RegionSize {
  width: number;
  height: number;
}

/** The smallest selection the shell acts on, in either direction: the contract's 8×8. */
export const MIN_REGION_SIZE = 8;

/**
 * `normalizeRect(start, end)` — the one rectangle two dragged corners describe, whichever way it was dragged.
 *
 * The result's corner is the top-left of the two points and its extent is the distance between them, so a drag
 * from the bottom-right to the top-left, from the top-right to the bottom-left and from the top-left to the
 * bottom-right are the same rectangle. A page that hands over a rectangle with a negative extent — its own
 * arithmetic, drawn or not — is normalized by the same function, because the shell then knows that what it
 * holds is a rectangle rather than a shape.
 */
export function normalizeRect(start: RegionPoint, end: RegionPoint): RegionRect {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return { x, y, width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
}

/**
 * `toDevicePixels(rect, scaleFactor)` — a rectangle in the page's pixels, in the thumbnail's.
 *
 * Both edges are multiplied and rounded, and the extent is the difference between them: an edge that lands on
 * half a device pixel goes to the *nearer* device pixel on both sides, so two adjacent selections stay adjacent
 * and every device pixel of the selection is inside the crop. A display at scale factor 1 is the identity, up
 * to the rounding a display at any scale factor needs.
 */
export function toDevicePixels(rect: RegionRect, scaleFactor: number): RegionRect {
  const left = Math.round(rect.x * scaleFactor);
  const top = Math.round(rect.y * scaleFactor);
  const right = Math.round((rect.x + rect.width) * scaleFactor);
  const bottom = Math.round((rect.y + rect.height) * scaleFactor);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * `clampToDisplay(rect, displaySize)` — the part of `rect` that is really on the display.
 *
 * The answer is the *intersection* of the rectangle with the display: the corner is pulled inside, and an edge
 * that hangs over the right or the bottom is pulled back to the display's own edge, so a selection that starts
 * off-screen keeps only the part of itself that was on the screen. A rectangle with nothing on the display — off
 * its edge, or with a negative extent its caller did not normalize — answers a zero-sized one at the nearest
 * corner rather than a negative region, which `isTooSmall` then discards: a selection that is not on any screen
 * does nothing rather than cropping the screen somewhere else.
 */
export function clampToDisplay(rect: RegionRect, displaySize: RegionSize): RegionRect {
  const x = Math.max(0, Math.min(rect.x, displaySize.width));
  const y = Math.max(0, Math.min(rect.y, displaySize.height));
  const right = Math.max(x, Math.min(rect.x + rect.width, displaySize.width));
  const bottom = Math.max(y, Math.min(rect.y + rect.height, displaySize.height));
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * `isTooSmall(rect)` — whether a selection is a click rather than a region (the contract's 8×8).
 *
 * A rectangle that is 8 pixels in each direction is a selection; one that is 7 pixels in either direction is
 * discarded, and the reading happens only for what the operator really drew.
 */
export function isTooSmall(rect: RegionRect): boolean {
  return rect.width < MIN_REGION_SIZE || rect.height < MIN_REGION_SIZE;
}
