/**
 * Where the widget sits (F§10.1): two pure functions, so the widget's position is arithmetic that can be
 * proved without a browser, a layout engine or a pointer.
 *
 * A widget is placed by the top-left corner of the whole widget, in viewport pixels, and it must never be
 * partly off screen — not after a drag past an edge, and not after the window shrinks under a position that
 * used to fit. Both of those are the same question asked twice: pull a point into the box the widget may
 * occupy. `nextPosition` is the other half of a drag — the translation a pointer delta asks for, before the
 * clamp has its say — so a drag is `clampToViewport(nextPosition(start, delta), size, viewport)` and nothing
 * else, with no layout read anywhere in it.
 */

/** A point in viewport coordinates: the widget's own top-left corner, in pixels. */
export interface Point {
  x: number;
  y: number;
}

/** The widget's box, in pixels. */
export interface Size {
  width: number;
  height: number;
}

/** The box the widget must stay inside: the viewport, in pixels. */
export interface Viewport {
  width: number;
  height: number;
}

/** A number a caller promised, or `0` when the value is not one — a missing pointer, an unmeasured box. */
function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** Whole pixels: a pointer delta is fractional, a position must not be. */
function whole(value: number): number {
  return Math.round(finite(value));
}

/** How far the widget may sit from the box's own origin along one axis; never negative. */
function room(box: number, size: number): number {
  return Math.max(0, whole(box) - whole(size));
}

/**
 * `clampToViewport(position, size, viewport)` — the widget's position pulled into the viewport: both
 * coordinates are whole pixels inside `[0, viewport − size]`. A widget larger than the viewport has no room
 * at all, so it is pinned at the origin rather than given a negative bound; a non-finite coordinate reads as
 * `0`, which is what an unmeasured box or a lost pointer would otherwise put on the host's style.
 */
export function clampToViewport(position: Point, size: Size, viewport: Viewport): Point {
  return {
    x: Math.min(Math.max(whole(position.x), 0), room(viewport.width, size.width)),
    y: Math.min(Math.max(whole(position.y), 0), room(viewport.height, size.height)),
  };
}

/**
 * `nextPosition(start, delta)` — the position a translation asks for, before the clamp. It is deliberately
 * not clamped: a drag that runs past an edge is clamped once, by the caller, so the widget cannot creep
 * along an edge the way a position that is stored already-clamped would (each clamped frame would become
 * the next frame's starting point and the pointer's return trip would not retrace it).
 */
export function nextPosition(start: Point, delta: Point): Point {
  return { x: finite(start.x) + finite(delta.x), y: finite(start.y) + finite(delta.y) };
}
