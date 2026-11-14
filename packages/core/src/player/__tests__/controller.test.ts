/**
 * U-013's tests: one per row of the F§5.7 transition table, the three rules under it, and the F§5.8 sink
 * conformance suite run against the fake sink. Everything is driven by the fake clock, so the file is
 * deterministic and plays no audio.
 */

import { expect, test } from "vitest";
import { buildDocument, type RawBlock } from "../../builder";
import type { DocumentModel } from "../../model";
import { FakeChunkSource } from "../../testing/fake-chunk-source";
import { FakeClock } from "../../testing/fake-clock";
import { FakeSink } from "../../testing/fake-sink";
import { runAudioQueueSinkConformance } from "../../testing/sink-conformance";
import { createPlayerController, type PlayerController, type PlayerSettings } from "../controller";

interface Harness {
  controller: PlayerController;
  clock: FakeClock;
  sink: FakeSink;
  chunks: FakeChunkSource;
  document: DocumentModel;
}

const DEFAULT_PARAGRAPHS = ["One two three.", "Four five six.", "Seven eight.", "Nine ten.", "Eleven twelve.", "Thirteen."];

function documentFrom(paragraphs: string[], withFurniture = false): DocumentModel {
  const raw: RawBlock[] = paragraphs.map((text) => ({ kind: "paragraph" as const, text }));
  if (withFurniture) raw.splice(1, 0, { kind: "header" as const, text: "Running head" });
  return buildDocument(raw, { title: "Test document", source: { kind: "txt" } });
}

function harness(
  options: { document?: DocumentModel; maxRate?: number; delayMs?: number; failures?: number; skipFurniture?: boolean } = {},
): Harness {
  const clock = new FakeClock();
  const sink = new FakeSink({ clock, maxRate: options.maxRate ?? 16 });
  const chunks = new FakeChunkSource({
    clock,
    delayMs: options.delayMs ?? 0,
    durationMs: 1000,
    failures: options.failures ?? 0,
  });
  const document = options.document ?? documentFrom(DEFAULT_PARAGRAPHS);
  const settings: PlayerSettings = {
    skipFurniture: options.skipFurniture ?? true,
    skipCitations: false,
    lookaheadMs: 0,
  };
  const controller = createPlayerController({
    sink,
    chunks,
    clock,
    documents: { get: async (docId) => (docId === document.docId ? document : null) },
    settings,
  });
  return { controller, clock, sink, chunks, document };
}

async function start(h: Harness): Promise<void> {
  await h.controller.dispatch({ type: "load", docId: h.document.docId });
  await h.controller.dispatch({ type: "play" });
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

test("rows 1–2: load moves idle → loading → ready and sets the position", async () => {
  const h = harness();
  expect(h.controller.snapshot().state).toBe("idle");
  const pending = h.controller.dispatch({ type: "load", docId: h.document.docId });
  expect(h.controller.snapshot().state).toBe("loading");
  expect(h.controller.snapshot().docId).toBe(h.document.docId);
  await pending;
  expect(h.controller.snapshot().state).toBe("ready");
  expect(h.controller.snapshot().sentenceIndex).toBe(0);
  await h.controller.dispose();
});

test("row 2: an unknown document enters error instead of ready", async () => {
  const h = harness();
  await h.controller.dispatch({ type: "load", docId: "missing" });
  expect(h.controller.snapshot().state).toBe("error");
  expect(h.controller.snapshot().error?.code).toBe("DOCUMENT_NOT_FOUND");
  await h.controller.dispose();
});

test("rows 3–4: play requests the window, buffers, then plays on the first chunk", async () => {
  const h = harness();
  await h.controller.dispatch({ type: "load", docId: h.document.docId });
  const pending = h.controller.dispatch({ type: "play" });
  expect(h.controller.snapshot().state).toBe("buffering");
  await pending;
  expect(h.controller.snapshot().state).toBe("playing");
  expect(h.sink.current().chunkId).not.toBeNull();
  await h.controller.dispose();
});

test("row 5: pause stops the sink and stays paused while time passes", async () => {
  const h = harness();
  await start(h);
  h.clock.advance(300);
  await flush();
  await h.controller.dispatch({ type: "pause" });
  expect(h.controller.snapshot().state).toBe("paused");
  const frozen = h.sink.current().positionMs;
  h.clock.advance(5000);
  await flush();
  expect(h.controller.snapshot().state).toBe("paused");
  expect(h.sink.current().positionMs).toBe(frozen);
  await h.controller.dispose();
});

test("row 6: a chunk-end advances the sentence and tops up the queue", async () => {
  const h = harness();
  await start(h);
  const before = h.chunks.getRequests().length;
  h.clock.advance(1000);
  await flush();
  expect(h.controller.snapshot().state).toBe("playing");
  expect(h.controller.snapshot().sentenceIndex).toBe(1);
  expect(h.chunks.getRequests().length).toBeGreaterThan(before);
  await h.controller.dispose();
});

test("row 7: a queue-empty with the next chunk pending buffers until it arrives", async () => {
  const h = harness({ document: documentFrom(["One two.", "Three four."]), delayMs: 5000 });
  await h.controller.dispatch({ type: "load", docId: h.document.docId });
  const pending = h.controller.dispatch({ type: "play" });
  h.clock.advance(5000);
  await flush();
  expect(h.controller.snapshot().state).toBe("playing");
  h.clock.advance(1000);
  await flush();
  expect(h.controller.snapshot().state).toBe("buffering");
  h.clock.advance(4000);
  await flush();
  expect(h.controller.snapshot().state).toBe("playing");
  await pending;
  await h.controller.dispose();
});

test("row 8: the last chunk-end ends the document at its last sentence", async () => {
  const h = harness({ document: documentFrom(["Only one.", "And two."]) });
  await start(h);
  h.clock.advance(1000);
  await flush();
  h.clock.advance(1000);
  await flush();
  expect(h.controller.snapshot().state).toBe("ended");
  expect(h.controller.snapshot().sentenceIndex).toBe(1);
  await h.controller.dispose();
});

test("row 9: seek while playing resumes from the new sentence", async () => {
  const h = harness();
  await start(h);
  await h.controller.dispatch({ type: "seek", sentenceIndex: 3 });
  expect(h.controller.snapshot().state).toBe("playing");
  expect(h.controller.snapshot().sentenceIndex).toBe(3);
  expect(h.sink.current().chunkId).not.toBeNull();
  await h.controller.dispose();
});

test("row 9: seek while paused stays paused", async () => {
  const h = harness();
  await start(h);
  await h.controller.dispatch({ type: "pause" });
  await h.controller.dispatch({ type: "seek", sentenceIndex: 2 });
  expect(h.controller.snapshot().state).toBe("paused");
  expect(h.controller.snapshot().sentenceIndex).toBe(2);
  await h.controller.dispose();
});

test("row 9: skip moves by sentences in playback order, forwards and back", async () => {
  const h = harness();
  await start(h);
  await h.controller.dispatch({ type: "skip", sentences: 2 });
  expect(h.controller.snapshot().sentenceIndex).toBe(2);
  await h.controller.dispatch({ type: "skip", sentences: -1 });
  expect(h.controller.snapshot().sentenceIndex).toBe(1);
  await h.controller.dispose();
});

test("row 9: setVoice refills the queue with the new voice and resumes", async () => {
  const h = harness();
  await start(h);
  const before = h.chunks.getRequests().length;
  await h.controller.dispatch({ type: "setVoice", voiceId: "narrator" });
  const requests = h.chunks.getRequests();
  expect(requests.length).toBeGreaterThan(before);
  expect(requests[requests.length - 1]?.voiceId).toBe("narrator");
  expect(h.controller.snapshot().state).toBe("playing");
  expect(h.controller.snapshot().voiceId).toBe("narrator");
  await h.controller.dispose();
});

test("row 10: setRate that changes synthSpeed refills the queue", async () => {
  const h = harness({ maxRate: 2 });
  await start(h);
  const before = h.chunks.getRequests().length;
  await h.controller.dispatch({ type: "setRate", rate: 3 });
  const requests = h.chunks.getRequests();
  expect(h.controller.snapshot().rate).toBe(3);
  expect(requests.length).toBeGreaterThan(before);
  expect(requests[requests.length - 1]?.synthSpeed).toBe(1.5);
  expect(h.controller.snapshot().state).toBe("playing");
  await h.controller.dispose();
});

test("row 10: setRate that keeps synthSpeed does not refill the queue", async () => {
  const h = harness({ maxRate: 16 });
  await start(h);
  const before = h.chunks.getRequests().length;
  await h.controller.dispatch({ type: "setRate", rate: 1.2 });
  expect(h.chunks.getRequests().length).toBe(before);
  expect(h.controller.snapshot().state).toBe("playing");
  await h.controller.dispose();
});

test("row 11: a chunk failure enters error, keeps the position, and play retries", async () => {
  const h = harness({ failures: 1 });
  await h.controller.dispatch({ type: "load", docId: h.document.docId });
  await h.controller.dispatch({ type: "play" });
  expect(h.controller.snapshot().state).toBe("error");
  expect(h.controller.snapshot().error?.code).toBe("CHUNK_FAILED");
  expect(h.controller.snapshot().sentenceIndex).toBe(0);
  await h.controller.dispatch({ type: "play" });
  expect(h.controller.snapshot().state).toBe("playing");
  await h.controller.dispose();
});

test("row 12: stop clears the queue and returns to idle", async () => {
  const h = harness();
  await start(h);
  await h.controller.dispatch({ type: "stop" });
  expect(h.controller.snapshot().state).toBe("idle");
  expect(h.controller.snapshot().docId).toBeNull();
  expect(h.sink.current().chunkId).toBeNull();
  await h.controller.dispose();
});

test("toggle pauses while playing and plays while paused", async () => {
  const h = harness();
  await start(h);
  await h.controller.dispatch({ type: "toggle" });
  expect(h.controller.snapshot().state).toBe("paused");
  await h.controller.dispatch({ type: "toggle" });
  expect(h.controller.snapshot().state).toBe("playing");
  await h.controller.dispose();
});

test("the prefetch window is the current sentence plus three", async () => {
  const h = harness();
  await start(h);
  const texts = h.chunks.getRequests().map((request) => request.text);
  expect(texts).toEqual(["One two three.", "Four five six.", "Seven eight.", "Nine ten."]);
  await h.controller.dispose();
});

test("skipped blocks are passed over, and included when skipFurniture is off", async () => {
  const document = documentFrom(DEFAULT_PARAGRAPHS, true);
  const on = harness({ document, skipFurniture: true });
  await start(on);
  expect(on.chunks.getRequests().map((request) => request.text)).not.toContain("Running head");
  const off = harness({ document, skipFurniture: false });
  await start(off);
  expect(off.chunks.getRequests().map((request) => request.text)).toContain("Running head");
  await on.controller.dispose();
  await off.controller.dispose();
});

test("the sleep timer stops at the first sentence boundary after it expires", async () => {
  const h = harness();
  await start(h);
  await h.controller.dispatch({ type: "setSleep", minutes: 0.001 });
  h.clock.advance(60);
  await flush();
  expect(h.controller.snapshot().sleepRemainingMs).toBe(0);
  h.clock.advance(1000);
  await flush();
  expect(h.controller.snapshot().state).toBe("paused");
  expect(h.controller.snapshot().sleepRemainingMs).toBeNull();
  expect(h.sink.current().chunkId).toBeNull();
  await h.controller.dispose();
});

test("activeWord follows the sink position through the lookahead", async () => {
  const h = harness();
  await start(h);
  h.clock.advance(250);
  await flush();
  expect(h.controller.activeWord()).toEqual({ sentenceIndex: 0, wordIndex: 1 });
  await h.controller.dispose();
});

test("subscribe receives a snapshot on every change and unsubscribes", async () => {
  const h = harness();
  const seen: string[] = [];
  const unsubscribe = h.controller.subscribe((snapshot) => seen.push(snapshot.state));
  await h.controller.dispatch({ type: "load", docId: h.document.docId });
  await h.controller.dispatch({ type: "play" });
  expect(seen).toContain("loading");
  expect(seen).toContain("ready");
  expect(seen).toContain("playing");
  unsubscribe();
  const before = seen.length;
  await h.controller.dispatch({ type: "pause" });
  expect(seen.length).toBe(before);
  await h.controller.dispose();
});

test("dispose is idempotent and silences the controller", async () => {
  const h = harness();
  await start(h);
  await h.controller.dispose();
  await h.controller.dispose();
  await h.controller.dispatch({ type: "play" });
  expect(h.controller.snapshot().state).toBe("playing");
});

test("the fake sink passes the F§5.8 conformance suite", async () => {
  let clock = new FakeClock();
  let counter = 0;
  const results = await runAudioQueueSinkConformance(
    () => {
      clock = new FakeClock();
      return new FakeSink({ clock, maxRate: 16 });
    },
    {
      wait: async (ms) => {
        clock.advance(ms);
        await flush();
      },
      makeChunk: async (durationMs) => {
        counter += 1;
        return { chunkId: `conf-${counter}`, uri: `memory://conf-${counter}`, durationMs };
      },
    },
  );
  expect(results.filter((result) => !result.ok)).toEqual([]);
  expect(results.length).toBe(7);
});
