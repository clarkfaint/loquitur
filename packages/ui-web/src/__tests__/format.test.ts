/**
 * The three formatting functions (F§10.1), each with the wording the player bar shows.
 */

import { describe, expect, it } from "vitest";
import { formatRate, formatRemaining, formatWpm } from "../format";

describe("formatRate", () => {
  it("writes a fractional rate as a multiplier", () => {
    expect(formatRate(1.5)).toBe("1.5×");
  });

  it("drops the trailing zeros of a whole rate and of a half", () => {
    expect(formatRate(1)).toBe("1×");
    expect(formatRate(4.5)).toBe("4.5×");
    expect(formatRate(0.5)).toBe("0.5×");
  });

  it("keeps a hundredth that carries meaning", () => {
    expect(formatRate(1.25)).toBe("1.25×");
  });
});

describe("formatRemaining", () => {
  it("writes twelve minutes", () => {
    expect(formatRemaining(720_000)).toBe("12 min");
  });

  it("rounds a partial minute up rather than reporting it as finished", () => {
    expect(formatRemaining(30_000)).toBe("1 min");
    expect(formatRemaining(60_001)).toBe("2 min");
  });

  it("writes nothing left as no minutes", () => {
    expect(formatRemaining(0)).toBe("0 min");
    expect(formatRemaining(-1)).toBe("0 min");
  });
});

describe("formatWpm", () => {
  it("scales the reader's own pace by the rate", () => {
    expect(formatWpm(1.5, 170)).toBe("255 wpm");
    expect(formatWpm(1, 170)).toBe("170 wpm");
    expect(formatWpm(2, 170)).toBe("340 wpm");
  });
});
