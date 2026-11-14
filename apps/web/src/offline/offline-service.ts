/**
 * Preparing a document to be read with no network (F§10.1, F§5.9).
 *
 * A pack is F§10.1's "download for offline": every sentence of a document is synthesized into F§5.9's
 * `BlobCache`, and the document is **pinned** so that the cache's own eviction cannot take it away. A pinned
 * document is playable in an aeroplane, and everything else the cache holds is still free to be dropped when
 * the reader's limit is reached.
 *
 * Four decisions are worth naming.
 *
 * - The pin is F§5.9's `setting` entity, keyed `offline:<docId>`, holding the voice and the engine speed the
 *   pack was synthesized at. Those two are what a chunk's id is computed from, so a pin is enough to
 *   recognise a document's audio later without asking the hub anything — which is the whole point, because
 *   the moment the pin matters is the moment the hub is unreachable.
 * - `evictLru` asks a **synchronous** predicate about every key it is considering, so the pin set has to be
 *   materialized first: `pinnedPredicate()` reads every pinned document's model and computes its keys.
 * - The voice a pack was prepared with becomes the reader's own voice, because a reader who comes back with
 *   no network cannot ask the hub which voices exist, and a chunk with no voice is not a chunk at all.
 * - The pack covers **every** sentence, furniture included (F§10.1 says "every sentence"), so the reading
 *   mode the reader chooses later cannot find a gap.
 *
 * F§5.9's `LibraryStore` has no way to remove a setting — `setSetting` writes, and nothing deletes — so
 * removing a pack writes a `null` value under the same key: a pin that is not an object is not a pin. The
 * record's own tombstone rule is unreachable from here (it is what `applyRemote` applies), and this is the
 * difference between "pinned" and "not pinned" that the store's interface can express.
 */

import type { PrefetchOptions, PrefetchProgress } from "@lectern/api-client";
import { type BlobCache, type DocumentModel, type LibraryStore, type PlayableOptions, playableSentences, sentenceAt } from "@lectern/core";
import { chunkIdFor, parseVoiceId } from "@lectern/core-tts";
import { getServices, getStorage } from "../services";
import { type Preferences, useSettingsStore } from "../settings/settings";

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
  /** The reader's preferences this moment (F§10.1): the voice, the reading mode and the cache limit. */
  settings: () => Pick<Preferences, "voiceId" | "skipFurniture" | "cacheLimitBytes">;
  /** The voices the hub offers (F§6), asked only when the reader has chosen none. */
  voices: () => Promise<readonly { id: string }[]>;
  /** Keep the voice a pack was prepared with as the reader's own. */
  adoptVoice: (voiceId: string) => Promise<void>;
}

/**
 * The engine speed a pack is synthesized at. F§5.6(e): the browser's sink has a ceiling of 16, so no rate the
 * reader can choose is split off to the synthesizer — one cached chunk serves every speed.
 */
const SYNTH_SPEED = 1;

/** Every sentence is packed, furniture included, so the reader's reading mode cannot find a gap (F§10.1). */
const PACK_ORDER: PlayableOptions = { skipFurniture: false };

/**
 * The suffix F§5.8's chunk source keeps a chunk's metadata under, beside the audio (`@lectern/api-client`'s
 * own layout). A pinned chunk needs both halves, so the predicate answers for both.
 */
const METADATA_SUFFIX = ".json";

/** The pin a document holds, or `null` when it holds none — including the `null` a removal writes. */
async function readPin(source: OfflineSource, docId: string): Promise<OfflinePin | null> {
  const stored = await source.store.getSetting<unknown>(offlinePinKey(docId));
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
async function countCached(source: OfflineSource, model: DocumentModel, pin: OfflinePin): Promise<OfflineProgress> {
  const indexes = playableSentences(model, PACK_ORDER);
  let done = 0;
  for (const index of indexes) {
    if (await source.chunks.isCached(sentenceAt(model, index).text, pin.voiceId, pin.synthSpeed)) done += 1;
  }
  return { done, total: indexes.length };
}

/** The voice a pack is prepared with: the reader's own, or the hub's first while they have chosen none. */
async function voiceFor(source: OfflineSource): Promise<string> {
  const chosen = source.settings().voiceId;
  if (chosen !== "") return chosen;
  const offered = await source.voices();
  return offered[0]?.id ?? "";
}

/** The app's own source: the connection's services, the reader's settings, and the settings store to write it. */
async function appSource(): Promise<OfflineSource> {
  const { store, cache } = await getStorage();
  const { chunks, client } = await getServices();
  return {
    store,
    cache,
    chunks,
    settings: () => useSettingsStore.getState().preferences,
    voices: async () => await client.voices(),
    adoptVoice: async (voiceId) => {
      await useSettingsStore.getState().update({ preferences: { voiceId } });
    },
  };
}

/**
 * `downloadForOffline(docId, onProgress)` — pin every sentence of a document, reporting progress as it goes.
 *
 * The pin is written before the limit is enforced, so the bytes that were just fetched are protected by the
 * very eviction the call then triggers. Nothing is written until the whole document is cached: a pin that
 * outlived a half-finished download would claim a document is readable offline when it is not.
 */
export async function downloadForOffline(
  docId: string,
  onProgress: (progress: OfflineProgress) => void,
  source?: OfflineSource,
): Promise<void> {
  const own = source ?? (await appSource());
  const model = await own.store.getDocumentModel(docId);
  if (model === null) throw new Error(`the library holds no document ${docId} to download (F§5.9)`);

  const voiceId = await voiceFor(own);
  if (voiceId === "") throw new Error("the hub offers no voice to prepare this document with (F§6)");

  for await (const progress of own.chunks.prefetchDocument(model, voiceId, {
    synthSpeed: SYNTH_SPEED,
    skipFurniture: PACK_ORDER.skipFurniture,
  })) {
    onProgress(progress);
  }

  await own.store.setSetting(offlinePinKey(docId), { voiceId, synthSpeed: SYNTH_SPEED } satisfies OfflinePin);
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
 * document is cached, and `partial` for a pin the cache has not caught up with (a download that was
 * interrupted, or one whose audio was dropped while the document was unpinned).
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
 * The limit is the reader's own saved size unless a caller names another; `0` is how the settings section
 * clears every unpinned byte, which is the same operation with nothing left to keep.
 */
export async function enforceCacheLimit(maxBytes?: number, source?: OfflineSource): Promise<number> {
  const own = source ?? (await appSource());
  const limit = maxBytes ?? own.settings().cacheLimitBytes;
  return await own.cache.evictLru(limit, await pinnedPredicate(own));
}
