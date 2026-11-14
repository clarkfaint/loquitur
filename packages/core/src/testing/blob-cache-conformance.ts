/**
 * The conformance suite every `BlobCache` implementation must pass (F§5.9). It is runner-agnostic: it
 * drives the cache through the interface only, so the same cases run against memory, IndexedDB, SQLite and
 * a file-system cache, and returns one result per case.
 *
 * The URIs a cache hands back are its own business — a browser cache returns an object URL — so the suite
 * compares `uri` with the value `put` returned rather than with a scheme.
 */

import type { BlobCache } from "../store/types";

export type BlobCacheFactory = () => BlobCache | Promise<BlobCache>;

export interface BlobCacheConformanceResult {
  name: string;
  ok: boolean;
  error?: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Bytes of a fixed length, distributed so a wrong length or a truncated read is visible in the content. */
function bytesOf(length: number, seed = 0): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index + seed) % 251;
  return bytes;
}

/** Run every F§5.9 blob-cache case against `factory`. Each case gets a fresh cache of its own. */
export async function runBlobCacheConformance(factory: BlobCacheFactory): Promise<BlobCacheConformanceResult[]> {
  const results: BlobCacheConformanceResult[] = [];

  const record = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
      results.push({ name, ok: true });
    } catch (cause) {
      results.push({ name, ok: false, error: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  await record("put, has, get, uri and delete round trip", async () => {
    const cache = await factory();
    const bytes = bytesOf(4, 1);
    const written = await cache.put("clip", bytes, "audio/wav");

    assert(written.length > 0, "put answered an empty URI");
    assert(await cache.has("clip"), "has answered false straight after put");
    assert((await cache.uri("clip")) === written, "uri did not answer the URI put wrote");

    const read = await cache.get("clip");
    assert(read !== null, "get answered null for a key that is present");
    assert(read.length === bytes.length, `get answered ${read.length} bytes, expected ${bytes.length}`);
    assert(read[0] === bytes[0] && read[3] === bytes[3], "get answered different bytes");

    assert(!(await cache.has("absent")), "has answered true for an absent key");
    assert((await cache.get("absent")) === null, "get answered bytes for an absent key");
    assert((await cache.uri("absent")) === null, "uri answered a URI for an absent key");

    await cache.delete("clip");
    assert(!(await cache.has("clip")), "has answered true after delete");
    assert((await cache.get("clip")) === null, "get answered bytes after delete");
    assert((await cache.uri("clip")) === null, "uri answered a URI after delete");
    await cache.delete("clip");
  });

  await record("sizeBytes sums the stored bytes", async () => {
    const cache = await factory();
    assert((await cache.sizeBytes()) === 0, "an empty cache reported bytes");
    await cache.put("a", bytesOf(100), "application/octet-stream");
    await cache.put("b", bytesOf(250), "application/octet-stream");
    assert((await cache.sizeBytes()) === 350, `two entries totalled ${await cache.sizeBytes()} bytes, expected 350`);
    await cache.delete("a");
    assert((await cache.sizeBytes()) === 250, `after a delete the cache held ${await cache.sizeBytes()} bytes, expected 250`);
    await cache.put("b", bytesOf(10), "application/octet-stream");
    assert((await cache.sizeBytes()) === 10, `replacing an entry left ${await cache.sizeBytes()} bytes, expected 10`);
    await cache.delete("b");
    assert((await cache.sizeBytes()) === 0, "the empty cache did not report 0 bytes");
  });

  await record("evictLru removes the least-recently-used unpinned entries and never removes pinned ones", async () => {
    const cache = await factory();
    await cache.put("pinned", bytesOf(300), "audio/mpeg");
    await cache.put("old", bytesOf(200), "audio/mpeg");
    await cache.put("new", bytesOf(100), "audio/mpeg");
    assert((await cache.sizeBytes()) === 600, `three entries totalled ${await cache.sizeBytes()} bytes`);
    assert((await cache.get("old")) !== null, "the entry about to be touched is missing");

    const freed = await cache.evictLru(300, (key) => key === "pinned");
    assert(freed === 300, `evictLru freed ${freed} bytes, expected 300`);
    assert(await cache.has("pinned"), "evictLru removed the pinned entry");
    assert(!(await cache.has("old")) && !(await cache.has("new")), "evictLru kept an unpinned entry above the limit");
    assert((await cache.sizeBytes()) === 300, `after eviction the cache held ${await cache.sizeBytes()} bytes, expected 300`);

    const again = await cache.evictLru(100, (key) => key === "pinned");
    assert(again === 0, `evictLru freed ${again} bytes when only a pinned entry was left`);
    assert(await cache.has("pinned"), "the pinned entry went to reach the limit");
    assert((await cache.sizeBytes()) === 300, "evicting with only a pinned entry left changed the size");
  });

  return results;
}
