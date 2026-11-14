/**
 * An in-memory `AudioQueueSink` driven by the fake clock (F§5.8). It models a queue that plays one chunk
 * at a time, a rate that scales wall time against media time, and the four events a sink reports. It
 * produces no audio.
 */

import type { AudioQueueSink } from "../player/interfaces";
import type { FakeClock } from "./fake-clock";

/** One queued chunk, exactly as `enqueue` receives it. */
interface QueueItem {
  chunkId: string;
  uri: string;
  durationMs: number;
}

/** The chunk currently on the sink, with the media position it had when playback last settled. */
interface ActiveChunk {
  item: QueueItem;
  positionMs: number;
  startedAt: number;
}

type SinkEvent = "chunk-start" | "chunk-end" | "queue-empty" | "error";
type SinkListener = (event: { chunkId?: string; error?: Error }) => void;

export class FakeSink implements AudioQueueSink {
  readonly maxRate: number;
  private readonly clock: FakeClock;
  private queue: QueueItem[] = [];
  private active: ActiveChunk | null = null;
  private playing = false;
  private rate = 1;
  private handle: number | null = null;
  private emptyReported = false;
  private disposed = false;
  private readonly listeners = new Map<SinkEvent, Set<SinkListener>>();

  constructor(options: { clock: FakeClock; maxRate?: number }) {
    this.clock = options.clock;
    this.maxRate = options.maxRate ?? 16;
  }

  enqueue(item: { chunkId: string; uri: string; durationMs: number }): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.queue.push({ ...item });
    this.emptyReported = false;
    if (this.playing && this.active === null) this.startNext();
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.cancelTimer();
    this.queue = [];
    this.active = null;
    this.playing = false;
    this.emptyReported = false;
    return Promise.resolve();
  }

  play(): Promise<void> {
    if (this.disposed || this.playing) return Promise.resolve();
    this.playing = true;
    if (this.active === null) {
      if (this.queue.length > 0) this.startNext();
      else this.reportEmpty();
    } else {
      this.active.startedAt = this.clock.now();
      this.schedule();
    }
    return Promise.resolve();
  }

  pause(): Promise<void> {
    if (!this.playing) return Promise.resolve();
    this.settle();
    this.playing = false;
    this.cancelTimer();
    return Promise.resolve();
  }

  seekInCurrent(ms: number): Promise<void> {
    const active = this.active;
    if (active === null) return Promise.resolve();
    active.positionMs = Math.min(Math.max(0, ms), active.item.durationMs);
    active.startedAt = this.clock.now();
    if (this.playing) this.schedule();
    return Promise.resolve();
  }

  setRate(rate: number): void {
    const next = Math.min(Math.max(rate, 0.01), this.maxRate);
    if (this.playing) this.settle();
    this.rate = next;
    if (this.playing && this.active !== null) {
      this.active.startedAt = this.clock.now();
      this.schedule();
    }
  }

  current(): { chunkId: string | null; positionMs: number } {
    const active = this.active;
    if (active === null) return { chunkId: null, positionMs: 0 };
    return { chunkId: active.item.chunkId, positionMs: this.livePosition() };
  }

  on(event: SinkEvent, cb: SinkListener): () => void {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  dispose(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.disposed = true;
    this.cancelTimer();
    this.queue = [];
    this.active = null;
    this.playing = false;
    this.listeners.clear();
    return Promise.resolve();
  }

  /** Simulate the queue running dry while the sink is still nominally playing. */
  emitQueueEmpty(): void {
    this.emit("queue-empty", {});
  }

  private startNext(): void {
    const item = this.queue.shift();
    if (item === undefined) {
      this.reportEmpty();
      return;
    }
    this.active = { item, positionMs: 0, startedAt: this.clock.now() };
    this.emit("chunk-start", { chunkId: item.chunkId });
    this.schedule();
  }

  private schedule(): void {
    this.cancelTimer();
    const active = this.active;
    if (active === null || !this.playing) return;
    const remaining = Math.max(0, active.item.durationMs - active.positionMs);
    this.handle = this.clock.setTimeout(() => this.complete(), remaining / this.rate);
  }

  private complete(): void {
    this.handle = null;
    const active = this.active;
    if (active === null) return;
    active.positionMs = active.item.durationMs;
    this.emit("chunk-end", { chunkId: active.item.chunkId });
    this.active = null;
    if (this.playing && this.queue.length > 0) {
      this.startNext();
    } else {
      this.playing = false;
      this.reportEmpty();
    }
  }

  private settle(): void {
    const active = this.active;
    if (active === null) return;
    const elapsed = this.clock.now() - active.startedAt;
    active.positionMs = Math.min(active.item.durationMs, active.positionMs + elapsed * this.rate);
    active.startedAt = this.clock.now();
  }

  private livePosition(): number {
    const active = this.active;
    if (active === null) return 0;
    if (!this.playing) return active.positionMs;
    return Math.min(active.item.durationMs, active.positionMs + (this.clock.now() - active.startedAt) * this.rate);
  }

  private cancelTimer(): void {
    if (this.handle !== null) {
      this.clock.clearTimeout(this.handle);
      this.handle = null;
    }
  }

  private reportEmpty(): void {
    if (this.emptyReported) return;
    this.emptyReported = true;
    this.emit("queue-empty", {});
  }

  private emit(event: SinkEvent, payload: { chunkId?: string; error?: Error }): void {
    const set = this.listeners.get(event);
    if (set === undefined) return;
    for (const cb of [...set]) cb(payload);
  }
}
