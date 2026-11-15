/**
 * The SQL stores, measured against the suites every platform's store must pass (F§5.9).
 *
 * The driver is a real SQLite database — `better-sqlite3` on `:memory:`, through the double this package
 * ships — so these cases drive SQL that a device will run: statements, bindings, an auto-incrementing
 * outbox key, `instr` over the folded title, and transactions. The suite's own cases are included rather
 * than restated, because the suites are what F§5.9 says every implementation must pass.
 *
 * Three things the suites cannot say are measured here as well: that `migrate` is idempotent, that a
 * mutation whose outbox write fails leaves nothing behind, and that a store created *again* on the same
 * database sees everything the first one wrote.
 */

import { buildDocument, type DocumentMeta } from "@lectern/core";
import {
  type BlobCacheFactory,
  type LibraryStoreFactory,
  runBlobCacheConformance,
  runLibraryStoreConformance,
} from "@lectern/core/testing";
import { describe, expect, it } from "vitest";
import type { SqlDriver, SqlParam } from "../driver";
import { createFsBlobCache } from "../fs-blob-cache";
import { migrate, SCHEMA_VERSION } from "../migrations";
import { createSqlLibraryStore } from "../sql-library-store";
import { createBetterSqlite3Driver } from "../testing/better-sqlite3-driver";
import { createMemoryBlobFs } from "../testing/memory-blob-fs";

/** F§5.9's suites hold nine library cases and three cache cases; a change to either count is visible here. */
const LIBRARY_CASES = 9;
const BLOB_CASES = 3;

/** Every table version 1 declares, as the schema itself lists them. */
const TABLES = ["documents", "models", "folders", "bookmarks", "progress", "settings", "outbox", "meta", "blob_meta"];

/** A clock the tests set by hand, so a record's stamp is a number a case can name. */
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
    return `sql-op-${issued}`;
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

describe("SqlLibraryStore", () => {
  it("passes every LibraryStore conformance case", async () => {
    const factory: LibraryStoreFactory = async (options) => {
      const driver = await createBetterSqlite3Driver();
      await migrate(driver);
      return createSqlLibraryStore({ driver, ...options });
    };

    const results = await runLibraryStoreConformance(factory);

    expect(failures(results)).toEqual([]);
    expect(results).toHaveLength(LIBRARY_CASES);
  });

  it("runs its migrations twice without error and leaves the schema at version 1", async () => {
    const driver = await createBetterSqlite3Driver();

    await migrate(driver);
    await migrate(driver);

    const versions = await driver.all<{ version: number }>("SELECT version FROM schema_version");
    expect(versions).toEqual([{ version: SCHEMA_VERSION }]);
    const named = await driver.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
    for (const table of TABLES) expect(named.map((row) => row.name)).toContain(table);

    await migrate(driver);
    expect(await driver.all<{ version: number }>("SELECT version FROM schema_version")).toEqual([{ version: SCHEMA_VERSION }]);
  });

  it("keeps a library when the store is created again on the same database", async () => {
    const driver = await createBetterSqlite3Driver();
    await migrate(driver);
    const clock = makeClock();
    const ids = makeIdSource();
    const { meta, model } = makeDocument(1, "Persisted");

    const first = createSqlLibraryStore({ driver, deviceId: "device-persist", now: clock.now, newId: ids });
    await first.putDocument(meta, model);
    await first.putFolder({ id: "folder-persist", name: "Kept", parentId: null, updatedAt: 0, deleted: false });
    await first.setProgress({ docId: meta.docId, sentenceIndex: 2, wordIndex: 3, updatedAt: 0 });

    const second = createSqlLibraryStore({ driver, deviceId: "device-persist", now: clock.now, newId: ids });

    expect((await second.getDocumentMeta(meta.docId))?.title).toBe("Persisted");
    expect((await second.getDocumentModel(meta.docId))?.blocks.length).toBe(model.blocks.length);
    expect((await second.listFolders()).map((folder) => folder.name)).toEqual(["Kept"]);
    expect(await second.getProgress(meta.docId)).toEqual({
      docId: meta.docId,
      sentenceIndex: 2,
      wordIndex: 3,
      updatedAt: 1000,
    });
    expect((await second.pendingOps(10)).map((op) => `${op.kind}:${op.entity}`)).toEqual(["put:document", "put:folder", "put:progress"]);
  });

  it("leaves nothing behind when a mutation's outbox write fails", async () => {
    const driver = await createBetterSqlite3Driver();
    await migrate(driver);
    const ids = makeIdSource();
    const failing: SqlDriver = {
      exec: (sql: string) => driver.exec(sql),
      run: (sql: string, params: readonly SqlParam[] = []) =>
        sql.includes("INTO outbox") ? Promise.reject(new Error("the outbox is unavailable")) : driver.run(sql, params),
      all: <T>(sql: string, params: readonly SqlParam[] = []) => driver.all<T>(sql, params),
      transaction: <T>(fn: () => Promise<T>) => driver.transaction(fn),
    };
    const store = createSqlLibraryStore({ driver: failing, deviceId: "device-rollback", now: () => 1000, newId: ids });
    const { meta, model } = makeDocument(12, "Rollback");

    await expect(store.putDocument(meta, model)).rejects.toThrow("the outbox is unavailable");

    expect(await store.getDocumentMeta(meta.docId)).toBeNull();
    expect((await driver.all<{ docId: string }>("SELECT docId FROM models")).length).toBe(0);
    expect((await driver.all<{ opId: string }>("SELECT opId FROM outbox")).length).toBe(0);
  });
});

describe("FsBlobCache", () => {
  it("passes every BlobCache conformance case", async () => {
    let ticks = 0;
    const now = (): number => {
      ticks += 1;
      return ticks;
    };
    const factory: BlobCacheFactory = async () => {
      const driver = await createBetterSqlite3Driver();
      await migrate(driver);
      return createFsBlobCache({ fs: createMemoryBlobFs(), driver, now });
    };

    const results = await runBlobCacheConformance(factory);

    expect(failures(results)).toEqual([]);
    expect(results).toHaveLength(BLOB_CASES);
  });

  it("keeps the bytes in a file and the size, type and last use in the table", async () => {
    const driver = await createBetterSqlite3Driver();
    await migrate(driver);
    const fs = createMemoryBlobFs();
    const clock = makeClock(4_000);
    const cache = createFsBlobCache({ fs, driver, now: clock.now });
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);

    const location = await cache.put("orig/doc-1", bytes, "application/pdf");

    expect(await fs.exists("orig/doc-1")).toBe(true);
    expect(location).toBe(await fs.uri("orig/doc-1"));
    expect(await driver.all<{ size: number; mime: string; lastUsed: number }>("SELECT size, mime, lastUsed FROM blob_meta")).toEqual([
      { size: 5, mime: "application/pdf", lastUsed: 4_000 },
    ]);
    expect(await cache.sizeBytes()).toBe(5);

    clock.set(5_000);
    expect(Array.from((await cache.get("orig/doc-1")) ?? [])).toEqual([1, 2, 3, 4, 5]);
    expect(await driver.all<{ lastUsed: number }>("SELECT lastUsed FROM blob_meta WHERE key = ?", ["orig/doc-1"])).toEqual([
      { lastUsed: 5_000 },
    ]);

    await cache.delete("orig/doc-1");
    expect(await fs.exists("orig/doc-1")).toBe(false);
    expect(await driver.all<{ key: string }>("SELECT key FROM blob_meta")).toEqual([]);
    expect(await cache.sizeBytes()).toBe(0);
  });

  it("removes an evicted blob's file with its row", async () => {
    const driver = await createBetterSqlite3Driver();
    await migrate(driver);
    const fs = createMemoryBlobFs();
    let ticks = 0;
    const cache = createFsBlobCache({
      fs,
      driver,
      now: () => {
        ticks += 1;
        return ticks;
      },
    });
    await cache.put("keep", new Uint8Array(10), "audio/mpeg");
    await cache.put("drop", new Uint8Array(500), "audio/mpeg");

    expect(await cache.evictLru(10, (key) => key === "keep")).toBe(500);

    expect(await fs.exists("drop")).toBe(false);
    expect(await fs.exists("keep")).toBe(true);
    expect(await cache.sizeBytes()).toBe(10);
  });
});
