/**
 * The player's boundary contracts (F§5.8): the audio queue it drives, the chunk source it asks for audio,
 * the clock it schedules against, and the document provider it resolves a `docId` through. The controller
 * depends on these four and nothing else, which is what keeps it pure TypeScript — no DOM, no native
 * module, no HTTP.
 */

import type { DocumentModel } from "../model";
import type { WordTiming } from "../timing";

/** One synthesized chunk: its audio, how long it runs, and where its words fall (F§5.8). */
export interface ChunkRef {
  chunkId: string;
  uri: string;
  durationMs: number;
  timings: WordTiming[];
  timingSource: "engine" | "estimated";
}

/** Where the player asks for audio: one request per sentence, in playback order (F§5.8). */
export interface ChunkSource {
  get(req: { text: string; voiceId: string; synthSpeed: number }): Promise<ChunkRef>;
}

/** The audio queue the player drives: enqueue, transport, rate, position and events (F§5.8). */
export interface AudioQueueSink {
  readonly maxRate: number;
  enqueue(item: { chunkId: string; uri: string; durationMs: number }): Promise<void>;
  clear(): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seekInCurrent(ms: number): Promise<void>;
  setRate(rate: number): void;
  current(): { chunkId: string | null; positionMs: number };
  on(event: "chunk-start" | "chunk-end" | "queue-empty" | "error", cb: (e: { chunkId?: string; error?: Error }) => void): () => void;
  dispose(): Promise<void>;
}

/** The only clock the controller may read or schedule against (F§5.7's injected clock). */
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(handle: number): void;
}

/** Resolves a `docId` to its document, or `null` when the library does not hold it. */
export interface DocumentProvider {
  get(docId: string): Promise<DocumentModel | null>;
}
