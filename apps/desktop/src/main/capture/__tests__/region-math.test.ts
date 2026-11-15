/**
 * The region arithmetic, on its own (F§10.3).
 *
 * Everything the screen-region reader's geometry can get wrong is a case below: a drag in any of its four
 * directions, a display that scales its pixels, a selection that runs off the edge of the screen, and a
 * selection that is really a click. The module is pure — no Electron, no window, no clock — so these are the
 * numbers themselves rather than anything a display has to be running to produce.
 *
 * Every expected value is written as the *arithmetic* and not as whatever the implementation happens to return:
 * the device rectangle rounds its edges, so the numbers below are the four rounded edges' differences (for
 * example at scale factor 1.25 the left edge of `x = 11` is `round(13.75) = 14` and the right edge of
 * `x + width = 112` is `round(140) = 140`, which is a width of 126 device pixels rather than the 126.25 the
 * multiplication alone would give).
 */

import { describe, expect, it } from "vitest";
import { clampToDisplay, isTooSmall, MIN_REGION_SIZE, normalizeRect, type RegionRect, toDevicePixels } from "../region-math";

/** One rectangle, as a reader of an assertion wants to see it. */
function rect(x: number, y: number, width: number, height: number): RegionRect {
  return { x, y, width, height };
}

describe("normalizeRect", () => {
  // The same two corners, dragged in the four ways an operator can drag them.
  const topLeft = { x: 10, y: 20 };
  const bottomRight = { x: 110, y: 80 };
  const topRight = { x: 110, y: 20 };
  const bottomLeft = { x: 10, y: 80 };
  const expected = rect(10, 20, 100, 60);

  it("answers the same rectangle for a drag in any of its four directions", () => {
    expect(normalizeRect(topLeft, bottomRight)).toEqual(expected);
    expect(normalizeRect(bottomRight, topLeft)).toEqual(expected);
    expect(normalizeRect(topRight, bottomLeft)).toEqual(expected);
    expect(normalizeRect(bottomLeft, topRight)).toEqual(expected);
  });

  it("keeps a drag that never moved as a rectangle with no extent", () => {
    expect(normalizeRect(topLeft, topLeft)).toEqual(rect(10, 20, 0, 0));
  });

  it("normalizes a rectangle that arrives with a negative extent", () => {
    // A page that hands over a box the way a canvas would: the corner, then a signed size.
    const drawn = rect(110, 80, -100, -60);
    const start = { x: drawn.x, y: drawn.y };
    const end = { x: drawn.x + drawn.width, y: drawn.y + drawn.height };
    expect(normalizeRect(start, end)).toEqual(expected);
  });

  it("keeps fractional coordinates as they are, and leaves the rounding to the device conversion", () => {
    expect(normalizeRect({ x: 10.5, y: 20.25 }, { x: 30.5, y: 40.25 })).toEqual(rect(10.5, 20.25, 20, 20));
  });
});

describe("toDevicePixels", () => {
  it("is the identity at scale factor 1", () => {
    expect(toDevicePixels(rect(10, 20, 100, 60), 1)).toEqual(rect(10, 20, 100, 60));
  });

  it("multiplies the edges at scale factor 1.25, and rounds them", () => {
    // left round(11 × 1.25) = 14, top round(22 × 1.25) = 28, right round(112 × 1.25) = 140,
    // bottom round(83 × 1.25) = 104 → 126 × 76.
    expect(toDevicePixels(rect(11, 22, 101, 61), 1.25)).toEqual(rect(14, 28, 126, 76));
  });

  it("doubles at scale factor 2", () => {
    expect(toDevicePixels(rect(10, 20, 100, 60), 2)).toEqual(rect(20, 40, 200, 120));
  });

  it("keeps two neighbouring selections exactly adjacent, at every scale factor", () => {
    // The reason the edges are rounded and not the size: two rectangles that share an edge must keep sharing it,
    // or a capture would leave a device pixel unread between them, or read one twice.
    const left = rect(0, 0, 60, 40);
    const right = rect(60, 0, 60, 40);
    for (const scaleFactor of [1, 1.25, 2]) {
      const scaledLeft = toDevicePixels(left, scaleFactor);
      const scaledRight = toDevicePixels(right, scaleFactor);
      expect(scaledLeft.x + scaledLeft.width).toBe(scaledRight.x);
    }
  });

  it("converts a display's whole size, and never rounds it down to nothing", () => {
    expect(toDevicePixels(rect(0, 0, 1280, 1024), 1)).toEqual(rect(0, 0, 1280, 1024));
    expect(toDevicePixels(rect(0, 0, 1280, 1024), 1.25)).toEqual(rect(0, 0, 1600, 1280));
    // A one-pixel selection on a scaled display is still at least one device pixel: the edges are a device pixel
    // apart even when the multiplication would put them on the same one.
    expect(toDevicePixels(rect(0, 0, 1, 1), 1.25)).toEqual(rect(0, 0, 1, 1));
  });
});

describe("clampToDisplay", () => {
  const display = { width: 1280, height: 1024 };

  it("leaves a selection that is already on the display alone", () => {
    expect(clampToDisplay(rect(100, 200, 300, 400), display)).toEqual(rect(100, 200, 300, 400));
  });

  it("shortens a selection that hangs over the right and bottom edges", () => {
    expect(clampToDisplay(rect(1200, 1000, 200, 200), display)).toEqual(rect(1200, 1000, 80, 24));
  });

  it("pulls a selection that starts off the display back inside it", () => {
    expect(clampToDisplay(rect(-50, -30, 200, 200), display)).toEqual(rect(0, 0, 150, 170));
  });

  it("clamps a selection that is the whole display and then some", () => {
    expect(clampToDisplay(rect(-10, -10, 4000, 4000), display)).toEqual(rect(0, 0, 1280, 1024));
  });

  it("answers a rectangle with no extent at the nearest edge when none of it is on the display", () => {
    expect(clampToDisplay(rect(1400, 1200, 100, 100), display)).toEqual(rect(1280, 1024, 0, 0));
    expect(clampToDisplay(rect(-400, -400, 100, 100), display)).toEqual(rect(0, 0, 0, 0));
  });
});

describe("isTooSmall", () => {
  it("is what the minimum size means: under 8 pixels in either direction", () => {
    expect(MIN_REGION_SIZE).toBe(8);
    expect(isTooSmall(rect(0, 0, 7, 100))).toBe(true);
    expect(isTooSmall(rect(0, 0, 100, 7))).toBe(true);
    expect(isTooSmall(rect(0, 0, 0, 0))).toBe(true);
    expect(isTooSmall(rect(0, 0, 7, 7))).toBe(true);
  });

  it("accepts a selection that is 8 pixels in each direction, and anything larger", () => {
    expect(isTooSmall(rect(0, 0, 8, 8))).toBe(false);
    expect(isTooSmall(rect(0, 0, 8, 9))).toBe(false);
    expect(isTooSmall(rect(0, 0, 300, 400))).toBe(false);
  });

  it("forgets where the selection is: only its extent decides", () => {
    expect(isTooSmall(rect(1200, 1000, 40, 40))).toBe(false);
  });
});
