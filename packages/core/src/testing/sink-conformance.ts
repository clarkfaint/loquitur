/**
 * The conformance suite every `AudioQueueSink` implementation must pass (F§5.8). It is runner-agnostic:
 * it drives the sink only through the environment's `wait` and `makeChunk`, and returns one result per
 * case so a test can assert all of them or a platform can report which failed.
 */

import type { AudioQueueSink } from "../player/interfaces";

export interface SinkConformanceEnvironment {
  wait(ms: number): Promise<void>;
  makeChunk(durationMs: number): Promise<{ chunkId: string; uri: string; durationMs: number }>;
}

export interface SinkConformanceResult {
  name: string;
  ok: boolean;
  error?: string;
}

type SinkFactory = () => AudioQueueSink | Promise<AudioQueueSink>;

const STEP_MS = 25;
const EVENT_NAMES = ["chunk-start", "chunk-end", "queue-empty", "error"] as const;

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertOrder(actual: readonly string[], expected: readonly string[]): void {
  assert(actual.length === expected.length, `expected ${expected.length} events, got ${actual.length}: ${actual.join(", ")}`);
  for (const [index, name] of expected.entries()) {
    assert(actual[index] === name, `event ${index} was ${actual[index] ?? "nothing"}, expected ${name}`);
  }
}

/**
 * Run every F§5.8 sink case against `factory`. Each case gets a fresh sink, which is disposed afterwards
 * whether the case passed or failed.
 */
export async function runAudioQueueSinkConformance(
  factory: SinkFactory,
  env: SinkConformanceEnvironment,
): Promise<SinkConformanceResult[]> {
  const results: SinkConformanceResult[] = [];

  const record = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
      results.push({ name, ok: true });
    } catch (cause) {
      results.push({ name, ok: false, error: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const withSink = async (run: (sink: AudioQueueSink) => Promise<void>): Promise<void> => {
    const sink = await factory();
    try {
      await run(sink);
    } finally {
      await sink.dispose().catch(() => undefined);
    }
  };

  const recordEvents = (sink: AudioQueueSink): { events: string[]; stop: () => void } => {
    const events: string[] = [];
    const stops = EVENT_NAMES.map((name) =>
      sink.on(name, (event) => {
        events.push(event.chunkId === undefined ? name : `${name}:${event.chunkId}`);
      }),
    );
    return {
      events,
      stop: () => {
        for (const stop of stops) stop();
      },
    };
  };

  const waitFor = async (condition: () => boolean, timeoutMs: number): Promise<void> => {
    let waited = 0;
    while (!condition()) {
      assert(waited < timeoutMs, `timed out after ${waited} ms`);
      await env.wait(STEP_MS);
      waited += STEP_MS;
    }
  };

  await record("events fire in order across three chunks", () =>
    withSink(async (sink) => {
      const { events, stop } = recordEvents(sink);
      try {
        for (let index = 0; index < 3; index += 1) await sink.enqueue(await env.makeChunk(100));
        await sink.play();
        await waitFor(() => events.includes("queue-empty"), 2000);
        assertOrder(
          events.map((entry) => entry.split(":")[0] ?? ""),
          ["chunk-start", "chunk-end", "chunk-start", "chunk-end", "chunk-start", "chunk-end", "queue-empty"],
        );
      } finally {
        stop();
      }
    }),
  );

  await record("clear stops and empties", () =>
    withSink(async (sink) => {
      const { events, stop } = recordEvents(sink);
      try {
        await sink.enqueue(await env.makeChunk(200));
        await sink.enqueue(await env.makeChunk(200));
        await sink.play();
        await env.wait(50);
        await sink.clear();
        const before = events.length;
        await env.wait(400);
        assert(sink.current().chunkId === null, "clear left a current chunk");
        assert(events.length === before, "events kept firing after clear");
      } finally {
        stop();
      }
    }),
  );

  await record("pause freezes position", () =>
    withSink(async (sink) => {
      await sink.enqueue(await env.makeChunk(1000));
      await sink.play();
      await env.wait(200);
      await sink.pause();
      const frozen = sink.current().positionMs;
      await env.wait(300);
      const still = sink.current().positionMs;
      assert(frozen > 0, "position did not advance before the pause");
      assert(still === frozen, `position moved while paused: ${frozen} -> ${still}`);
    }),
  );

  await record("seekInCurrent moves position", () =>
    withSink(async (sink) => {
      await sink.enqueue(await env.makeChunk(1000));
      await sink.play();
      await env.wait(100);
      await sink.seekInCurrent(500);
      const position = sink.current().positionMs;
      assert(position >= 500 && position <= 600, `seekInCurrent landed at ${position} ms`);
    }),
  );

  await record("setRate(2) roughly halves wall time", async () => {
    const measure = async (rate: number): Promise<number> => {
      let elapsed = 0;
      await withSink(async (sink) => {
        await sink.enqueue(await env.makeChunk(1000));
        sink.setRate(rate);
        await sink.play();
        while (sink.current().chunkId !== null && elapsed < 4000) {
          await env.wait(STEP_MS);
          elapsed += STEP_MS;
        }
      });
      return elapsed;
    };
    const single = await measure(1);
    const double = await measure(2);
    assert(single > 0 && double > 0, `the sink never finished a chunk (${single} ms, ${double} ms)`);
    assert(double <= single * 0.65 && double >= single * 0.35, `rate 2 took ${double} ms against ${single} ms`);
  });

  await record("queue-empty fires once", () =>
    withSink(async (sink) => {
      const { events, stop } = recordEvents(sink);
      try {
        await sink.enqueue(await env.makeChunk(100));
        await sink.play();
        await waitFor(() => events.includes("queue-empty"), 2000);
        await env.wait(400);
        const count = events.filter((entry) => entry === "queue-empty").length;
        assert(count === 1, `queue-empty fired ${count} times`);
      } finally {
        stop();
      }
    }),
  );

  await record("dispose is idempotent", async () => {
    const sink = await factory();
    await sink.dispose();
    await sink.dispose();
  });

  return results;
}
