/**
 * An in-memory `BlobFs`, for tests (F§5.9).
 *
 * It answers `memory-file://blobs/<key>` for a key's location, which is a URI a test can compare with the
 * one `put` returned but which no player can open — that is the point: the blob cache's conformance suite
 * compares a cache's `uri` with what its own `put` answered rather than with a scheme, so a file system that
 * never touches a disk can run the same cases a device runs.
 *
 * Bytes are copied on the way in and on the way out, so a caller that keeps its array cannot change what the
 * file system holds, and a caller that mutates what it read cannot change what a later read answers.
 */

import type { BlobFs } from "../driver";

/** The prefix of every location this file system answers. */
const URI_PREFIX = "memory-file://blobs/";

/** `createMemoryBlobFs()` — a `BlobFs` that lives for as long as the process does. */
export function createMemoryBlobFs(): BlobFs {
  const files = new Map<string, Uint8Array>();

  return {
    async write(key, bytes) {
      files.set(key, new Uint8Array(bytes));
    },

    async read(key) {
      const stored = files.get(key);
      return stored === undefined ? null : new Uint8Array(stored);
    },

    async remove(key) {
      files.delete(key);
    },

    async exists(key) {
      return files.has(key);
    },

    async uri(key) {
      return files.has(key) ? `${URI_PREFIX}${encodeURIComponent(key)}` : null;
    },
  };
}
