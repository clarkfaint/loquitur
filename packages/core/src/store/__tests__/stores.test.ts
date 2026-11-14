/**
 * U-014's store contracts (F§5.9): the last-writer-wins truth table, both reference implementations run
 * through the conformance suites every platform store and cache has to pass, and the two schema facts the
 * contracts forbid from drifting.
 */

import { expect, test } from "vitest";
import { runBlobCacheConformance } from "../../testing/blob-cache-conformance";
import { runLibraryStoreConformance } from "../../testing/library-store-conformance";
import { isNewer } from "../lww";
import { createMemoryBlobCache } from "../memory-blob-cache";
import { createMemoryLibraryStore } from "../memory-library-store";
import { DocumentMetaSchema, OpSchema } from "../types";

/** The cases F§5.9's store suite is made of, in the order they run. */
const LIBRARY_CASES = [
  "document round trip",
  "list filtered by folder and by text",
  "delete produces a tombstone and removes the model",
  "folder, bookmark, progress and setting round trips",
  "each mutation appends exactly one op",
  "ackOps removes them",
  "applyRemote applies newer, ignores older, breaks ties by deviceId, and never appends to the outbox",
  "cursor round trip",
  "two stores exchanging all ops in both directions converge to equal state",
];

/** The cases F§5.9's blob-cache suite is made of, in the order they run. */
const BLOB_CASES = [
  "put, has, get, uri and delete round trip",
  "sizeBytes sums the stored bytes",
  "evictLru removes the least-recently-used unpinned entries and never removes pinned ones",
];

test("isNewer follows the last-writer-wins truth table", () => {
  expect(isNewer({ ts: 2, deviceId: "dev-a" }, { ts: 1, deviceId: "dev-z" })).toBe(true);
  expect(isNewer({ ts: 1, deviceId: "dev-a" }, { ts: 2, deviceId: "dev-z" })).toBe(false);
  expect(isNewer({ ts: 5, deviceId: "dev-b" }, { ts: 5, deviceId: "dev-a" })).toBe(true);
  expect(isNewer({ ts: 5, deviceId: "dev-a" }, { ts: 5, deviceId: "dev-b" })).toBe(false);
  expect(isNewer({ ts: 5, deviceId: "dev-a" }, { ts: 5, deviceId: "dev-a" })).toBe(false);
  expect(isNewer({ ts: 0, deviceId: "" }, { ts: -1, deviceId: "dev-z" })).toBe(true);
  expect(isNewer({ ts: 7, deviceId: "dev-10" }, { ts: 7, deviceId: "dev-9" })).toBe(false);
});

test("the memory library store passes every conformance case", async () => {
  const results = await runLibraryStoreConformance((options) => createMemoryLibraryStore(options));
  expect(results.map((result) => result.name)).toEqual(LIBRARY_CASES);
  expect(results.filter((result) => !result.ok)).toEqual([]);
});

test("the memory blob cache passes every conformance case", async () => {
  const results = await runBlobCacheConformance(() => createMemoryBlobCache());
  expect(results.map((result) => result.name)).toEqual(BLOB_CASES);
  expect(results.filter((result) => !result.ok)).toEqual([]);
});

test("the memory blob cache hands out memory:// URIs", async () => {
  const cache = createMemoryBlobCache();
  expect(await cache.uri("clip")).toBeNull();
  expect(await cache.put("clip", new Uint8Array([1, 2, 3]), "audio/wav")).toBe("memory://clip");
  expect(await cache.uri("clip")).toBe("memory://clip");
  expect(await cache.get("clip")).toEqual(new Uint8Array([1, 2, 3]));
  await cache.delete("clip");
  expect(await cache.has("clip")).toBe(false);
});

test("a record schema refuses an owner field and an unknown entity kind", () => {
  const meta = {
    docId: "doc-1",
    title: "A document",
    sourceKind: "txt",
    folderId: null,
    addedAt: 1000,
    wordCount: 3,
    sentenceCount: 1,
    updatedAt: 1000,
    deleted: false,
  };
  expect(DocumentMetaSchema.safeParse(meta).success).toBe(true);
  expect(DocumentMetaSchema.safeParse({ ...meta, ownerId: "user-1" }).success).toBe(false);
  expect(DocumentMetaSchema.safeParse({ ...meta, sourceKind: "papyrus" }).success).toBe(false);

  const op = { opId: "op-1", deviceId: "dev-a", entity: "document", entityId: "doc-1", kind: "put", ts: 1, record: meta };
  expect(OpSchema.safeParse(op).success).toBe(true);
  expect(OpSchema.safeParse({ ...op, entity: "user" }).success).toBe(false);
  expect(OpSchema.safeParse({ ...op, kind: "merge" }).success).toBe(false);
});
