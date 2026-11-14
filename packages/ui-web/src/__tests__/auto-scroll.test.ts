/**
 * The auto-scroll policy's own behaviour (F§10.1): the band the active line may sit in, where it is put
 * once it leaves that band, and the four seconds of silence after the reader scrolls by hand. The clock
 * is injected, so every case here is arithmetic rather than a race with the scheduler.
 *
 * The number a case receives is a *scroll delta*: it is added to the page's scroll offset, so the line's
 * place in the viewport moves by the same amount in the other direction — `top - delta` is where the
 * line ends up, and every case below asserts that directly.
 */

import { describe, expect, it } from "vitest";
import { type AutoScrollPolicy, createAutoScroll } from "../scroll/auto-scroll";

/** A viewport height that makes the band and the resting place whole numbers: 30 % is 240, 45 % is 360. */
const VIEWPORT = 800;

/** The band's edges and the resting place, for the viewport above. */
const BAND_TOP = 240;
const BAND_BOTTOM = 480;
const RESTING = 360;

/** A clock a test moves by hand, so a suspension is measured and never waited for. */
function fakeClock(startMs = 0) {
  let nowMs = startMs;
  return {
    clock: { now: () => nowMs },
    advance(ms: number): void {
      nowMs += ms;
    },
  };
}

/** A policy over a clock the test owns. */
function policyAt(startMs = 0): { policy: AutoScrollPolicy; advance: (ms: number) => void } {
  const { clock, advance } = fakeClock(startMs);
  return { policy: createAutoScroll({ clock, suspendMs: 4000 }), advance };
}

describe("auto-scroll band", () => {
  it("does not scroll while the active line is inside the band", () => {
    const { policy } = policyAt();
    expect(policy.target({ top: BAND_TOP }, VIEWPORT)).toBeNull();
    expect(policy.target({ top: RESTING }, VIEWPORT)).toBeNull();
    expect(policy.target({ top: BAND_BOTTOM }, VIEWPORT)).toBeNull();
  });

  it("scrolls up when the line has risen above the band, and to the resting place", () => {
    const { policy } = policyAt();
    const top = 100;
    const delta = policy.target({ top }, VIEWPORT);
    expect(delta).toBe(top - RESTING);
    expect(top - (delta ?? 0)).toBe(RESTING);
  });

  it("scrolls down when the line has fallen below the band", () => {
    const { policy } = policyAt();
    const top = 700;
    const delta = policy.target({ top }, VIEWPORT);
    expect(delta).toBe(top - RESTING);
    expect(top - (delta ?? 0)).toBe(RESTING);
  });

  it("puts a line that left the band back inside it, not on an edge", () => {
    const { policy } = policyAt();
    const top = BAND_BOTTOM + 1;
    const restingTop = top - (policy.target({ top }, VIEWPORT) ?? 0);
    expect(restingTop).toBeGreaterThan(BAND_TOP);
    expect(restingTop).toBeLessThan(BAND_BOTTOM);
  });

  it("stays put for a viewport it cannot measure", () => {
    const { policy } = policyAt();
    expect(policy.target({ top: 700 }, 0)).toBeNull();
    expect(policy.target({ top: 700 }, -10)).toBeNull();
    expect(policy.target({ top: 700 }, Number.NaN)).toBeNull();
    expect(policy.target({ top: Number.NaN }, VIEWPORT)).toBeNull();
  });
});

describe("auto-scroll suspension", () => {
  it("suspends for four seconds after the reader scrolls, then resumes on its own", () => {
    const { policy, advance } = policyAt();
    const outOfBand = { top: 100 };

    expect(policy.target(outOfBand, VIEWPORT)).toBe(100 - RESTING);

    policy.onUserScroll();
    expect(policy.target(outOfBand, VIEWPORT)).toBeNull();

    advance(3999);
    expect(policy.target(outOfBand, VIEWPORT)).toBeNull();

    advance(1);
    expect(policy.target(outOfBand, VIEWPORT)).toBe(100 - RESTING);
  });

  it("extends the suspension when the reader scrolls again", () => {
    const { policy, advance } = policyAt();
    const outOfBand = { top: 700 };

    policy.onUserScroll();
    advance(3000);
    policy.onUserScroll();
    advance(3000);
    expect(policy.target(outOfBand, VIEWPORT)).toBeNull();

    advance(1000);
    expect(policy.target(outOfBand, VIEWPORT)).toBe(700 - RESTING);
  });

  it("still reports nothing to do while suspended, even for a line inside the band", () => {
    const { policy } = policyAt();
    policy.onUserScroll();
    expect(policy.target({ top: RESTING }, VIEWPORT)).toBeNull();
  });
});
