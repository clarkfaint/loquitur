/**
 * Preparing a document to be read with no network (F§10.4, F§10.1, F§5.9).
 *
 * A pack is F§10.1's "download for offline", on Android: every sentence of a document is synthesized into
 * F§5.9's `BlobCache`, and the document is **pinned** so that the cache's own eviction cannot take it away. A
 * pinned document is playable in an aeroplane, and everything else the cache holds is still free to be dropped
 * when the reader's limit is reached.
 *
 * Five decisions are worth naming.
 *
 * - The pin is F§5.9's `setting` entity, keyed `offline:<docId>`, holding the voice and the engine speed the
 *   pack was synthesized at — the same record, key and meaning the web app's own "download for offline" writes
 *   (F§10.1, U-031). Those two are what a chunk's id is computed from, so a pin is enough to recognise a
 *   document's audio later without asking the hub anything, which is the whole point: the moment the pin
 *   matters is the moment the hub is unreachable.
 * - **The pin is written before the sentences are fetched, not after.** The web app has no cancellation and
 *   writes it last; this contract requires the opposite observable outcome — "cancel leaves a `partial` state"
 *   — and `partial` is exactly "a pin whose coverage is incomplete". Writing it first is also what makes an
 *   interrupted pack identifiable and protected from eviction while it is still being filled. Nothing claims a
 *   document is readable offline until every sentence is cached, because that is `offlineState`'s `complete`,
 *   and it is recomputed from the cache every time it is asked for.
 * - `evictLru` asks a **synchronous** predicate about every key it is considering, so the pin set has to be
 *   materialized first: `pinnedPredicate()` reads every pinned document's model and computes its keys.
 * - The voice a pack was prepared with becomes the reader's own voice, because a reader who comes back with no
 *   network cannot ask the hub which voices exist, and a chunk with no voice is not a chunk at all.
 * - The pack covers **every** sentence, furniture included (F§10.1 says "every sentence"), so the reading mode
 *   the reader chooses later cannot find a gap, and it is synthesized at engine speed 1 (F§5.6(e)): Android's
 *   sink is the platform's own time-stretcher, so no reader-chosen rate has to be split off to the synthesizer
 *   and one cached chunk serves every speed.
 *
 * F§5.9's `LibraryStore` has no way to remove a setting — `setSetting` writes, and nothing deletes — so
 * removing a pack writes a `null` value under the same key: a pin that is not an object is not a pin. That is
 * the difference between "pinned" and "not pinned" the store's interface can express.
 *
 * Every platform module is loaded **inside** the factory below and never at import time. The Node test program
 * imports this file's own tests, and `../stores` reaches `expo-sqlite` and `../connection` reaches `expo/fetch`
 * — packages whose JavaScript cannot be parsed under Node (U-046's measurement: the app's platform modules
 * reach `react-native/index.js`, which is Flow). Loading them inside `appSource()` costs nothing and keeps the
 * whole decision testable on the host.
 */

import type { PrefetchOptions, PrefetchProgress } from "@lectern/api-client";
import { createCachingChunkSource } from "@lectern/api-client";
import type { BlobCache, DocumentModel, LibraryStore, PlayableOptions } from "@lectern/core";
import { playableSentences, sentenceAt } from "@lectern/core";
import { chunkIdFor, parseVoiceId } from "@lectern/core-tts";

/** The setting key a document's pin lives under (F§5.9's `setting` entity). */
export function offlinePinKey(docId: string): string {
  return `offline:${docId}`;
}

/** A pin: the voice and the engine speed a document's audio was synthesized at (F§6). */
export interface OfflinePin {
  voiceId: string;
  synthSpeed: number;
}

/** How much of a document is downloaded: the sentences cached so far, out of all of them. */
export type OfflineProgress = PrefetchProgress;

/** What a document's offline state is: nothing pinned, pinned and incomplete, or pinned and whole. */
export type OfflineState = "none" | "partial" | "complete";

/** The two members of F§5.8's caching chunk source a pack is built and measured with. */
export interface OfflineChunks {
  prefetchDocument(doc: DocumentModel, voiceId: string, options?: PrefetchOptions): AsyncIterable<PrefetchProgress>;
  isCached(text: string, voiceId: string, synthSpeed: number): Promise<boolean>;
}

/** Everything a pack is made from: the library, the cache, the hub's chunks, and the reader's settings. */
export interface OfflineSource {
  /** The records a reader owns (F§5.9), where a pin is kept. */
  store: LibraryStore;
  /** The bytes a reader plays (F§5.9), where a pack lives. */
  cache: BlobCache;
  /** F§5.8's chunk source, which is what synthesizes a sentence and knows a cached one. */
  chunks: OfflineChunks;
  /** The reader's preferences this moment: the voice a pack is prepared with, and the cache limit. */
  settings: () => Promise<{ voiceId: string; cacheLimitBytes: number }>;
  /** The voices the hub offers (F§6), asked only when the reader has chosen none. */
  voices: () => Promise<readonly { id: string }[]>;
  /** Keep the voice a pack was prepared with as the reader's own. */
  adoptVoice: (voiceId: string) => Promise<void>;
}

/** The engine speed a pack is synthesized at (F§5.6(e)): one cached chunk serves every reading rate. */
const SYNTH_SPEED = 1;

/** Every sentence is packed, furniture included, so the reader's reading mode cannot find a gap (F§10.1). */
const PACK_ORDER: PlayableOptions = { skipFurniture: false };

/**
 * The suffix F§5.8's chunk source keeps a chunk's metadata under, beside the audio (`@lectern/api-client`'s
 * own layout). A pinned chunk needs both halves, so the predicate answers for both.
 */
const METADATA_SUFFIX = ".json";

/** The setting the reader's chosen voice lives under — the same key the player reads (U-048). */
const VOICE_SETTING = "voiceId";

/** The setting the reader's cache limit lives under (F§5.9's `setting` entity). */
export const CACHE_LIMIT_SETTING = "cacheLimitBytes";

/** What the cache is allowed to hold when the reader has never chosen a limit (the web app's own default). */
export const DEFAULT_CACHE_LIMIT_BYTES = 256 * 1024 * 1024;

/**
 * `DownloadCancelledError` — what a download the reader stopped ends with.
 *
 * It is a distinct type rather than an `Error` with a message, because the row has to tell the reader's own
 * cancel from a failure: a cancel is not something to show a sentence about, and a failure is.
 */
export class DownloadCancelledError extends Error {
  constructor() {
    super("the download was cancelled");
    this.name = "DownloadCancelledError";
  }
}

/** Whether a thrown value is a download the reader stopped, rather than something that went wrong. */
export function isDownloadCancelled(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "DownloadCancelledError";
}

/** A stored cache limit, or the default when the column holds something that is not a usable size. */
function cacheLimitFrom(stored: number | null): number {
  if (stored === null || !Number.isFinite(stored) || stored < 0) return DEFAULT_CACHE_LIMIT_BYTES;
  return stored;
}

/** The pin a document holds, or `null` when it holds none — including the `null` a removal writes. */
async function readPin(own: OfflineSource, docId: string): Promise<OfflinePin | null> {
  const stored = await own.store.getSetting<unknown>(offlinePinKey(docId));
  if (stored === null || typeof stored !== "object") return null;
  const record: Record<string, unknown> = { ...stored };
  if (typeof record.voiceId !== "string" || record.voiceId === "") return null;
  if (typeof record.synthSpeed !== "number" || !Number.isFinite(record.synthSpeed)) return null;
  return { voiceId: record.voiceId, synthSpeed: record.synthSpeed };
}

/** Every blob key one document's audio occupies: each sentence's chunk, and the metadata beside it. */
function packKeys(model: DocumentModel, voiceId: string, synthSpeed: number): string[] {
  const parts = parseVoiceId(voiceId);
  if (parts === null) return [];
  const keys: string[] = [];
  for (const index of playableSentences(model, PACK_ORDER)) {
    const chunkId = chunkIdFor(parts.engine, parts.engineVoiceId, synthSpeed, sentenceAt(model, index).text);
    keys.push(chunkId, `${chunkId}${METADATA_SUFFIX}`);
  }
  return keys;
}

/** How many of a document's sentences are cached right now, out of how many there are. */
async function countCached(own: OfflineSource, model: DocumentModel, pin: OfflinePin): Promise<OfflineProgress> {
  const indexes = playableSentences(model, PACK_ORDER);
  let done = 0;
  for (const index of indexes) {
    if (await own.chunks.isCached(sentenceAt(model, index).text, pin.voiceId, pin.synthSpeed)) done += 1;
  }
  return { done, total: indexes.length };
}

/** The voice a pack is prepared with: the reader's own, or the hub's first while they have chosen none. */
async function voiceFor(own: OfflineSource): Promise<string> {
  const chosen = (await own.settings()).voiceId;
  if (chosen !== "") return chosen;
  const offered = await own.voices();
  return offered[0]?.id ?? "";
}

/**
 * The app's own source: the stores this installation keeps its library in, the connection's own client, and the
 * two settings a pack reads. Both platform modules are imported here rather than at the top of the file, so
 * that nothing is evaluated in Node (see this file's header).
 */
async function appSource(): Promise<OfflineSource> {
  const { getStores } = await import("../stores");
  const { createClient } = await import("../connection");
  const stores = await getStores();
  const client = await createClient();
  return {
    store: stores.store,
    cache: stores.cache,
    chunks: createCachingChunkSource({ client, cache: stores.cache }),
    settings: async () => ({
      voiceId: (await stores.store.getSetting<string>(VOICE_SETTING)) ?? "",
      cacheLimitBytes: cacheLimitFrom(await stores.store.getSetting<number>(CACHE_LIMIT_SETTING)),
    }),
    voices: async () => await client.voices(),
    adoptVoice: async (voiceId) => {
      await stores.store.setSetting(VOICE_SETTING, voiceId);
    },
  };
}

/**
 * `downloadForOffline(docId, onProgress, signal)` — pin every sentence of a document, reporting progress as it
 * goes, and let the reader stop it.
 *
 * The pin is written first, so a download that is stopped or that fails leaves a `partial` pack — audible for
 * the sentences that did arrive, and offering to be finished — rather than a document that silently reads as
 * if nothing had happened. The cache limit is enforced once the whole document is cached, so the bytes that
 * were just fetched are protected by the very eviction the call then triggers.
 *
 * Cancellation is the consumer's: F§7.2's routes have no cancel, and the hub client exposes no abort signal
 * (measured at U-049), so this stops asking for further sentences — a request already in flight is not claimed
 * to have been aborted.
 */
export async function downloadForOffline(
  docId: string,
  onProgress: (progress: OfflineProgress) => void,
  signal?: AbortSignal,
  source?: OfflineSource,
): Promise<void> {
  const own = source ?? (await appSource());
  const model = await own.store.getDocumentModel(docId);
  if (model === null) throw new Error(`the library holds no document ${docId} to download (F§5.9)`);

  const voiceId = await voiceFor(own);
  if (voiceId === "") throw new Error("the hub offers no voice to prepare this document with (F§6)");

  await own.store.setSetting(offlinePinKey(docId), { voiceId, synthSpeed: SYNTH_SPEED } satisfies OfflinePin);

  for await (const progress of own.chunks.prefetchDocument(model, voiceId, {
    synthSpeed: SYNTH_SPEED,
    skipFurniture: PACK_ORDER.skipFurniture,
  })) {
    if (signal?.aborted === true) throw new DownloadCancelledError();
    onProgress(progress);
  }
  if (signal?.aborted === true) throw new DownloadCancelledError();

  await own.adoptVoice(voiceId);
  await enforceCacheLimit(undefined, own);
}

/**
 * `removeOffline(docId)` — unpin a document, and let the cache take its audio back.
 *
 * The limit is enforced straight away, so the space a removed pack occupied is returned to the reader in the
 * same breath. What is dropped is exactly what is no longer pinned.
 */
export async function removeOffline(docId: string, source?: OfflineSource): Promise<void> {
  const own = source ?? (await appSource());
  await own.store.setSetting(offlinePinKey(docId), null);
  await enforceCacheLimit(undefined, own);
}

/**
 * `offlineState(docId)` — `none` for a document with no pin, `complete` when every sentence of a pinned
 * document is cached, and `partial` for a pin the cache has not caught up with: a download the reader stopped
 * or that failed, or one whose audio was dropped while the document was unpinned.
 */
export async function offlineState(docId: string, source?: OfflineSource): Promise<OfflineState> {
  const own = source ?? (await appSource());
  const pin = await readPin(own, docId);
  if (pin === null) return "none";
  const model = await own.store.getDocumentModel(docId);
  if (model === null) return "none";
  const { done, total } = await countCached(own, model, pin);
  return total > 0 && done === total ? "complete" : "partial";
}

/**
 * `pinnedPredicate()` — the predicate `evictLru` keeps pinned audio with.
 *
 * The keys are computed rather than remembered: a chunk's id follows from its text, its voice and its engine
 * speed (F§6), all three of which the pin holds, so nothing else has to be stored. A document whose model is
 * gone contributes no keys, which is what lets a deleted document's audio be evicted (F§5.9).
 */
export async function pinnedPredicate(source?: OfflineSource): Promise<(key: string) => boolean> {
  const own = source ?? (await appSource());
  const pinned = new Set<string>();
  for (const document of await own.store.listDocuments()) {
    const pin = await readPin(own, document.docId);
    if (pin === null) continue;
    const model = await own.store.getDocumentModel(document.docId);
    if (model === null) continue;
    for (const key of packKeys(model, pin.voiceId, pin.synthSpeed)) pinned.add(key);
  }
  return (key) => pinned.has(key);
}

/**
 * `enforceCacheLimit(maxBytes?)` — bring the cache back inside the reader's limit, and answer the bytes freed.
 *
 * The limit is the reader's own saved size unless a caller names another; `0` clears every unpinned byte, which
 * is the same operation with nothing left to keep. A limit the store cannot read as a size is the default.
 */
export async function enforceCacheLimit(maxBytes?: number, source?: OfflineSource): Promise<number> {
  const own = source ?? (await appSource());
  const limit = maxBytes ?? (await own.settings()).cacheLimitBytes;
  return await own.cache.evictLru(limit, await pinnedPredicate(own));
}
