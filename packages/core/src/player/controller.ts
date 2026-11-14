/**
 * The player controller (F§5.7): the one state machine that owns playback. It reads no global, schedules
 * no real timer and speaks no HTTP — it drives the injected `AudioQueueSink`, asks the injected
 * `ChunkSource` for one chunk per sentence, resolves documents through the injected `DocumentProvider`
 * and takes every millisecond from the injected `Clock`.
 *
 * The transition table of F§5.7 is the map this file implements; the three rules under it (prefetch window,
 * sleep timer, injected clock) are the three behaviours the comments below defend.
 */

import type { DocumentModel, Position } from "../model";
import { playableSentences, sentenceAt } from "../playable";
import { stripCitations } from "../skip";
import { clampRate, planSpeed } from "../speed";
import { findActiveWord, type WordTiming } from "../timing";
import type { AudioQueueSink, ChunkRef, ChunkSource, Clock, DocumentProvider } from "./interfaces";
import { type PlayerCommand, PlayerCommandSchema, type PlayerSnapshot, type PlayerState } from "./protocol";

/** How the player is configured for one document (F§5.7's `settings`). */
export interface PlayerSettings {
  skipFurniture: boolean;
  skipCitations: boolean;
  lookaheadMs: number;
}

/** What the player needs from its host (F§5.7). */
export interface PlayerDependencies {
  sink: AudioQueueSink;
  chunks: ChunkSource;
  documents: DocumentProvider;
  clock: Clock;
  settings: PlayerSettings;
}

/** The player's public surface (F§5.7). */
export interface PlayerController {
  dispatch(command: PlayerCommand): Promise<void>;
  snapshot(): PlayerSnapshot;
  subscribe(callback: (snapshot: PlayerSnapshot) => void): () => void;
  activeWord(): { sentenceIndex: number; wordIndex: number };
  dispose(): Promise<void>;
}

/** The prefetch window: the current sentence plus the next three (F§5.7). */
const PREFETCH_WINDOW = 4;

/** Milliseconds in a minute, for the sleep timer. */
const MINUTE_MS = 60_000;

/** The voice the chunk source is asked for when no voice has been chosen yet. */
const UNVOICED = "";

/** The codes the player reports in `PlayerSnapshot.error` (F§5.7). */
const DOCUMENT_NOT_FOUND = "DOCUMENT_NOT_FOUND";
const DOCUMENT_LOAD_FAILED = "DOCUMENT_LOAD_FAILED";
const CHUNK_FAILED = "CHUNK_FAILED";
const SINK_FAILED = "SINK_FAILED";
const INVALID_COMMAND = "INVALID_COMMAND";

/** One chunk's playback identity: the sentence it reads, and where its words fall inside it. */
interface ChunkMeta {
  sentenceIndex: number;
  timings: WordTiming[];
}

/**
 * `createPlayerController(deps)` — F§5.7's state machine over the four injected boundaries. Every method
 * the returned object exposes is safe to call before `load`: commands that need a document are no-ops
 * until one is `ready`.
 */
export function createPlayerController(deps: PlayerDependencies): PlayerController {
  const { sink, chunks, documents, clock, settings } = deps;

  let disposed = false;
  let state: PlayerState = "idle";
  let doc: DocumentModel | null = null;
  let docId: string | null = null;
  let order: number[] = [];
  let position = { sentenceIndex: 0, wordIndex: 0 };
  let rate = 1;
  let voiceId: string | null = null;
  let error: { code: string; message: string } | null = null;
  let sleepDeadline: number | null = null;
  let sleepHandle: number | null = null;
  let sleepExpired = false;
  let generation = 0;

  /** Sentence indexes requested or enqueued but not yet ended — the window's live half. */
  const queued = new Set<number>();
  /** Enqueued chunks by id, for `activeWord` and for ignoring stale chunk-end events. */
  const chunkMeta = new Map<string, ChunkMeta>();
  const listeners = new Set<(snapshot: PlayerSnapshot) => void>();

  // ── state helpers ────────────────────────────────────────────────────────────────────────────────

  function snapshot(): PlayerSnapshot {
    return {
      state,
      docId,
      sentenceIndex: position.sentenceIndex,
      wordIndex: position.wordIndex,
      rate,
      voiceId,
      sleepRemainingMs: sleepDeadline === null ? null : Math.max(0, Math.round(sleepDeadline - clock.now())),
      error: error === null ? null : { code: error.code, message: error.message },
    };
  }

  function notify(): void {
    if (disposed) return;
    const current = snapshot();
    for (const listener of [...listeners]) listener(current);
  }

  function setState(next: PlayerState): void {
    state = next;
    if (next !== "error") error = null;
  }

  /** Enter `error`, keep the position, and stop whatever the sink is doing (F§5.7's failure row). */
  function fail(code: string, cause: unknown): void {
    if (disposed) return;
    error = { code, message: cause instanceof Error ? cause.message : String(cause) };
    state = "error";
    notify();
    void sink.pause().catch(() => undefined);
  }

  /** The nearest playable sentence at or after `sentenceIndex`, or the last one (F§5.7's skip rule). */
  function snapToPlayable(sentenceIndex: number): number {
    if (order.length === 0) return sentenceIndex;
    if (order.includes(sentenceIndex)) return sentenceIndex;
    for (const candidate of order) {
      if (candidate > sentenceIndex) return candidate;
    }
    return order[order.length - 1] ?? sentenceIndex;
  }

  function orderIndexAt(sentenceIndex: number): number {
    const index = order.indexOf(snapToPlayable(sentenceIndex));
    return index === -1 ? 0 : index;
  }

  /** A word index clamped into the sentence it names. */
  function clampWord(document: DocumentModel, sentenceIndex: number, wordIndex: number): number {
    const target = snapToPlayable(sentenceIndex);
    try {
      const sentence = sentenceAt(document, target);
      return Math.min(Math.max(0, wordIndex), Math.max(0, sentence.words.length - 1));
    } catch {
      return 0;
    }
  }

  function requestChunk(document: DocumentModel, sentenceIndex: number): Promise<ChunkRef> {
    const sentence = sentenceAt(document, sentenceIndex);
    const text = settings.skipCitations ? stripCitations(sentence.text) : sentence.text;
    const plan = planSpeed(rate, sink.maxRate);
    return chunks.get({ text, voiceId: voiceId ?? UNVOICED, synthSpeed: plan.synthSpeed });
  }

  // ── queue filling ────────────────────────────────────────────────────────────────────────────────

  /**
   * Enqueue every sentence of the prefetch window that is not already queued, in playback order. When
   * `allowPlay` is set, the first enqueue while `buffering` starts the sink (F§5.7's
   * `buffering → first chunk enqueued → playing`). A superseded fill (its `generation` is stale) stops
   * without touching the queue.
   */
  async function fillWindow(startIndex: number, allowPlay: boolean): Promise<void> {
    const document = doc;
    if (document === null) return;
    const gen = generation;
    let enqueuedAny = false;
    for (const sentenceIndex of order.slice(startIndex, startIndex + PREFETCH_WINDOW)) {
      if (queued.has(sentenceIndex)) continue;
      queued.add(sentenceIndex);
      let chunk: ChunkRef;
      try {
        chunk = await requestChunk(document, sentenceIndex);
      } catch (cause) {
        if (gen === generation) fail(CHUNK_FAILED, cause);
        return;
      }
      if (gen !== generation) return;
      chunkMeta.set(chunk.chunkId, { sentenceIndex, timings: chunk.timings });
      try {
        await sink.enqueue({ chunkId: chunk.chunkId, uri: chunk.uri, durationMs: chunk.durationMs });
      } catch (cause) {
        if (gen === generation) fail(SINK_FAILED, cause);
        return;
      }
      if (gen !== generation) return;
      enqueuedAny = true;
      if (allowPlay && state === "buffering") {
        try {
          await sink.play();
        } catch (cause) {
          if (gen === generation) fail(SINK_FAILED, cause);
          return;
        }
        if (gen !== generation) return;
        setState("playing");
        notify();
      }
    }
    if (!enqueuedAny && allowPlay && state === "buffering") {
      try {
        await sink.play();
      } catch (cause) {
        if (gen === generation) fail(SINK_FAILED, cause);
        return;
      }
      if (gen !== generation) return;
      setState("playing");
      notify();
    }
  }

  // ── sink events ──────────────────────────────────────────────────────────────────────────────────

  function handleChunkEnd(event: { chunkId?: string; error?: Error }): void {
    if (disposed || event.chunkId === undefined) return;
    const meta = chunkMeta.get(event.chunkId);
    if (meta === undefined) return;
    chunkMeta.delete(event.chunkId);
    if (state !== "playing" && state !== "buffering") return;
    const index = order.indexOf(meta.sentenceIndex);
    if (index === -1) return;
    queued.delete(meta.sentenceIndex);
    const next = order[index + 1];
    if (sleepExpired) {
      void stopForSleep(next);
      return;
    }
    if (next === undefined) {
      setState("ended");
      notify();
      return;
    }
    position = { sentenceIndex: next, wordIndex: 0 };
    notify();
    void fillWindow(index + 1, true);
  }

  function handleQueueEmpty(): void {
    if (disposed || state !== "playing") return;
    // The chunk-end handler is what turns the last sentence's boundary into `ended`; a queue-empty that
    // reaches here while still `playing` means the sink is waiting for a chunk that is still in flight.
    setState("buffering");
    notify();
  }

  function handleSinkError(event: { chunkId?: string; error?: Error }): void {
    if (event.error !== undefined) fail(SINK_FAILED, event.error);
  }

  /** Stop at the boundary the sleep timer expired before (F§5.7's sleep rule). */
  async function stopForSleep(next: number | undefined): Promise<void> {
    clearSleep();
    generation += 1;
    if (next !== undefined) position = { sentenceIndex: next, wordIndex: 0 };
    setState(next === undefined ? "ended" : "paused");
    notify();
    try {
      await sink.clear();
    } catch (cause) {
      fail(SINK_FAILED, cause);
    }
  }

  // ── sleep timer ──────────────────────────────────────────────────────────────────────────────────

  function clearSleep(): void {
    if (sleepHandle !== null) {
      clock.clearTimeout(sleepHandle);
      sleepHandle = null;
    }
    sleepDeadline = null;
    sleepExpired = false;
  }

  function setSleep(minutes: number | null): void {
    clearSleep();
    if (minutes !== null) {
      const ms = Math.max(0, Math.round(minutes * MINUTE_MS));
      sleepDeadline = clock.now() + ms;
      if (ms > 0) {
        sleepHandle = clock.setTimeout(() => {
          sleepExpired = true;
          sleepHandle = null;
          notify();
        }, ms);
      } else {
        sleepExpired = true;
      }
    }
    notify();
  }

  // ── commands ─────────────────────────────────────────────────────────────────────────────────────

  async function load(requestedDocId: string, requestedPosition: Position | undefined): Promise<void> {
    const gen = ++generation;
    docId = requestedDocId;
    setState("loading");
    notify();
    try {
      await sink.clear();
    } catch (cause) {
      if (gen === generation) fail(SINK_FAILED, cause);
      return;
    }
    if (gen !== generation) return;
    queued.clear();
    chunkMeta.clear();
    doc = null;
    order = [];
    let resolved: DocumentModel | null;
    try {
      resolved = await documents.get(requestedDocId);
    } catch (cause) {
      if (gen === generation) fail(DOCUMENT_LOAD_FAILED, cause);
      return;
    }
    if (gen !== generation) return;
    if (resolved === null) {
      fail(DOCUMENT_NOT_FOUND, `no document with id ${requestedDocId}`);
      return;
    }
    doc = resolved;
    docId = resolved.docId;
    order = playableSentences(resolved, { skipFurniture: settings.skipFurniture });
    const requestedSentence = requestedPosition?.sentenceIndex ?? order[0] ?? 0;
    const snapped = snapToPlayable(requestedSentence);
    position = { sentenceIndex: snapped, wordIndex: clampWord(resolved, snapped, requestedPosition?.wordIndex ?? 0) };
    setState("ready");
    notify();
  }

  async function play(): Promise<void> {
    if (doc === null || state === "idle" || state === "loading" || state === "playing" || state === "buffering") return;
    if (order.length === 0) {
      setState("ended");
      notify();
      return;
    }
    if (state === "ended") {
      position = { sentenceIndex: order[0] ?? position.sentenceIndex, wordIndex: 0 };
    }
    if (state === "error") {
      generation += 1;
      try {
        await sink.clear();
      } catch (cause) {
        fail(SINK_FAILED, cause);
        return;
      }
      queued.clear();
      chunkMeta.clear();
    }
    setState("buffering");
    notify();
    await fillWindow(orderIndexAt(position.sentenceIndex), true);
  }

  async function pause(): Promise<void> {
    if (state !== "playing" && state !== "buffering") return;
    try {
      await sink.pause();
    } catch (cause) {
      fail(SINK_FAILED, cause);
      return;
    }
    setState("paused");
    notify();
  }

  async function stop(): Promise<void> {
    generation += 1;
    clearSleep();
    try {
      await sink.clear();
    } catch (cause) {
      fail(SINK_FAILED, cause);
      return;
    }
    doc = null;
    docId = null;
    order = [];
    position = { sentenceIndex: 0, wordIndex: 0 };
    queued.clear();
    chunkMeta.clear();
    setState("idle");
    notify();
  }

  async function seek(sentenceIndex: number, wordIndex: number): Promise<void> {
    const document = doc;
    if (document === null || state === "idle" || state === "loading") return;
    const wasPlaying = state === "playing" || state === "buffering";
    generation += 1;
    try {
      await sink.clear();
    } catch (cause) {
      fail(SINK_FAILED, cause);
      return;
    }
    queued.clear();
    chunkMeta.clear();
    const snapped = snapToPlayable(sentenceIndex);
    position = { sentenceIndex: snapped, wordIndex: clampWord(document, snapped, wordIndex) };
    setState(wasPlaying ? "buffering" : "paused");
    notify();
    if (order.length === 0) return;
    await fillWindow(orderIndexAt(position.sentenceIndex), wasPlaying);
  }

  async function skip(sentences: number): Promise<void> {
    if (doc === null || order.length === 0 || state === "idle" || state === "loading") return;
    const current = orderIndexAt(position.sentenceIndex);
    const target = Math.min(order.length - 1, Math.max(0, current + sentences));
    const sentenceIndex = order[target];
    if (sentenceIndex === undefined) return;
    await seek(sentenceIndex, 0);
  }

  async function setRate(nextRate: number): Promise<void> {
    if (!Number.isFinite(nextRate)) return;
    const next = clampRate(nextRate);
    const before = planSpeed(rate, sink.maxRate);
    const after = planSpeed(next, sink.maxRate);
    rate = next;
    try {
      sink.setRate(after.sinkRate);
    } catch (cause) {
      fail(SINK_FAILED, cause);
      return;
    }
    notify();
    const refill =
      after.synthSpeed !== before.synthSpeed && doc !== null && (state === "playing" || state === "buffering" || state === "paused");
    if (!refill) return;
    const wasPlaying = state === "playing" || state === "buffering";
    generation += 1;
    try {
      await sink.clear();
    } catch (cause) {
      fail(SINK_FAILED, cause);
      return;
    }
    queued.clear();
    chunkMeta.clear();
    setState(wasPlaying ? "buffering" : "paused");
    notify();
    await fillWindow(orderIndexAt(position.sentenceIndex), wasPlaying);
  }

  async function setVoice(nextVoice: string): Promise<void> {
    voiceId = nextVoice;
    if (doc === null || state === "idle" || state === "loading") {
      notify();
      return;
    }
    const wasPlaying = state === "playing" || state === "buffering";
    generation += 1;
    try {
      await sink.clear();
    } catch (cause) {
      fail(SINK_FAILED, cause);
      return;
    }
    queued.clear();
    chunkMeta.clear();
    setState(wasPlaying ? "buffering" : "paused");
    notify();
    await fillWindow(orderIndexAt(position.sentenceIndex), wasPlaying);
  }

  async function dispatch(command: PlayerCommand): Promise<void> {
    if (disposed) return;
    const parsed = PlayerCommandSchema.safeParse(command);
    if (!parsed.success) {
      fail(INVALID_COMMAND, parsed.error.message);
      return;
    }
    const valid = parsed.data;
    switch (valid.type) {
      case "load":
        return load(valid.docId, valid.position);
      case "play":
        return play();
      case "pause":
        return pause();
      case "toggle":
        return state === "playing" || state === "buffering" ? pause() : play();
      case "stop":
        return stop();
      case "seek":
        return seek(valid.sentenceIndex, valid.wordIndex ?? 0);
      case "skip":
        return skip(valid.sentences);
      case "setRate":
        return setRate(valid.rate);
      case "setVoice":
        return setVoice(valid.voiceId);
      case "setSleep":
        setSleep(valid.minutes);
        return;
    }
  }

  function subscribe(callback: (snapshot: PlayerSnapshot) => void): () => void {
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  }

  function activeWord(): { sentenceIndex: number; wordIndex: number } {
    const current = sink.current();
    if (current.chunkId !== null) {
      const meta = chunkMeta.get(current.chunkId);
      if (meta !== undefined && meta.timings.length > 0) {
        return {
          sentenceIndex: meta.sentenceIndex,
          wordIndex: findActiveWord(meta.timings, current.positionMs + settings.lookaheadMs),
        };
      }
    }
    return { sentenceIndex: position.sentenceIndex, wordIndex: position.wordIndex };
  }

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    generation += 1;
    if (sleepHandle !== null) {
      clock.clearTimeout(sleepHandle);
      sleepHandle = null;
    }
    for (const unsubscribe of unsubscribers) unsubscribe();
    unsubscribers.length = 0;
    listeners.clear();
    await sink.clear().catch(() => undefined);
  }

  const unsubscribers: (() => void)[] = [
    sink.on("chunk-end", handleChunkEnd),
    sink.on("queue-empty", handleQueueEmpty),
    sink.on("error", handleSinkError),
  ];

  return { dispatch, snapshot, subscribe, activeWord, dispose };
}
