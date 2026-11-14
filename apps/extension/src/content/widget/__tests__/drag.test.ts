/**
 * Where the widget may sit (F§10.1).
 *
 * The question is one question asked twice — *may the widget be here?* — and both halves of it are answered
 * without a browser: a drag past an edge, and a position that was legal until the window shrank under it. The
 * cases below pin each of the four edges separately (a clamp that is wrong on one axis passes a test that only
 * asks about the other), the two degenerate boxes (a widget with no room at all, a coordinate that is not a
 * number), and the property that makes a drag feel right: a drag that runs past an edge and comes back retraces
 * its own path, because the position it is measured from is the gesture's origin and not the clamped frame
 * before it.
 */

import { describe, expect, it } from "vitest";
import { clampToViewport, nextPosition, type Size, type Viewport } from "../drag";

/** A pill's own box, and a desktop viewport: the numbers a reader's browser would report. */
const SIZE: Size = { width: 96, height: 40 };
const VIEWPORT: Viewport = { width: 1200, height: 800 };

describe("clampToViewport", () => {
  it("leaves a position that is already inside the viewport alone", () => {
    expect(clampToViewport({ x: 320, y: 240 }, SIZE, VIEWPORT)).toEqual({ x: 320, y: 240 });
  });

  it("pulls a widget past the left edge back to it", () => {
    expect(clampToViewport({ x: -25, y: 240 }, SIZE, VIEWPORT)).toEqual({ x: 0, y: 240 });
  });

  it("pulls a widget past the right edge back to it", () => {
    expect(clampToViewport({ x: 5000, y: 240 }, SIZE, VIEWPORT)).toEqual({ x: 1104, y: 240 });
  });

  it("pulls a widget past the top edge back to it", () => {
    expect(clampToViewport({ x: 320, y: -25 }, SIZE, VIEWPORT)).toEqual({ x: 320, y: 0 });
  });

  it("pulls a widget past the bottom edge back to it", () => {
    expect(clampToViewport({ x: 320, y: 5000 }, SIZE, VIEWPORT)).toEqual({ x: 320, y: 760 });
  });

  it("keeps a widget flush against an edge exactly where it is", () => {
    expect(clampToViewport({ x: 1104, y: 760 }, SIZE, VIEWPORT)).toEqual({ x: 1104, y: 760 });
  });

  it("pins a widget larger than the viewport at the origin", () => {
    expect(clampToViewport({ x: 40, y: 40 }, { width: 1600, height: 1200 }, VIEWPORT)).toEqual({ x: 0, y: 0 });
  });

  it("reads a coordinate that is not a number as the origin", () => {
    expect(clampToViewport({ x: Number.NaN, y: Number.POSITIVE_INFINITY }, SIZE, VIEWPORT)).toEqual({ x: 0, y: 0 });
  });

  it("rounds a fractional position to whole pixels", () => {
    expect(clampToViewport({ x: 319.4, y: 240.6 }, SIZE, VIEWPORT)).toEqual({ x: 319, y: 241 });
  });

  it("clamps a remembered position into a viewport that shrank under it", () => {
    const remembered = { x: 900, y: 700 };
    expect(clampToViewport(remembered, SIZE, { width: 600, height: 400 })).toEqual({ x: 504, y: 360 });
  });
});

describe("nextPosition", () => {
  it("adds a pointer delta to where the widget was", () => {
    expect(nextPosition({ x: 320, y: 240 }, { x: 40, y: -25 })).toEqual({ x: 360, y: 215 });
  });

  it("leaves the widget where it is when the delta is nothing", () => {
    expect(nextPosition({ x: 320, y: 240 }, { x: 0, y: 0 })).toEqual({ x: 320, y: 240 });
  });

  it("reads a coordinate that is not a number as no movement at all", () => {
    expect(nextPosition({ x: 320, y: 240 }, { x: Number.NaN, y: Number.POSITIVE_INFINITY })).toEqual({ x: 320, y: 240 });
  });

  it("measures a drag from the gesture's own origin, so a drag past an edge and back retraces itself", () => {
    const start = { x: 320, y: 240 };
    const past = clampToViewport(nextPosition(start, { x: -900, y: -900 }), SIZE, VIEWPORT);
    expect(past).toEqual({ x: 0, y: 0 });
    const back = clampToViewport(nextPosition(start, { x: 40, y: 40 }), SIZE, VIEWPORT);
    expect(back).toEqual({ x: 360, y: 280 });
  });
});
