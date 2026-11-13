/**
 * F§5.6(e)'s speed plan. The five golden plans are the architecture brief's own, verbatim; the sweep
 * below is the property that makes the plan worth having — the synthesizer's share never pushes the sink
 * past its ceiling, and the reader never hears more than the rate it asked for.
 */

import { expect, test } from "vitest";
import { clampRate, planSpeed, RATE_MAX, RATE_MIN, RATE_PRESETS, RATE_STEP } from "../speed";

/** The rates the control offers, in the order the brief gives them. */
const CONTROL_RATES: readonly number[] = Array.from({ length: 91 }, (_unused, step) => Number((RATE_MIN + step * RATE_STEP).toFixed(2)));

/** The sink ceilings the sweep covers: a slow sink, two old ones, and one that never binds. */
const SINK_MAX_RATES: readonly number[] = [1, 2, 4, 16];

test("the control's own numbers are F§5.6(e)'s", () => {
  expect(RATE_MIN).toBe(0.5);
  expect(RATE_MAX).toBe(5.0);
  expect(RATE_STEP).toBe(0.05);
  expect(RATE_PRESETS).toEqual([1, 1.5, 2, 3, 4.5]);
  expect(CONTROL_RATES).toHaveLength(91);
  expect(CONTROL_RATES[0]).toBe(0.5);
  expect(CONTROL_RATES[90]).toBe(5.0);
});

test("clampRate holds the offered range at and beyond both bounds", () => {
  expect(clampRate(RATE_MIN)).toBe(0.5);
  expect(clampRate(0.4)).toBe(0.5);
  expect(clampRate(-1)).toBe(0.5);
  expect(clampRate(2.35)).toBe(2.35);
  expect(clampRate(RATE_MAX)).toBe(5.0);
  expect(clampRate(5.1)).toBe(5.0);
});

test("F§5.6(e) golden — (1.5, 16) synthesizes at the user's own rate", () => {
  expect(planSpeed(1.5, 16)).toEqual({ synthSpeed: 1.0, sinkRate: 1.5, effectiveRate: 1.5 });
});

test("F§5.6(e) golden — (4.5, 2) splits the rate across synthesizer and sink", () => {
  expect(planSpeed(4.5, 2)).toEqual({ synthSpeed: 2.25, sinkRate: 2.0, effectiveRate: 4.5 });
});

test("F§5.6(e) golden — (5.0, 2) reaches the top of the quarter steps", () => {
  expect(planSpeed(5.0, 2)).toEqual({ synthSpeed: 2.5, sinkRate: 2.0, effectiveRate: 5.0 });
});

test("F§5.6(e) golden — (3.0, 2) leaves the sink at its ceiling", () => {
  expect(planSpeed(3.0, 2)).toEqual({ synthSpeed: 1.5, sinkRate: 2.0, effectiveRate: 3.0 });
});

test("F§5.6(e) golden — (5.0, 1) stops at the synthesizer's own ceiling", () => {
  expect(planSpeed(5.0, 1)).toEqual({ synthSpeed: 4.0, sinkRate: 1.0, effectiveRate: 4.0 });
});

test("effectiveRate never exceeds the rate the user asked for", () => {
  for (const rate of CONTROL_RATES) {
    for (const sinkMaxRate of SINK_MAX_RATES) {
      const plan = planSpeed(rate, sinkMaxRate);
      expect(plan.effectiveRate).toBeLessThanOrEqual(rate);
      expect(plan.effectiveRate).toBeGreaterThan(0);
      expect(plan.synthSpeed).toBeGreaterThanOrEqual(1.0);
      expect(plan.synthSpeed).toBeLessThanOrEqual(4.0);
      expect(Number.isInteger(plan.synthSpeed * 4)).toBe(true);
      expect(plan.sinkRate).toBeLessThanOrEqual(sinkMaxRate);
      expect(plan.sinkRate).toBeGreaterThan(0);
    }
  }
});

test("one cached chunk serves every rate a sink can reach on its own", () => {
  for (const rate of CONTROL_RATES) {
    if (rate <= 4) expect(planSpeed(rate, 16).synthSpeed).toBe(1.0);
  }
});
