/**
 * F§5.8's `ChunkSource` over the hub client, cached in F§5.9's `BlobCache`.
 *
 * A chunk is named by everything that decides its audio (F§6), so a client computes the id before it asks
 * anyone: the cache is read under that id first, and the hub is asked only for a chunk no cache holds. Two
 * concurrent requests for one chunk share one promise, so a prefetch and a play of the same sentence cost one
 * synthesis between them.
 *
 * Cached audio is played from the cache's own URI, which is what makes a document readable with the hub
 * unreachable: the bytes are already local, and only a sentence no cache holds reports the hub as offline.
 */

import { TimingSourceSchema, WordTimingSchema } from "@lectern/api-contract";
import { type BlobCache, type ChunkRef, type ChunkSource, type DocumentModel, playableSentences, sentenceAt } from "@lectern/core";
import { chunkIdFor, parseVoiceId } from "@lectern/core-tts";
import { z } from "zod";
import type { HubClient } from "./client";
import { HubClientError } from "./errors";

/** The engine speed a caller that names none asks for, and the one most chunks are cached at (F§7.2). */
const DEFAULT_SYNTH_SPEED = 1;

/**
 * The metadata kept beside a chunk's audio, so a cached chunk can be played without the hub: F§6's mime, the
 * duration, the word timings and where they came from. It is the TTS answer's own fields, spelled with the
 * contract's schemas, so the wire shape and the cached shape cannot drift apart.
 */
const ChunkMetadataSchema = z.strictObject({
  chunkId: z.string().min(1),
  mime: z.enum(["audio/mpeg", "audio/wav"]),
  durationMs: z.int().nonnegative(),
  timings: z.array(WordTimingSchema),
  timingSource: TimingSourceSchema,
});

/** What a caching source is built from: the hub client, and the cache the audio and its metadata live in. */
export interface CachingChunkSourceOptions {
  client: HubClient;
  cache: BlobCache;
}

/** How a prefetch reads a document: the engine speed to cache at, and whether furniture is read too. */
export interface PrefetchOptions {
  synthSpeed?: number;
  skipFurniture?: boolean;
}

/** One prefetch step: how many of a document's playable sentences are cached, out of how many there are. */
export interface PrefetchProgress {
  done: number;
  total: number;
}

/** F§5.8's chunk source, plus the two things a reader asks of the cache itself. */
export interface CachingChunkSource extends ChunkSource {
  /**
   * Cache every playable sentence of a document, reporting progress as it goes. The first step is `0`, so a
   * caller can show the bar before the first chunk arrives; the last one is `total`, and then it ends.
   */
  prefetchDocument(doc: DocumentModel, voiceId: string, options?: PrefetchOptions): AsyncIterable<PrefetchProgress>;
  /** Whether both halves of a chunk — the audio and its metadata — are already cached. */
  isCached(text: string, voiceId: string, synthSpeed: number): Promise<boolean>;
}

/** The key a chunk's metadata is cached under, beside the chunk's own key. */
function metadataKey(chunkId: string): string {
  return `${chunkId}.json`;
}

/** The two halves of an `engine:voice` identifier, or F§6's refusal for an id that is not one. */
function identityOf(voiceId: string): { engine: string; engineVoiceId: string } {
  const parts = parseVoiceId(voiceId);
  if (parts === null) {
    throw new HubClientError({ code: "UNKNOWN_VOICE", status: 0, message: `${voiceId} is not an engine:voice identifier (F§6)` });
  }
  return parts;
}

/**
 * `createCachingChunkSource({ client, cache })` — F§5.8's `ChunkSource`, cached.
 *
 * A hit needs both halves: the audio under the chunk's id, and the metadata beside it. Metadata that cannot be
 * read — an absent sidecar, or one whose bytes are not this shape — counts as a miss and is replaced, because a
 * chunk whose timings cannot be trusted is worth re-synthesizing rather than half-playing.
 */
export function createCachingChunkSource(options: CachingChunkSourceOptions): CachingChunkSource {
  const inFlight = new Map<string, Promise<ChunkRef>>();

  /** The chunk the cache holds under `chunkId`, or `null` when it holds no usable pair of files. */
  const cached = async (chunkId: string): Promise<ChunkRef | null> => {
    const uri = await options.cache.uri(chunkId);
    if (uri === null) return null;
    const bytes = await options.cache.get(metadataKey(chunkId));
    if (bytes === null) return null;
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      payload = undefined;
    }
    const metadata = ChunkMetadataSchema.safeParse(payload);
    if (!metadata.success) return null;
    return { chunkId, uri, durationMs: metadata.data.durationMs, timings: metadata.data.timings, timingSource: metadata.data.timingSource };
  };

  /** One chunk from the hub: synthesize it, download its audio, and keep both halves. */
  const download = async (request: { text: string; voiceId: string; synthSpeed: number }): Promise<ChunkRef> => {
    const answer = await options.client.tts(request);
    const audio = await options.client.ttsAudio(answer.chunkId);
    const uri = await options.cache.put(answer.chunkId, audio, answer.mime);
    const metadata = ChunkMetadataSchema.parse({
      chunkId: answer.chunkId,
      mime: answer.mime,
      durationMs: answer.durationMs,
      timings: answer.timings,
      timingSource: answer.timingSource,
    });
    await options.cache.put(metadataKey(answer.chunkId), new TextEncoder().encode(JSON.stringify(metadata)), "application/json");
    return {
      chunkId: answer.chunkId,
      uri,
      durationMs: metadata.durationMs,
      timings: metadata.timings,
      timingSource: metadata.timingSource,
    };
  };

  const get = async (request: { text: string; voiceId: string; synthSpeed: number }): Promise<ChunkRef> => {
    const parts = identityOf(request.voiceId);
    const chunkId = chunkIdFor(parts.engine, parts.engineVoiceId, request.synthSpeed, request.text);
    const running = inFlight.get(chunkId);
    if (running !== undefined) return await running;
    const pending = cached(chunkId).then(async (hit) => hit ?? (await download(request)));
    inFlight.set(chunkId, pending);
    try {
      return await pending;
    } finally {
      inFlight.delete(chunkId);
    }
  };

  const isCached = async (text: string, voiceId: string, synthSpeed: number): Promise<boolean> => {
    const parts = parseVoiceId(voiceId);
    if (parts === null) return false;
    const chunkId = chunkIdFor(parts.engine, parts.engineVoiceId, synthSpeed, text);
    return (await options.cache.has(chunkId)) && (await options.cache.has(metadataKey(chunkId)));
  };

  async function* prefetchDocument(doc: DocumentModel, voiceId: string, prefetch: PrefetchOptions = {}): AsyncIterable<PrefetchProgress> {
    const synthSpeed = prefetch.synthSpeed ?? DEFAULT_SYNTH_SPEED;
    const indexes = playableSentences(doc, { skipFurniture: prefetch.skipFurniture ?? true });
    yield { done: 0, total: indexes.length };
    let done = 0;
    for (const index of indexes) {
      await get({ text: sentenceAt(doc, index).text, voiceId, synthSpeed });
      done += 1;
      yield { done, total: indexes.length };
    }
  }

  return { get, isCached, prefetchDocument };
}
