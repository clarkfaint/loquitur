/**
 * The sink harness page (U-024): it puts the shipped `@lectern/ui-web` sink in front of a real browser and
 * exposes four entry points, so the conformance suite and the timing probes run against the same code the
 * reader loads — not a model of it.
 *
 * The page renders nothing. It exists to give the sink a document to schedule playback in, which is also
 * why it watches the `Audio` constructor: the sink keeps its two elements out of the document (F§5.8), so
 * the only way for a test to read the one that is playing is to see them as they are created.
 *
 * The reader rig (U-025) lives here too, for the same reason: `mountReader` puts the shipped `ReaderView`
 * in a real document, and the four reader entry points around it exist because a highlight range, a caret
 * position and a committed React render are all things only a browser can answer for. The page still
 * renders nothing of its own; the reader appears in a container the test mounts and removes.
 */

import { buildDocument, type DocumentModel, DocumentModelSchema, type RawBlock } from "@lectern/core";
import { runAudioQueueSinkConformance, type SinkConformanceResult } from "@lectern/core/testing";
import { chunkIdFor, createMockEngine, type TtsEngine } from "@lectern/core-tts";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { createHtmlAudioQueueSink } from "../../src/audio/html-audio-queue-sink";
import { ReaderView } from "../../src/components/ReaderView";
import type { TextPosition } from "../../src/highlight/locate";
import "../../src/styles.css";

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
    readerDocumentJson: (text: string) => string;
    mountReader: (documentJson: string, options?: { showSkipped?: boolean }) => void;
    setReaderActive: (active: TextPosition | null) => void;
    readerSeeked: () => TextPosition | null;
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

/**
 * One block per line of the fixture text: `# ` a heading, `> ` a quote, `- ` a list item, `! ` a furniture
 * line (F§5.4's header kind, which `buildDocument` always marks as skipped), anything else a paragraph.
 */
function blocksFromText(text: string): RawBlock[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      if (line.startsWith("# ")) return { kind: "heading", level: 1, text: line.slice(2) };
      if (line.startsWith("> ")) return { kind: "quote", text: line.slice(2) };
      if (line.startsWith("- ")) return { kind: "list-item", text: line.slice(2) };
      if (line.startsWith("! ")) return { kind: "header", text: line.slice(2) };
      return { kind: "paragraph", text: line };
    });
}

/** `readerDocumentJson(text)` — the `DocumentModel` the reader test mounts, built by the shipped builder. */
function readerDocumentJson(text: string): string {
  return JSON.stringify(buildDocument(blocksFromText(text), { source: { kind: "txt" } }));
}

/** The reader rig's own state: one mounted reader at a time, and the last seek it reported. */
let readerRoot: Root | null = null;
let readerContainer: HTMLElement | null = null;
let readerModel: DocumentModel | null = null;
let readerActive: TextPosition | null = null;
let readerShowSkipped = false;
let readerSeeked: TextPosition | null = null;

/** Draw the reader with the rig's current state. */
function drawReader(): void {
  if (readerRoot === null || readerModel === null) return;
  readerRoot.render(
    createElement(ReaderView, {
      document: readerModel,
      active: readerActive,
      showSkipped: readerShowSkipped,
      onSeek: (position: TextPosition) => {
        readerSeeked = position;
      },
    }),
  );
}

/**
 * `mountReader(documentJson)` — put the reader on the page. A second call replaces the first reader
 * rather than leaving two behind, and the container is a plain `div` the test can query for elements.
 */
function mountReader(documentJson: string, options: { showSkipped?: boolean } = {}): void {
  const model = DocumentModelSchema.parse(JSON.parse(documentJson));
  if (readerRoot !== null) {
    readerRoot.unmount();
    readerContainer?.remove();
  }
  readerModel = model;
  readerActive = null;
  readerSeeked = null;
  readerShowSkipped = options.showSkipped ?? false;
  const container = document.createElement("div");
  container.id = "reader";
  document.body.append(container);
  readerContainer = container;
  readerRoot = createRoot(container);
  drawReader();
}

/** `setReaderActive(position)` — move the reader's active word, committing before it returns. */
function setReaderActive(active: TextPosition | null): void {
  readerActive = active;
  flushSync(() => {
    drawReader();
  });
}

window.runSinkConformance = () => runAudioQueueSinkConformance(() => createHtmlAudioQueueSink(), environment);
window.makeChunk = makeChunk;
window.createSink = createHtmlAudioQueueSink;
window.sinkProbe = sinkProbe;
window.readerDocumentJson = readerDocumentJson;
window.mountReader = mountReader;
window.setReaderActive = setReaderActive;
window.readerSeeked = () => readerSeeked;
