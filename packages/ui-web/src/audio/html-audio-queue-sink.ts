/**
 * The web `AudioQueueSink` (F§5.8): two `<audio>` elements that take turns. One plays the current chunk
 * while the other already holds the next one decoded, so a hand-over between sentences is a `play()` on
 * warm bytes instead of a fresh load, and the queue drains without a gap a listener would hear.
 *
 * The elements never join the document: they exist in memory only, so the page showing the reader is
 * handed no stray media node. `preservesPitch` stays on and the rate goes onto both elements at once
 * (F§5.8), which lets one synthesized chunk serve every speed up to `maxRate`.
 */

import type { AudioQueueSink } from "@lectern/core";

/** F§5.8's ceiling for this sink: past it a user's speed is bought from synthesis instead (F§5.6(e)). */
const MAX_RATE = 16;

/** The slowest rate a media element accepts — below it `playbackRate` is refused outright. */
const MIN_RATE = 0.0625;

/** F§5.8's two elements, in the order a chunk is preloaded onto them. */
const SIDES: readonly Side[] = [0, 1];

/** The name a `play()` promise rejects with when a pause, a clear or a hand-over interrupted it. */
const INTERRUPTED = "AbortError";

type Side = 0 | 1;
type SinkEvent = "chunk-start" | "chunk-end" | "queue-empty" | "error";
type SinkListener = (event: { chunkId?: string; error?: Error }) => void;

/** One queued chunk, exactly as `enqueue` receives it. */
interface QueueItem {
  chunkId: string;
  uri: string;
  durationMs: number;
}

/** One media element and the chunk it currently holds. */
interface Slot {
  element: HTMLAudioElement;
  item: QueueItem | null;
  /** Bumped whenever the element is reloaded, so a handler left over from the previous chunk is ignored. */
  token: number;
  /** Removes this slot's own listeners; set while the element carries a chunk. */
  detach: (() => void) | null;
}

/** A media element the sink owns: never attached to the document, never autoplaying. */
function createSlot(): Slot {
  const element = new Audio();
  element.preload = "auto";
  element.preservesPitch = true;
  return { element, item: null, token: 0, detach: null };
}

/**
 * `createHtmlAudioQueueSink()` — the browser's `AudioQueueSink` (F§5.8). The active element plays while
 * the idle one is loaded with the next chunk as soon as it is enqueued, so `play()` and every hand-over
 * find bytes ready. `maxRate` is 16, so no rate a reader can choose is split off to synthesis.
 */
export function createHtmlAudioQueueSink(): AudioQueueSink {
  const slots: [Slot, Slot] = [createSlot(), createSlot()];
  const pending: QueueItem[] = [];
  const listeners = new Map<SinkEvent, Set<SinkListener>>();
  let active: Side | null = null;
  let playing = false;
  let rate = 1;
  let emptyReported = false;
  let disposed = false;

  const slotAt = (side: Side): Slot => (side === 0 ? slots[0] : slots[1]);
  const other = (side: Side): Side => (side === 0 ? 1 : 0);
  const loaded = (side: Side): boolean => slotAt(side).item !== null;

  function emit(event: SinkEvent, payload: { chunkId?: string; error?: Error }): void {
    const set = listeners.get(event);
    if (set === undefined) return;
    for (const listener of [...set]) listener(payload);
  }

  /** A queue that has run dry is reported once, and again only after something new is enqueued (F§5.8). */
  function reportEmpty(): void {
    if (emptyReported) return;
    emptyReported = true;
    emit("queue-empty", {});
  }

  function reportFailure(error: Error): void {
    if (disposed) return;
    emit("error", { error });
  }

  /** Stop the element in this slot and forget its chunk, cutting off that chunk's listeners first. */
  function unload(side: Side): void {
    const slot = slotAt(side);
    slot.detach?.();
    slot.detach = null;
    slot.token += 1;
    slot.item = null;
    slot.element.pause();
    slot.element.removeAttribute("src");
  }

  /** Load `item` onto an idle element: the preload that makes the next hand-over immediate. */
  function load(side: Side, item: QueueItem): void {
    unload(side);
    const slot = slotAt(side);
    slot.item = item;
    const element = slot.element;
    element.src = item.uri;
    element.load();
    // Loading a source restores `defaultPlaybackRate`, so the current rate is pinned again right after.
    element.defaultPlaybackRate = rate;
    element.playbackRate = rate;
    const token = slot.token;
    const onEnded = (): void => {
      if (slot.token === token) handleEnded(side);
    };
    const onError = (): void => {
      if (slot.token === token) handleError(side);
    };
    element.addEventListener("ended", onEnded);
    element.addEventListener("error", onError);
    slot.detach = () => {
      element.removeEventListener("ended", onEnded);
      element.removeEventListener("error", onError);
    };
  }

  /** The element an incoming chunk may be preloaded onto: never the one that is playing. */
  function idle(): Side | null {
    for (const side of SIDES) {
      if (active !== side && !loaded(side)) return side;
    }
    return null;
  }

  /** The slot holding a chunk that is ready to play, in preload order. */
  function loadedSide(): Side | null {
    for (const side of SIDES) {
      if (loaded(side)) return side;
    }
    return null;
  }

  function takePending(side: Side): void {
    const item = pending.shift();
    if (item !== undefined) load(side, item);
  }

  /** Preload every queued chunk the two elements can hold. */
  function fill(): void {
    let side = idle();
    while (side !== null && pending.length > 0) {
      takePending(side);
      side = idle();
    }
  }

  /** Start the element in this slot, reporting the one error a browser's autoplay rules can produce. */
  function resume(side: Side): void {
    const slot = slotAt(side);
    const token = slot.token;
    void slot.element.play().catch((cause: unknown) => {
      if (slot.token !== token) return;
      if (cause instanceof DOMException && cause.name === INTERRUPTED) return;
      reportFailure(cause instanceof Error ? cause : new Error(String(cause)));
    });
  }

  function start(side: Side): void {
    const item = slotAt(side).item;
    if (item === null) return;
    active = side;
    emit("chunk-start", { chunkId: item.chunkId });
    resume(side);
  }

  /** A chunk finished: hand the next one over, or report the queue dry when there is none. */
  function handleEnded(side: Side): void {
    if (active !== side) return;
    const finished = slotAt(side).item;
    if (finished !== null) emit("chunk-end", { chunkId: finished.chunkId });
    unload(side);
    active = null;
    const next = other(side);
    if (!loaded(next)) takePending(next);
    if (loaded(next)) start(next);
    else {
      playing = false;
      reportEmpty();
    }
    fill();
  }

  function handleError(side: Side): void {
    if (active !== side) return;
    const failure = slotAt(side).element.error;
    reportFailure(new Error(failure === null ? "the audio element failed" : `the audio element failed: ${failure.message}`));
  }

  /** The slot to continue with when playback is asked for again, or `null` when nothing is loaded. */
  function resumableSide(): Side | null {
    if (active !== null) return active;
    return loadedSide();
  }

  const sink: AudioQueueSink = {
    maxRate: MAX_RATE,

    async enqueue(item: { chunkId: string; uri: string; durationMs: number }): Promise<void> {
      if (disposed) return;
      pending.push({ ...item });
      emptyReported = false;
      fill();
      // A chunk arriving after `play()` continues the playback that was asked for; it never starts one.
      if (playing && active === null) {
        const side = loadedSide();
        if (side !== null) start(side);
      }
    },

    async clear(): Promise<void> {
      pending.length = 0;
      for (const side of SIDES) unload(side);
      active = null;
      playing = false;
      emptyReported = false;
    },

    async play(): Promise<void> {
      if (disposed || playing) return;
      playing = true;
      const side = resumableSide();
      if (side === null) {
        reportEmpty();
        return;
      }
      if (active === null) start(side);
      else resume(side);
      fill();
    },

    async pause(): Promise<void> {
      if (!playing) return;
      playing = false;
      if (active !== null) slotAt(active).element.pause();
    },

    async seekInCurrent(ms: number): Promise<void> {
      if (active === null) return;
      const slot = slotAt(active);
      const durationMs = slot.item?.durationMs ?? 0;
      slot.element.currentTime = Math.min(Math.max(0, ms), durationMs) / 1000;
    },

    setRate(next: number): void {
      rate = Math.min(Math.max(next, MIN_RATE), MAX_RATE);
      for (const side of SIDES) {
        const element = slotAt(side).element;
        // Both halves move together: `load()` restores `defaultPlaybackRate` onto `playbackRate`.
        element.defaultPlaybackRate = rate;
        element.playbackRate = rate;
      }
    },

    current(): { chunkId: string | null; positionMs: number } {
      if (active === null) return { chunkId: null, positionMs: 0 };
      const slot = slotAt(active);
      const item = slot.item;
      if (item === null) return { chunkId: null, positionMs: 0 };
      return { chunkId: item.chunkId, positionMs: Math.round(slot.element.currentTime * 1000) };
    },

    on(event: SinkEvent, cb: SinkListener): () => void {
      const set = listeners.get(event) ?? new Set<SinkListener>();
      listeners.set(event, set);
      set.add(cb);
      return () => {
        set.delete(cb);
      };
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await sink.clear();
      listeners.clear();
    },
  };

  return sink;
}
