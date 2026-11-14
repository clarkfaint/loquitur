/**
 * The auto-scroll policy (F§10.1): where the reader should be scrolled so that the line being read stays
 * in the upper part of the viewport, and when it should stop moving because the reader is scrolling by
 * hand. Manual scrolling suspends the policy for four seconds; after that it resumes by itself, with no
 * button to press.
 *
 * This is arithmetic over an injected clock and nothing else — no window, no element, no listener — so the
 * band and the suspension can be tested directly, and the component that owns the page decides when a
 * scroll was the reader's own. The numbers here are the resting place (45 % of the viewport) and the band
 * the line is allowed to sit in (30 % to 60 %): the line is only moved when it has left the band, and
 * then it is moved to the middle of it, so small scrolls do not fight each other frame by frame.
 */

/** The only thing the policy reads from the world: a monotonic clock in milliseconds. */
export interface ScrollClock {
  now(): number;
}

/** How the policy is built: the clock it reads, and how long a manual scroll suspends it. */
export interface AutoScrollOptions {
  clock: ScrollClock;
  /** Milliseconds a manual scroll suspends auto-scroll for; F§10.1's four seconds by default. */
  suspendMs?: number;
}

/** What the reader asks the policy: one scroll event, and one question about the active line. */
export interface AutoScrollPolicy {
  /** The reader scrolled the page themselves; stop moving it for a while. */
  onUserScroll(): void;
  /**
   * How many pixels to add to the reader's scroll offset so the active line rests at 45 % of the viewport,
   * or `null` to leave the page alone — because the line is already inside the band, or because the
   * reader's own scrolling still suspends the policy. `rect` is a line box in viewport coordinates, as
   * `Range.getBoundingClientRect()` reports it, so only its top edge is read.
   */
  target(rect: { top: number }, viewportHeight: number): number | null;
}

/** F§10.1's suspension, in milliseconds. */
const DEFAULT_SUSPEND_MS = 4000;

/** The band the active line may sit in, as fractions of the viewport height. */
const BAND_TOP = 0.3;
const BAND_BOTTOM = 0.6;

/** Where the line is put once it has left the band: the middle of it, in fractions of the viewport. */
const RESTING_FRACTION = 0.45;

/**
 * Build the policy. Suspension is measured from the last `onUserScroll()` on the injected clock, so a
 * reader who scrolls again mid-suspension extends it rather than racing it.
 */
export function createAutoScroll({ clock, suspendMs = DEFAULT_SUSPEND_MS }: AutoScrollOptions): AutoScrollPolicy {
  let suspendedAt: number | null = null;

  return {
    onUserScroll(): void {
      suspendedAt = clock.now();
    },

    target(rect: { top: number }, viewportHeight: number): number | null {
      if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return null;
      if (!Number.isFinite(rect.top)) return null;
      if (suspendedAt !== null && clock.now() - suspendedAt < suspendMs) return null;
      const bandTop = viewportHeight * BAND_TOP;
      const bandBottom = viewportHeight * BAND_BOTTOM;
      if (rect.top >= bandTop && rect.top <= bandBottom) return null;
      return Math.round(rect.top - viewportHeight * RESTING_FRACTION);
    },
  };
}
