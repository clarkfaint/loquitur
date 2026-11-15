/**
 * The queue map's own tests (AGENTS.md §7).
 *
 * `queue-map.ts` is the only module of this unit that can run under Node: the sink, the audio session and the
 * diagnostics check all stand on `expo-audio`, whose native objects exist on a device and nowhere else. The
 * sink's own measure is F§5.8's conformance suite, run against the real queue by the `audio-sink` check this
 * unit registers on the diagnostics screen — the events these cases expect are the ones that suite asserts in
 * order (`chunk-start`, `chunk-end` … `queue-empty`) — and U-052 verifies that run on a device.
 *
 * Every case here is a report the platform really makes: a first start, a move forward, a jump, and the end of
 * the queue, which arrives as a report whose two indexes are equal.
 */

import { describe, expect, it } from "vitest";
import { createQueueMap, NO_PREVIOUS_INDEX, type QueueMap } from "../queue-map";

/** A map holding `chunkIds`, in playlist order. */
function mapWith(...chunkIds: string[]): QueueMap {
  const map = createQueueMap();
  for (const chunkId of chunkIds) map.append(chunkId);
  return map;
}

describe("the queue map", () => {
  it("numbers the chunks in playlist order", () => {
    const map = createQueueMap();
    expect(map.append("a")).toBe(0);
    expect(map.append("b")).toBe(1);
    expect(map.append("c")).toBe(2);
  });

  it("starts the first chunk when playback begins, because the platform reports no such change", () => {
    const map = mapWith("a", "b");
    expect(map.onTrackChanged(NO_PREVIOUS_INDEX, 0)).toEqual([{ type: "chunk-start", chunkId: "a" }]);
    expect(map.currentChunk()).toBe("a");
  });

  it("ends the chunk it leaves and starts the one it lands on", () => {
    const map = mapWith("a", "b", "c");
    map.onTrackChanged(NO_PREVIOUS_INDEX, 0);
    expect(map.onTrackChanged(0, 1)).toEqual([
      { type: "chunk-end", chunkId: "a" },
      { type: "chunk-start", chunkId: "b" },
    ]);
    expect(map.currentChunk()).toBe("b");
  });

  it("does the same for a skip ahead", () => {
    const map = mapWith("a", "b", "c", "d");
    map.onTrackChanged(NO_PREVIOUS_INDEX, 0);
    expect(map.onTrackChanged(0, 3)).toEqual([
      { type: "chunk-end", chunkId: "a" },
      { type: "chunk-start", chunkId: "d" },
    ]);
    expect(map.currentChunk()).toBe("d");
  });

  it("does the same for a jump backwards", () => {
    const map = mapWith("a", "b", "c");
    map.onTrackChanged(NO_PREVIOUS_INDEX, 2);
    expect(map.onTrackChanged(2, 1)).toEqual([
      { type: "chunk-end", chunkId: "c" },
      { type: "chunk-start", chunkId: "b" },
    ]);
    expect(map.currentChunk()).toBe("b");
  });

  it("ends the final chunk and empties the queue when the queue runs out", () => {
    const map = mapWith("a", "b", "c");
    map.onTrackChanged(NO_PREVIOUS_INDEX, 2);
    expect(map.onTrackChanged(2, 2)).toEqual([{ type: "chunk-end", chunkId: "c" }, { type: "queue-empty" }]);
    expect(map.currentChunk()).toBeNull();
  });

  it("reports that end once, however many times the platform says it", () => {
    const map = mapWith("a", "b");
    map.onTrackChanged(NO_PREVIOUS_INDEX, 1);
    map.onTrackChanged(1, 1);
    expect(map.onTrackChanged(1, 1)).toEqual([]);
    expect(map.currentChunk()).toBeNull();
  });

  it("starts the next chunk after a drain without ending the finished one twice", () => {
    const map = mapWith("a", "b");
    map.onTrackChanged(NO_PREVIOUS_INDEX, 1);
    map.onTrackChanged(1, 1);
    const appended = map.append("c");

    expect(map.onTrackChanged(1, appended)).toEqual([{ type: "chunk-start", chunkId: "c" }]);
    expect(map.currentChunk()).toBe("c");
  });

  it("says nothing about an index it holds no chunk for", () => {
    const map = mapWith("a", "b");
    expect(map.onTrackChanged(NO_PREVIOUS_INDEX, 4)).toEqual([]);
    expect(map.currentChunk()).toBeNull();
  });

  it("treats a report about the chunk it is already on as no change", () => {
    const map = mapWith("a", "b");
    map.onTrackChanged(NO_PREVIOUS_INDEX, 0);
    expect(map.onTrackChanged(NO_PREVIOUS_INDEX, 0)).toEqual([]);
    expect(map.currentChunk()).toBe("a");
  });

  it("forgets everything on reset, and numbers the next chunk from zero again", () => {
    const map = mapWith("a", "b");
    map.onTrackChanged(NO_PREVIOUS_INDEX, 1);

    map.reset();

    expect(map.currentChunk()).toBeNull();
    expect(map.onTrackChanged(1, 1)).toEqual([]);
    expect(map.append("c")).toBe(0);
    expect(map.onTrackChanged(NO_PREVIOUS_INDEX, 0)).toEqual([{ type: "chunk-start", chunkId: "c" }]);
  });
});
