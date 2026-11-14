/**
 * U-021's contract (F§5.8, F§5.9, F§6): the caching chunk source against a real hub app running F§6's mock
 * engine — the first `get` reaches the hub once and keeps both halves of the chunk, a second `get` makes no
 * request, concurrent `get`s share one synthesis, a cached chunk still plays with the hub unreachable while an
 * uncached one reports `offline`, the local chunk id is the hub's, and a prefetch caches exactly the sentences
 * playback will read.
 *
 * The transport is counted, so "no request" is an assertion about the wire rather than about the cache alone.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BlobCache, buildDocument, createMemoryBlobCache, type DocumentModel, playableSentences, sentenceAt } from "@lectern/core";
import { chunkIdFor } from "@lectern/core-tts";
import { buildApp, loadConfig } from "@lectern/server";
import { expect, test } from "vitest";
import { type CachingChunkSource, createCachingChunkSource, type PrefetchProgress } from "../chunk-source";
import { createHubClient, type HubClient } from "../client";
import { HubClientError } from "../errors";
import { fetchFromFastify } from "../testing/fastify-fetch";

/** F§7.1's token floor is 32 characters; this one clears it and appears nowhere else. */
const TOKEN = "lectern-chunk-source-token-0123456789";

/** F§6's golden chunk id for `['mock', 'mock-a', '1.00', 'Hello, world.']`, quoted verbatim. */
const GOLDEN_CHUNK_ID = "3bfbfd2ad841c9c08af4bcc1c7ccb8560d318c76";

/** The address the client is pointed at. The adapter routes on the path, so the host is only a name. */
const BASE_URL = "http://127.0.0.1:8787";

/** The text every cache case uses, which is the text the golden id names. */
const TEXT = "Hello, world.";

/** A sentence no case ever caches, for the offline path. */
const UNCACHED_TEXT = "A sentence no cache has ever held.";

/** The voice F§6's mock engine offers first. */
const VOICE = "mock:mock-a";

/** A hub app, a cache, a counted transport, and the two factories a case builds from them. */
interface Hub {
  cache: BlobCache;
  calls: () => number;
  /** A transport that always rejects, which is what an unreachable hub looks like. */
  offline: typeof fetch;
  client: (transport?: typeof fetch) => HubClient;
  source: (transport?: typeof fetch) => CachingChunkSource;
}

/** The failure a call raised, or a failure of this test when the call raised none. */
async function failureOf(call: () => Promise<unknown>): Promise<HubClientError> {
  try {
    await call();
  } catch (cause) {
    if (cause instanceof HubClientError) return cause;
    throw cause;
  }
  throw new Error("the call was expected to fail");
}

/**
 * A document with one playable paragraph and one piece of furniture: F§5.4 keeps a header in the model and
 * marks it skipped, so a prefetch has both kinds of sentence to decide on.
 */
function documentFixture(): DocumentModel {
  return buildDocument(
    [
      { kind: "paragraph", text: `${TEXT} A second sentence follows it.` },
      { kind: "header", text: "Lectern running header" },
    ],
    {
      title: "Prefetch fixture",
      source: { kind: "txt" },
    },
  );
}

/** Build the hub over a temporary data directory, then close it and remove the directory. */
async function withHub(run: (hub: Hub) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "lectern-chunk-source-"));
  const app = await buildApp(loadConfig({ LECTERN_TOKEN: TOKEN, LECTERN_DATA_DIR: dataDir, LECTERN_ENABLE_MOCK: "1" }));
  const adapter = fetchFromFastify(app);
  const cache = createMemoryBlobCache();
  let calls = 0;
  const counted: typeof fetch = async (input, init) => {
    calls += 1;
    return await adapter(input, init);
  };
  const clientFor = (transport: typeof fetch = counted): HubClient =>
    createHubClient({ baseUrl: BASE_URL, token: TOKEN, fetch: transport });
  const offline: typeof fetch = async () => {
    throw new TypeError("the hub is unreachable");
  };
  try {
    await run({
      cache,
      calls: () => calls,
      offline,
      client: clientFor,
      source: (transport: typeof fetch = counted) => createCachingChunkSource({ client: clientFor(transport), cache }),
    });
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("the first get reaches the hub once and keeps the audio and its metadata", async () => {
  await withHub(async (hub) => {
    const source = hub.source();
    const chunk = await source.get({ text: TEXT, voiceId: VOICE, synthSpeed: 1 });
    expect(chunk.chunkId).toBe(GOLDEN_CHUNK_ID);
    expect(chunk.uri).toBe(`memory://${GOLDEN_CHUNK_ID}`);
    expect(chunk.durationMs).toBeGreaterThan(0);
    expect(chunk.timings.map((timing) => timing.i)).toEqual([0, 1]);
    expect(chunk.timingSource).toBe("engine");
    expect(await hub.cache.has(GOLDEN_CHUNK_ID)).toBe(true);
    expect(await hub.cache.has(`${GOLDEN_CHUNK_ID}.json`)).toBe(true);
    expect(await source.isCached(TEXT, VOICE, 1)).toBe(true);
    // One synthesis and one audio download: two requests, and no more.
    expect(hub.calls()).toBe(2);
  });
});

test("the chunk id is F§6's, the hub agrees with it, and a second get makes no request", async () => {
  await withHub(async (hub) => {
    const source = hub.source();
    const first = await source.get({ text: TEXT, voiceId: VOICE, synthSpeed: 1 });
    expect(first.chunkId).toBe(chunkIdFor("mock", "mock-a", 1, TEXT));
    const answer = await hub.client().tts({ text: TEXT, voiceId: VOICE, synthSpeed: 1 });
    expect(answer.chunkId).toBe(first.chunkId);

    const requests = hub.calls();
    const second = await source.get({ text: TEXT, voiceId: VOICE, synthSpeed: 1 });
    expect(second).toEqual(first);
    expect(hub.calls()).toBe(requests);
  });
});

test("a cached chunk plays while the hub is unreachable, and an uncached one reports offline", async () => {
  await withHub(async (hub) => {
    await hub.source().get({ text: TEXT, voiceId: VOICE, synthSpeed: 1 });
    const offline = hub.source(hub.offline);
    const replay = await offline.get({ text: TEXT, voiceId: VOICE, synthSpeed: 1 });
    expect(replay.uri).toBe(`memory://${GOLDEN_CHUNK_ID}`);
    expect(replay.timings.map((timing) => timing.i)).toEqual([0, 1]);

    expect(await offline.isCached(UNCACHED_TEXT, VOICE, 1)).toBe(false);
    const error = await failureOf(async () => await offline.get({ text: UNCACHED_TEXT, voiceId: VOICE, synthSpeed: 1 }));
    expect(error.offline).toBe(true);
    expect(error.code).toBe("ENGINE_UNAVAILABLE");
  });
});

test("concurrent gets for one chunk share a single synthesis", async () => {
  await withHub(async (hub) => {
    const source = hub.source();
    const request = { text: TEXT, voiceId: VOICE, synthSpeed: 1 };
    const chunks = await Promise.all([source.get(request), source.get(request), source.get(request)]);
    expect(chunks.map((chunk) => chunk.chunkId)).toEqual([GOLDEN_CHUNK_ID, GOLDEN_CHUNK_ID, GOLDEN_CHUNK_ID]);
    expect(hub.calls()).toBe(2);
  });
});

test("prefetchDocument caches every playable sentence and reports progress", async () => {
  await withHub(async (hub) => {
    const doc = documentFixture();
    const source = hub.source();
    const playable = playableSentences(doc, { skipFurniture: true });
    const furniture = playableSentences(doc, { skipFurniture: false }).filter((index) => !playable.includes(index));
    expect(doc.sentenceCount).toBe(3);
    expect(furniture).toHaveLength(1);

    const steps: PrefetchProgress[] = [];
    for await (const step of source.prefetchDocument(doc, VOICE)) steps.push(step);
    expect(steps).toEqual([
      { done: 0, total: 2 },
      { done: 1, total: 2 },
      { done: 2, total: 2 },
    ]);

    for (const index of playable) {
      expect(await source.isCached(sentenceAt(doc, index).text, VOICE, 1)).toBe(true);
    }
    for (const index of furniture) {
      expect(await source.isCached(sentenceAt(doc, index).text, VOICE, 1)).toBe(false);
    }
    // Two playable sentences, each one synthesis and one audio download.
    expect(hub.calls()).toBe(4);
  });
});

test("a prefetch can be told to read the furniture as well", async () => {
  await withHub(async (hub) => {
    const doc = documentFixture();
    const source = hub.source();
    const steps: PrefetchProgress[] = [];
    for await (const step of source.prefetchDocument(doc, VOICE, { skipFurniture: false })) steps.push(step);
    expect(steps.at(-1)).toEqual({ done: 3, total: 3 });
    for (const index of playableSentences(doc, { skipFurniture: false })) {
      expect(await source.isCached(sentenceAt(doc, index).text, VOICE, 1)).toBe(true);
    }
  });
});

test("an id that is not an engine:voice pair is refused before any request", async () => {
  await withHub(async (hub) => {
    const source = hub.source();
    expect(await source.isCached(TEXT, "not-a-voice", 1)).toBe(false);
    const error = await failureOf(async () => await source.get({ text: TEXT, voiceId: "not-a-voice", synthSpeed: 1 }));
    expect(error.code).toBe("UNKNOWN_VOICE");
    expect(error.offline).toBe(false);
    expect(hub.calls()).toBe(0);
  });
});
