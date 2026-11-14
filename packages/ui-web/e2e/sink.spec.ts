/**
 * The web sink in a real browser (U-024). Playback timing, pitch correction and blob preloading are the
 * browser's own behaviour, so every case here runs in Chromium against the harness page.
 */

import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => typeof window.runSinkConformance === "function");
});

test("passes every case of the core conformance suite", async ({ page }) => {
  test.setTimeout(60_000);
  const results = await page.evaluate(() => window.runSinkConformance());
  expect(results.filter((result) => !result.ok)).toEqual([]);
  expect(results).toHaveLength(7);
});

test("keeps pitch and reports the requested rate on the playing element", async ({ page }) => {
  const probe = await page.evaluate(async () => {
    const sink = window.createSink();
    await sink.enqueue(await window.makeChunk(5000));
    sink.setRate(4.5);
    await sink.play();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const reading = window.sinkProbe();
    await sink.dispose();
    return reading;
  });
  expect(probe.playbackRate).toBe(4.5);
  expect(probe.preservesPitch).toBe(true);
});

test("plays three 600 ms chunks at rate 2 inside 700–1400 ms", async ({ page }) => {
  test.setTimeout(60_000);
  const report = await page.evaluate(async () => {
    const sink = window.createSink();
    const chunks = [await window.makeChunk(600), await window.makeChunk(600), await window.makeChunk(600)];
    const drained = new Promise<void>((resolve, reject) => {
      sink.on("queue-empty", () => resolve());
      sink.on("error", (event) => reject(event.error ?? new Error("the sink reported an error")));
    });
    for (const chunk of chunks) await sink.enqueue(chunk);
    sink.setRate(2);
    const started = performance.now();
    await sink.play();
    await drained;
    const wallMs = Math.round(performance.now() - started);
    await sink.dispose();
    return { durations: chunks.map((chunk) => chunk.durationMs), wallMs };
  });
  expect(report.durations).toEqual([600, 600, 600]);
  expect(report.wallMs).toBeGreaterThanOrEqual(700);
  expect(report.wallMs).toBeLessThanOrEqual(1400);
});
