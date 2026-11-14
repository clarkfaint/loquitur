/**
 * The sink harness page (U-024): it puts the shipped `@lectern/ui-web` sink in front of a real browser and
 * exposes four entry points, so the conformance suite and the timing probes run against the same code the
 * reader loads — not a model of it.
 *
 * The page renders nothing. It exists to give the sink a document to schedule playback in, which is also
 * why it watches the `Audio` constructor: the sink keeps its two elements out of the document (F§5.8), so
 * the only way for a test to read the one that is playing is to see them as they are created.
 */

import type { AudioQueueSink } from "@lectern/core";
import { runAudioQueueSinkConformance, type SinkConformanceResult } from "@lectern/core/testing";
import { chunkIdFor, createMockEngine, type TtsEngine } from "@lectern/core-tts";
import { createHtmlAudioQueueSink } from "../../src/audio/html-audio-queue-sink";

/** What `makeChunk` hands a test: a chunk the sink can enqueue, with its audio behind a blob URL. */
interface HarnessChunk {
  chunkId: string;
  uri: string;
  durationMs: number;
}

interface SinkProbe {
  preservesPitch: boolean;
  playbackRate: number;
}

declare global {
  interface Window {
    runSinkConformance: () => Promise<SinkConformanceResult[]>;
    makeChunk: (durationMs: number) => Promise<HarnessChunk>;
    createSink: () => AudioQueueSink;
    sinkProbe: () => SinkProbe;
  }
}

/** F§6's duration law: 60 ms per letter or digit, floored at 200 ms. */
const MS_PER_CHARACTER = 60;

const engine: TtsEngine = createMockEngine();

/**
 * `makeChunk(600)` — real WAV bytes of that duration from the mock engine (F§6), behind a blob URL, so a
 * test drives the sink with audio and a length it chose, with no hub, no model and no file on disk. The
 * duration reported is the engine's own, which is the number the sink's playback is measured against.
 */
async function makeChunk(durationMs: number): Promise<HarnessChunk> {
  const characters = Math.max(1, Math.round(durationMs / MS_PER_CHARACTER));
  const text = "a".repeat(characters);
  const voices = await engine.listVoices();
  const voice = voices[0];
  if (voice === undefined) throw new Error("the mock engine offered no voice");
  const result = await engine.synthesize({ text, engineVoiceId: voice.engineVoiceId, synthSpeed: 1 });
  // A fresh, exactly-sized copy: a blob part must be backed by an `ArrayBuffer` it owns.
  const bytes = new Uint8Array(result.audio);
  return {
    chunkId: chunkIdFor(engine.id, voice.engineVoiceId, 1, text),
    uri: URL.createObjectURL(new Blob([bytes], { type: result.mime })),
    durationMs: result.durationMs,
  };
}

/** The suite's two seams (F§5.8): how a case waits, and where its audio comes from. */
const environment = {
  wait: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
  makeChunk,
};

/** Every element the sink has created, in creation order. */
const created: HTMLAudioElement[] = [];

const nativeAudio = window.Audio;
window.Audio = new Proxy(nativeAudio, {
  construct: (target, args) => {
    const element = Reflect.construct(target, args) as HTMLAudioElement;
    created.push(element);
    return element;
  },
});

/** The element to report on: the one playing, else the first one holding a source. */
function activeElement(): HTMLAudioElement {
  const playing = created.find((element) => !element.paused);
  if (playing !== undefined) return playing;
  const chosen = created.find((element) => element.src !== "") ?? created[0];
  if (chosen === undefined) throw new Error("no audio element exists yet");
  return chosen;
}

/** `sinkProbe()` — what the sink's playing element is set to (U-024's own assertion). */
function sinkProbe(): SinkProbe {
  const element = activeElement();
  return { preservesPitch: element.preservesPitch, playbackRate: element.playbackRate };
}

window.runSinkConformance = () => runAudioQueueSinkConformance(() => createHtmlAudioQueueSink(), environment);
window.makeChunk = makeChunk;
window.createSink = createHtmlAudioQueueSink;
window.sinkProbe = sinkProbe;
