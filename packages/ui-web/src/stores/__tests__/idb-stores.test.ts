/**
 * The IndexedDB stores, measured against the suites every platform's store must pass (F§5.9).
 *
 * `fake-indexeddb/auto` installs a real IndexedDB implementation over the window's, so these cases drive
 * the same code a browser drives: transactions, cursors, an upgrade step and all. Each conformance case
 * gets a database of its own, because a suite case expects to start from a store that holds nothing —
 * sharing one database between them would let a document from an earlier case appear in a later case's
 * unfiltered list.
 */

import "fake-indexeddb/auto";
import { buildDocument, type DocumentMeta } from "@lectern/core";
import {
  type BlobCacheFactory,
  type LibraryStoreFactory,
  runBlobCacheConformance,
  runLibraryStoreConformance,
} from "@lectern/core/testing";
import { describe, expect, it, vi } from "vitest";
import { getDeviceId } from "../device-id";
import { createIdbBlobCache } from "../idb-blob-cache";
import { createIdbLibraryStore } from "../idb-library-store";
import { openLecternDb } from "../idb-schema";

/** F§5.9's outbox has nine library cases and three cache cases; a change to either count is visible here. */
const LIBRARY_CASES = 9;
const BLOB_CASES = 3;

/** A clock the tests advance by hand, so a record's stamp is a number a case can name. */
function makeClock(start = 1000): { now: () => number; set: (value: number) => void } {
  const state = { value: start };
  return {
    now: () => state.value,
    set: (value: number) => {
      state.value = value;
    },
  };
}

/** Op identifiers from one counter, so two stores exchanging ops never collide. */
function makeIdSource(): () => string {
  let issued = 0;
  return () => {
    issued += 1;
    return `idb-op-${issued}`;
  };
}

/** Render a conformance suite's failures as one readable line each, so a failure names its case. */
function failures(results: { name: string; ok: boolean; error?: string }[]): string[] {
  return results.filter((result) => !result.ok).map((result) => `${result.name}: ${result.error ?? "failed"}`);
}

/** A one-sentence document and the metadata a library lists it by. */
function makeDocument(index: number, title: string): { meta: DocumentMeta; model: ReturnType<typeof buildDocument> } {
  const model = buildDocument([{ kind: "paragraph", text: `${title} is document number ${index}, and it has one sentence.` }], {
    source: { kind: "txt" },
  });
  const meta: DocumentMeta = {
    docId: model.docId,
    title,
    sourceKind: "txt",
    folderId: null,
    addedAt: 1000,
    wordCount: model.wordCount,
    sentenceCount: model.sentenceCount,
    updatedAt: 0,
    deleted: false,
  };
  return { meta, model };
}

describe("IdbLibraryStore", () => {
  it("passes every LibraryStore conformance case", async () => {
    let opened = 0;
    const factory: LibraryStoreFactory = async (options) => {
      opened += 1;
      const db = await openLecternDb(`lectern-conformance-${opened}`);
      return createIdbLibraryStore({ db, ...options });
    };

    const results = await runLibraryStoreConformance(factory);

    expect(failures(results)).toEqual([]);
    expect(results).toHaveLength(LIBRARY_CASES);
  });

  it("keeps a library across closing and reopening the database", async () => {
    const name = "lectern-persistence";
    const clock = makeClock();
    const ids = makeIdSource();
    const { meta, model } = makeDocument(1, "Persisted");

    const first = await openLecternDb(name);
    const store = createIdbLibraryStore({ db: first, deviceId: "device-persist", now: clock.now, newId: ids });
    await store.putDocument(meta, model);
    await store.putFolder({ id: "folder-persist", name: "Kept", parentId: null, updatedAt: 0, deleted: false });
    await store.setProgress({ docId: meta.docId, sentenceIndex: 2, wordIndex: 3, updatedAt: 0 });
    first.close();

    const second = await openLecternDb(name);
    const reopened = createIdbLibraryStore({ db: second, deviceId: "device-persist", now: clock.now, newId: ids });

    const back = await reopened.getDocumentMeta(meta.docId);
    expect(back?.title).toBe("Persisted");
    expect((await reopened.getDocumentModel(meta.docId))?.blocks.length).toBe(model.blocks.length);
    expect((await reopened.listFolders()).map((folder) => folder.name)).toEqual(["Kept"]);
    expect(await reopened.getProgress(meta.docId)).toEqual({ docId: meta.docId, sentenceIndex: 2, wordIndex: 3, updatedAt: 1000 });

    second.close();
  });

  it("starts a reopened outbox where it left off", async () => {
    const name = "lectern-outbox-persistence";
    const clock = makeClock();
    const ids = makeIdSource();
    const first = await openLecternDb(name);
    const store = createIdbLibraryStore({ db: first, deviceId: "device-outbox", now: clock.now, newId: ids });
    const { meta, model } = makeDocument(2, "Queued");
    await store.putDocument(meta, model);
    await store.putFolder({ id: "folder-queued", name: "Queued", parentId: null, updatedAt: 0, deleted: false });
    first.close();

    const second = await openLecternDb(name);
    const reopened = createIdbLibraryStore({ db: second, deviceId: "device-outbox", now: clock.now, newId: ids });
    const queued = await reopened.pendingOps(10);
    expect(queued.map((op) => `${op.kind}:${op.entity}`)).toEqual(["put:document", "put:folder"]);
    await reopened.ackOps([queued[0]?.opId ?? ""]);
    expect((await reopened.pendingOps(10)).map((op) => op.entity)).toEqual(["folder"]);
    second.close();
  });
});

describe("IdbBlobCache", () => {
  it("passes every BlobCache conformance case", async () => {
    let opened = 0;
    const clock = makeClock();
    const factory: BlobCacheFactory = async () => {
      opened += 1;
      const db = await openLecternDb(`lectern-blob-conformance-${opened}`);
      return createIdbBlobCache({ db, now: clock.now });
    };

    const results = await runBlobCacheConformance(factory);

    expect(failures(results)).toEqual([]);
    expect(results).toHaveLength(BLOB_CASES);
  });

  it("hands back one object URL per key and revokes it on delete", async () => {
    const clock = makeClock();
    const db = await openLecternDb("lectern-blob-revoke-delete");
    const cache = createIdbBlobCache({ db, now: clock.now });
    const revoked = vi.spyOn(URL, "revokeObjectURL");

    const written = await cache.put("chunk", new Uint8Array([1, 2, 3, 4]), "audio/wav");
    expect(written.startsWith("blob:")).toBe(true);
    expect(await cache.uri("chunk")).toBe(written);
    expect(revoked).not.toHaveBeenCalled();

    await cache.delete("chunk");
    expect(revoked).toHaveBeenCalledWith(written);
    expect(await cache.uri("chunk")).toBeNull();
    expect(await cache.has("chunk")).toBe(false);

    revoked.mockRestore();
    db.close();
  });

  it("revokes the object URL of every evicted key and keeps a pinned one", async () => {
    const clock = makeClock();
    const db = await openLecternDb("lectern-blob-revoke-evict");
    const cache = createIdbBlobCache({ db, now: clock.now });
    const cold = await cache.put("cold", new Uint8Array(300), "audio/mpeg");
    const warm = await cache.put("warm", new Uint8Array(100), "audio/mpeg");
    expect(await cache.sizeBytes()).toBe(400);

    const revoked = vi.spyOn(URL, "revokeObjectURL");
    const freed = await cache.evictLru(100, () => false);

    expect(freed).toBe(300);
    expect(revoked).toHaveBeenCalledWith(cold);
    expect(revoked).not.toHaveBeenCalledWith(warm);
    expect(await cache.sizeBytes()).toBe(100);
    expect(await cache.uri("warm")).toBe(warm);
    expect(await cache.uri("cold")).toBeNull();

    revoked.mockRestore();
    db.close();
  });

  it("keeps cached bytes across closing and reopening the database", async () => {
    const clock = makeClock();
    const first = await openLecternDb("lectern-blob-persistence");
    const cache = createIdbBlobCache({ db: first, now: clock.now });
    await cache.put("kept", new Uint8Array([7, 7, 7]), "audio/mpeg");
    first.close();

    const second = await openLecternDb("lectern-blob-persistence");
    const reopened = createIdbBlobCache({ db: second, now: clock.now });

    expect(await reopened.has("kept")).toBe(true);
    expect(Array.from((await reopened.get("kept")) ?? [])).toEqual([7, 7, 7]);
    expect(await reopened.sizeBytes()).toBe(3);
    expect((await reopened.uri("kept"))?.startsWith("blob:")).toBe(true);

    second.close();
  });
});

describe("getDeviceId", () => {
  it("creates one identifier and answers it again", async () => {
    const db = await openLecternDb("lectern-device-id");
    const first = await getDeviceId(db);
    expect(first.length).toBeGreaterThan(0);
    expect(await getDeviceId(db)).toBe(first);
    db.close();

    const reopened = await openLecternDb("lectern-device-id");
    expect(await getDeviceId(reopened)).toBe(first);
    reopened.close();
  });

  it("creates one identifier when two calls race", async () => {
    const db = await openLecternDb("lectern-device-id-race");
    const [left, right] = await Promise.all([getDeviceId(db), getDeviceId(db)]);
    expect(left).toBe(right);
    expect(await getDeviceId(db)).toBe(left);
    db.close();
  });
});
