/**
 * Downloading a document for offline reading (F§10.1, F§5.9).
 *
 * What is under test is the service's own arithmetic: the chunk ids a pin covers, the progress a download
 * reports, and which keys the cache's eviction is allowed to touch. The stores are `@lectern/core`'s
 * in-memory ones and the chunk source is this file's — the hub's own synthesis belongs to U-021 and the
 * durable store to U-026, and neither is what a pack decides.
 */

import {
  type BlobCache,
  buildDocument,
  createMemoryBlobCache,
  createMemoryLibraryStore,
  type DocumentModel,
  type LibraryStore,
  playableSentences,
  sentenceAt,
} from "@lectern/core";
import { chunkIdFor, parseVoiceId } from "@lectern/core-tts";
import { describe, expect, it } from "vitest";
import {
  downloadForOffline,
  enforceCacheLimit,
  type OfflineChunks,
  type OfflineProgress,
  type OfflineSource,
  offlinePinKey,
  offlineState,
  pinnedPredicate,
  removeOffline,
} from "../offline/offline-service";

/** The document every case packs: four sentences, so a download has more than one step to report. */
const TEXT = ["The lamp is lit.", "The page is turned.", "The kettle sings.", "The night is long."].join(" ");

/** The voice a pack is synthesized with, as F§6 spells it. */
const VOICE_ID = "mock:mock-a";

/** The engine speed the app's own sink leaves synthesis at (F§5.6(e)). */
const SYNTH_SPEED = 1;

/** How many bytes this file's chunk source writes for one sentence's audio, and for its metadata. */
const AUDIO_BYTES = 32;
const METADATA_BYTES = 8;

/** The store's clock, pinned so a record the service writes is the same one every run. */
const NOW = 1_700_000_000_000;

/** The bytes one sentence's cached audio occupies, both halves counted. */
const SENTENCE_BYTES = AUDIO_BYTES + METADATA_BYTES;

/** The document, as F§5.4 builds it from a paragraph. */
function model(): DocumentModel {
  return buildDocument([{ kind: "paragraph", text: TEXT }], { title: "A quiet evening", source: { kind: "txt" } });
}

/** The chunk id one sentence of a document is cached under (F§6). */
function keyFor(text: string, voiceId = VOICE_ID, synthSpeed = SYNTH_SPEED): string {
  const parts = parseVoiceId(voiceId);
  if (parts === null) throw new Error(`${voiceId} is not an engine:voice identifier (F§6)`);
  return chunkIdFor(parts.engine, parts.engineVoiceId, synthSpeed, text);
}

/** Every key a document's audio occupies at one voice and speed: each sentence, and its metadata. */
function keysFor(document: DocumentModel): string[] {
  return playableSentences(document, { skipFurniture: false }).flatMap((index) => {
    const chunkId = keyFor(sentenceAt(document, index).text);
    return [chunkId, `${chunkId}.json`];
  });
}

/** A chunk source that writes fixed bytes under the chunk id F§6 computes, and knows what it has written. */
function fakeChunks(cache: BlobCache): OfflineChunks {
  return {
    async isCached(text, voiceId, synthSpeed) {
      const chunkId = keyFor(text, voiceId, synthSpeed);
      return (await cache.has(chunkId)) && (await cache.has(`${chunkId}.json`));
    },
    async *prefetchDocument(document, voiceId, options) {
      const synthSpeed = options?.synthSpeed ?? SYNTH_SPEED;
      const indexes = playableSentences(document, { skipFurniture: options?.skipFurniture ?? true });
      yield { done: 0, total: indexes.length };
      let done = 0;
      for (const index of indexes) {
        const chunkId = keyFor(sentenceAt(document, index).text, voiceId, synthSpeed);
        await cache.put(chunkId, new Uint8Array(AUDIO_BYTES), "audio/wav");
        await cache.put(`${chunkId}.json`, new Uint8Array(METADATA_BYTES), "application/json");
        done += 1;
        yield { done, total: indexes.length };
      }
    },
  };
}

/** One case's own stores, chunk source and settings, wired the way the app wires them. */
interface Rig {
  source: OfflineSource;
  store: LibraryStore;
  cache: BlobCache;
  /** The voices the reader was offered, which is what a pack with no chosen voice falls back to. */
  adopted: string[];
}

/** The cache limit every case but the eviction one runs with: room for a pack and nothing else to prove. */
const ROOMY = 1024 * 1024;

function rig(options: { cacheLimitBytes?: number; voiceId?: string; voices?: readonly { id: string }[] } = {}): Rig {
  let counter = 0;
  const store = createMemoryLibraryStore({
    deviceId: "device-1",
    now: () => NOW,
    newId: () => {
      counter += 1;
      return `id-${counter}`;
    },
  });
  const cache = createMemoryBlobCache();
  const settings = {
    voiceId: options.voiceId ?? VOICE_ID,
    skipFurniture: true,
    cacheLimitBytes: options.cacheLimitBytes ?? ROOMY,
  };
  const adopted: string[] = [];
  const source: OfflineSource = {
    store,
    cache,
    chunks: fakeChunks(cache),
    settings: () => settings,
    voices: async () => options.voices ?? [{ id: VOICE_ID }],
    adoptVoice: async (voiceId) => {
      adopted.push(voiceId);
    },
  };
  return { source, store, cache, adopted };
}

/** Put a document in the library, as an import does (F§5.9). */
async function put(store: LibraryStore, document: DocumentModel): Promise<void> {
  await store.putDocument(
    {
      docId: document.docId,
      title: document.title,
      sourceKind: document.source.kind,
      folderId: null,
      addedAt: NOW,
      wordCount: document.wordCount,
      sentenceCount: document.sentenceCount,
      updatedAt: NOW,
      deleted: false,
    },
    document,
  );
}

describe("offlinePinKey", () => {
  it("names a document's pin after the document", () => {
    expect(offlinePinKey("a1b2c3")).toBe("offline:a1b2c3");
  });
});

describe("downloadForOffline", () => {
  it("caches every sentence, reports progress to the end, and pins the document", async () => {
    const { source, store, cache, adopted } = rig();
    const document = model();
    await put(store, document);

    const steps: OfflineProgress[] = [];
    await downloadForOffline(document.docId, (progress) => steps.push(progress), source);

    // F§10.1's own words: every sentence of the document, which for this model is all four of them.
    expect(steps[0]).toEqual({ done: 0, total: 4 });
    expect(steps.at(-1)).toEqual({ done: 4, total: 4 });
    expect(steps.map((step) => step.done)).toEqual([0, 1, 2, 3, 4]);

    // The pin holds the voice and the engine speed the audio was synthesized at, and nothing else.
    expect(await store.getSetting(offlinePinKey(document.docId))).toEqual({ voiceId: VOICE_ID, synthSpeed: SYNTH_SPEED });
    expect(await offlineState(document.docId, source)).toBe("complete");
    expect(await cache.sizeBytes()).toBe(4 * SENTENCE_BYTES);

    // A reader who never picked a voice reads with the one their document was prepared with.
    expect(adopted).toEqual([VOICE_ID]);
  });

  it("pins a document the reader had no voice chosen for, with the hub's first voice", async () => {
    const { source, store, adopted } = rig({ voiceId: "", voices: [{ id: "mock:mock-b" }] });
    const document = model();
    await put(store, document);

    await downloadForOffline(document.docId, () => undefined, source);

    expect(await store.getSetting(offlinePinKey(document.docId))).toEqual({ voiceId: "mock:mock-b", synthSpeed: SYNTH_SPEED });
    expect(adopted).toEqual(["mock:mock-b"]);
  });

  it("refuses a document the library does not hold, and writes no pin", async () => {
    const { source, store } = rig();

    await expect(downloadForOffline("not-in-the-library", () => undefined, source)).rejects.toThrow(/no document/u);
    expect(await store.getSetting(offlinePinKey("not-in-the-library"))).toBeNull();
  });

  it("leaves the cache inside the reader's limit once the pack is pinned", async () => {
    const { source, store, cache } = rig({ cacheLimitBytes: 2 * SENTENCE_BYTES + 100 });
    const document = model();
    await put(store, document);

    // Something nobody pinned, of the size the limit will not hold beside a four-sentence pack.
    await cache.put("stray-chunk", new Uint8Array(200), "audio/wav");
    await downloadForOffline(document.docId, () => undefined, source);

    expect(await cache.has("stray-chunk")).toBe(false);
    expect(await cache.sizeBytes()).toBe(4 * SENTENCE_BYTES);
    expect(await offlineState(document.docId, source)).toBe("complete");
  });
});

describe("offlineState", () => {
  it("is none before a download and partial while a pinned document's audio is incomplete", async () => {
    const { source, store, cache } = rig();
    const document = model();
    await put(store, document);

    expect(await offlineState(document.docId, source)).toBe("none");

    await downloadForOffline(document.docId, () => undefined, source);
    expect(await offlineState(document.docId, source)).toBe("complete");

    // Half of one sentence's pair missing is a miss, as F§5.8's chunk source counts it.
    await cache.delete(`${keyFor(sentenceAt(document, 0).text)}.json`);
    expect(await offlineState(document.docId, source)).toBe("partial");
  });

  it("reads a stored value that is not a pin as no pin at all", async () => {
    const { source, store } = rig();
    const document = model();
    await put(store, document);

    await store.setSetting(offlinePinKey(document.docId), { voiceId: "", synthSpeed: SYNTH_SPEED });
    expect(await offlineState(document.docId, source)).toBe("none");

    await store.setSetting(offlinePinKey(document.docId), "yesterday");
    expect(await offlineState(document.docId, source)).toBe("none");
  });
});

describe("pinnedPredicate", () => {
  it("answers for every key a pinned document occupies, both halves of each chunk", async () => {
    const { source, store } = rig();
    const document = model();
    await put(store, document);
    await downloadForOffline(document.docId, () => undefined, source);

    const pinned = await pinnedPredicate(source);
    for (const key of keysFor(document)) expect(pinned(key)).toBe(true);
    expect(pinned("a-key-nobody-wrote")).toBe(false);
  });

  it("pins nothing for a document that was deleted, so its audio can be evicted (F§5.9)", async () => {
    const { source, store } = rig();
    const document = model();
    await put(store, document);
    await downloadForOffline(document.docId, () => undefined, source);
    const before = await pinnedPredicate(source);
    expect(before(keysFor(document)[0] ?? "")).toBe(true);

    await store.deleteDocument(document.docId);
    const after = await pinnedPredicate(source);
    expect(after(keysFor(document)[0] ?? "")).toBe(false);
  });
});

describe("removeOffline", () => {
  it("unpins a document and hands its audio back to the cache's own rule", async () => {
    const { source, store, cache } = rig();
    const document = model();
    await put(store, document);
    await downloadForOffline(document.docId, () => undefined, source);
    const packed = await cache.sizeBytes();
    expect(packed).toBe(4 * SENTENCE_BYTES);

    await removeOffline(document.docId, source);

    expect(await store.getSetting(offlinePinKey(document.docId))).toBeNull();
    expect(await offlineState(document.docId, source)).toBe("none");
    const pinned = await pinnedPredicate(source);
    expect(pinned(keysFor(document)[0] ?? "")).toBe(false);

    // Nothing is pinned any more, so the same eviction that kept the pack can now take all of it.
    expect(await enforceCacheLimit(0, source)).toBe(packed);
    expect(await cache.sizeBytes()).toBe(0);
  });
});

describe("enforceCacheLimit", () => {
  it("evicts nothing anybody pinned, and frees the rest down to the limit", async () => {
    const { source, store, cache } = rig({ cacheLimitBytes: 3 * SENTENCE_BYTES });
    const document = model();
    await put(store, document);
    await downloadForOffline(document.docId, () => undefined, source);

    // Two more blobs: one cached-but-unpinned chunk of another document, one nobody will miss.
    const stray = 256;
    await cache.put("another-document-chunk", new Uint8Array(stray), "audio/wav");
    await cache.put("nobody-pinned-this", new Uint8Array(stray), "audio/wav");

    const freed = await enforceCacheLimit(undefined, source);

    expect(freed).toBe(2 * stray);
    expect(await cache.has("another-document-chunk")).toBe(false);
    expect(await cache.has("nobody-pinned-this")).toBe(false);
    expect(await offlineState(document.docId, source)).toBe("complete");
    expect(await cache.sizeBytes()).toBe(4 * SENTENCE_BYTES);
    for (const key of keysFor(document)) expect(await cache.has(key)).toBe(true);
  });
});
