/**
 * The in-memory `BlobCache` (F§5.9): the bytes a reader plays, held in `Map`s and handed back as
 * `memory://` URIs. It is the reference the platform caches are measured against, and the cache a test
 * runs against without touching a disk.
 *
 * Recency is a counter, not a clock: every read, write and URI request takes the next number, and
 * `evictLru` removes the lowest numbers first. That keeps eviction deterministic — two caches fed the same
 * calls evict the same entries — and keeps the cache free of a dependency on the injected `now()` the
 * record stores take.
 */

import type { BlobCache } from "./types";

/** One cached chunk: its bytes, its declared type, and the counter value of its last use. */
interface BlobEntry {
  bytes: Uint8Array;
  mime: string;
  lastUsed: number;
}

/** `createMemoryBlobCache()` — a `BlobCache` that lives for as long as the process does. */
export function createMemoryBlobCache(): BlobCache {
  const entries = new Map<string, BlobEntry>();
  let uses = 0;

  /** Mark an entry as just used and hand it back, or `null` when the key is absent. */
  const touch = (key: string): BlobEntry | null => {
    const entry = entries.get(key);
    if (entry === undefined) return null;
    uses += 1;
    entry.lastUsed = uses;
    return entry;
  };

  /** The bytes on hand right now, which every eviction decision is measured against. */
  const totalBytes = (): number => {
    let total = 0;
    for (const entry of entries.values()) total += entry.bytes.length;
    return total;
  };

  return {
    async has(key) {
      return entries.has(key);
    },

    async put(key, bytes, mime) {
      uses += 1;
      entries.set(key, { bytes: bytes.slice(), mime, lastUsed: uses });
      return `memory://${key}`;
    },

    async get(key) {
      const entry = touch(key);
      return entry === null ? null : entry.bytes.slice();
    },

    async uri(key) {
      const entry = touch(key);
      return entry === null ? null : `memory://${key}`;
    },

    async delete(key) {
      entries.delete(key);
    },

    async sizeBytes() {
      return totalBytes();
    },

    async evictLru(maxBytes, pinned) {
      let total = totalBytes();
      let freed = 0;
      const candidates = [...entries.entries()].filter(([key]) => !pinned(key)).sort((left, right) => left[1].lastUsed - right[1].lastUsed);
      for (const [key, entry] of candidates) {
        if (total <= maxBytes) break;
        entries.delete(key);
        total -= entry.bytes.length;
        freed += entry.bytes.length;
      }
      return freed;
    },
  };
}
