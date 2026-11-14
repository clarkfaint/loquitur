/**
 * A deterministic `ChunkSource` for tests (F§5.8). Every request is recorded, every chunk is apportioned
 * with `estimateTimings`, and a test can inject a clock-driven delay and a number of leading failures.
 */

import type { ChunkRef, ChunkSource } from "../player/interfaces";
import { estimateTimings } from "../timing";
import type { FakeClock } from "./fake-clock";

/** One recorded request, exactly as `ChunkSource.get` receives it. */
export interface FakeChunkRequest {
  text: string;
  voiceId: string;
  synthSpeed: number;
}

export interface FakeChunkSourceOptions {
  clock: FakeClock;
  delayMs?: number;
  durationMs?: number;
  failures?: number;
}

export class FakeChunkSource implements ChunkSource {
  private readonly clock: FakeClock;
  private readonly requests: FakeChunkRequest[] = [];
  private delayMs: number;
  private readonly durationMs: number;
  private failures: number;
  private counter = 0;

  constructor(options: FakeChunkSourceOptions) {
    this.clock = options.clock;
    this.delayMs = options.delayMs ?? 0;
    this.durationMs = options.durationMs ?? 1000;
    this.failures = options.failures ?? 0;
  }

  get(req: FakeChunkRequest): Promise<ChunkRef> {
    this.requests.push({ ...req });
    const index = this.requests.length;
    const failNow = this.failures > 0;
    if (failNow) this.failures -= 1;
    return this.resolve(req, index, failNow);
  }

  /** Every request the source has received, in order. */
  getRequests(): readonly FakeChunkRequest[] {
    return this.requests;
  }

  setDelay(ms: number): void {
    this.delayMs = ms;
  }

  failNext(count = 1): void {
    this.failures = count;
  }

  reset(): void {
    this.requests.length = 0;
    this.failures = 0;
    this.counter = 0;
  }

  private async resolve(req: FakeChunkRequest, index: number, failNow: boolean): Promise<ChunkRef> {
    if (this.delayMs > 0) await this.wait(this.delayMs);
    if (failNow) throw new Error(`fake chunk source failed request ${index}`);
    this.counter += 1;
    const words = req.text.split(/\s+/).filter((word) => word.length > 0);
    const duration = Math.max(1, this.durationMs);
    return {
      chunkId: `fake-chunk-${this.counter}`,
      uri: `memory://fake-chunk-${this.counter}`,
      durationMs: duration,
      timings: estimateTimings(words, duration),
      timingSource: "estimated",
    };
  }

  private wait(ms: number): Promise<void> {
    return new Promise((done) => {
      this.clock.setTimeout(done, ms);
    });
  }
}
