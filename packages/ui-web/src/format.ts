/**
 * Number formatting for the player bar (F§10.1). Three pure functions, so the strings a reader sees
 * are testable without a DOM and the same wording is used wherever a rate, a remaining time or a
 * reading speed is shown.
 */

/** Which fraction of the current rate the words-per-minute readout is derived from (F§5.6(f)). */
const MILLISECONDS_PER_MINUTE = 60_000;
/** How many decimal places a rate is written with before the trailing zeros are dropped. */
const RATE_DECIMALS = 2;

/**
 * `formatRate(1.5) → "1.5×"`. A rate is written with at most two decimals and no trailing zeros, so
 * `1` is `"1×"`, `4.5` is `"4.5×"` and `0.5` is `"0.5×"`.
 */
export function formatRate(rate: number): string {
  const trimmed = rate.toFixed(RATE_DECIMALS).replace(/\.?0+$/u, "");
  return `${trimmed}×`;
}

/**
 * `formatRemaining(720000) → "12 min"`. The remaining time is measured in whole minutes and rounded
 * up, because a countdown that reads "1 min" while 90 seconds stay is closer to the truth than one
 * that reads "2 min"; a time that has run out is `"0 min"`.
 */
export function formatRemaining(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 min";
  return `${Math.ceil(ms / MILLISECONDS_PER_MINUTE)} min`;
}

/**
 * `formatWpm(rate, baseWpm) → "255 wpm"`. The reader's own pace is the base words per minute
 * (F§5.6(f)); the rate scales it, so the number follows the speed control.
 */
export function formatWpm(rate: number, baseWpm: number): string {
  return `${Math.round(rate * baseWpm)} wpm`;
}
