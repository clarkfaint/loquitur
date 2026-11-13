/**
 * Playback speed (F§5.6(e)). The reader offers one rate; the synthesizer and the audio sink each have
 * their own ceiling, so a user rate is expressed as a pair — how fast the chunk was synthesized, and how
 * fast the sink plays it back. The synthesizer's speed is normally exactly 1.0, which is what lets one
 * cached chunk serve every speed the reader offers.
 */

/** The slowest rate the reader offers (F§5.6(e)). */
export const RATE_MIN = 0.5;
/** The fastest rate the reader offers (F§5.6(e)). */
export const RATE_MAX = 5.0;
/** The spacing of the rate control (F§5.6(e)). */
export const RATE_STEP = 0.05;
/** The rates the control offers directly (F§5.6(e)). */
export const RATE_PRESETS: readonly number[] = [1, 1.5, 2, 3, 4.5];

/** One user rate, split into what the synthesizer produces and what the sink plays (F§5.6(e)). */
export interface SpeedPlan {
  synthSpeed: number;
  sinkRate: number;
  effectiveRate: number;
}

/** The synthesizer's own bounds for a planned speed (F§5.6(e)). */
const SYNTH_SPEED_MIN = 1.0;
const SYNTH_SPEED_MAX = 4.0;
/** The granularity of a planned synthesizer speed (F§5.6(e)). */
const QUARTER = 0.25;

/** Pull a rate back inside the range the reader offers (F§5.6(e)). */
export function clampRate(rate: number): number {
  return Math.min(RATE_MAX, Math.max(RATE_MIN, rate));
}

/** `ceilToQuarter(x)` — the next multiple of 0.25 at or above `x` (F§5.6(e)). */
function ceilToQuarter(value: number): number {
  return Math.ceil(value / QUARTER) * QUARTER;
}

/**
 * `planSpeed(rate, sinkMaxRate)` — F§5.6(e). Whatever the sink cannot reach, the synthesizer takes as a
 * whole multiple of a quarter, bounded to 1.0–4.0; the sink then takes what is left of the rate, up to its
 * own ceiling. `effectiveRate` is their product: normally the user's rate exactly, and never above it.
 */
export function planSpeed(rate: number, sinkMaxRate: number): SpeedPlan {
  const synthSpeed = Math.min(SYNTH_SPEED_MAX, Math.max(SYNTH_SPEED_MIN, ceilToQuarter(rate / sinkMaxRate)));
  const sinkRate = Math.min(sinkMaxRate, rate / synthSpeed);
  return { synthSpeed, sinkRate, effectiveRate: synthSpeed * sinkRate };
}
