/**
 * The IndexedDB `BlobCache` (F§5.9): the bytes a reader plays, held in the browser's own database so a
 * synthesized chunk survives a reload, and handed back as an object URL a media element can play.
 *
 * Three decisions worth naming:
 *
 * - **recency is a timestamp, not a read counter.** `lastUsed` comes from the injected `now()`, so
 *   eviction order is a property of the store's clock rather than of how many calls a tab happened to
 *   make, and a test can say exactly which entry is coldest;
 * - **`blobMeta` carries the declared type beside the size.** F§5.9 asks it to track size and last access;
 *   a row also records the MIME type, because `uri` has to hand back a *playable* URL and a URL built from
 *   bytes without their type plays the wrong container after a reload;
 * - **one object URL per key, and it is released on `delete` and on eviction.** The URL is created once
 *   when the key is written and remembered, so a reader asking for it twice is not handed two live URLs
 *   for one chunk, and nothing keeps its bytes alive after the cache drops it.
 */

import type { BlobCache } from "@lectern/core";
import type { IDBPDatabase } from "idb";
import type { BlobMetaRecord, LecternDbSchema } from "./idb-schema";

/** The type a URL is built with when a row has none, so `uri` never invents a container. */
const FALLBACK_MIME = "application/octet-stream";

/** What an IndexedDB blob cache needs from its host: a connection and a clock. */
export interface IdbBlobCacheOptions {
  db: IDBPDatabase<LecternDbSchema>;
  now: () => number;
}

/** One row of `blobMeta` together with the key it is stored under. */
interface MetaRow {
  key: string;
  meta: BlobMetaRecord;
}

/**
 * `createIdbBlobCache({ db, now })` — a `BlobCache` over one IndexedDB connection, holding only the
 * object URLs it has handed out. Everything else is in the database, so two caches over the same
 * connection share the bytes.
 */
export function createIdbBlobCache(options: IdbBlobCacheOptions): BlobCache {
  const { db } = options;
  const objectUrls = new Map<string, string>();

  /** Release a key's object URL. Revoking twice is harmless; forgetting it is not, so the map is cleared. */
  const releaseUrl = (key: string): void => {
    const url = objectUrls.get(key);
    if (url === undefined) return;
    URL.revokeObjectURL(url);
    objectUrls.delete(key);
  };

  /** Remember a key's URL, replacing — and releasing — whatever URL it had before. */
  const publish = (key: string, bytes: Uint8Array, mime: string): string => {
    releaseUrl(key);
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
    objectUrls.set(key, url);
    return url;
  };

  /** Mark a key as used, which is the order `evictLru` removes in. */
  const touch = async (key: string): Promise<void> => {
    const tx = db.transaction("blobMeta", "readwrite");
    const stored = await tx.store.get(key);
    if (stored === undefined) {
      await tx.done;
      return;
    }
    await tx.store.put({ ...stored, lastUsed: options.now() }, key);
    await tx.done;
  };

  /** Every `blobMeta` row with its key, read in one transaction so the two lists cannot disagree. */
  const listMeta = async (): Promise<MetaRow[]> => {
    const tx = db.transaction("blobMeta");
    const keys = await tx.store.getAllKeys();
    const values = await tx.store.getAll();
    await tx.done;
    const rows: MetaRow[] = [];
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const meta = values[index];
      if (key === undefined || meta === undefined) continue;
      rows.push({ key, meta });
    }
    return rows;
  };

  return {
    async has(key) {
      return (await db.getKey("blobs", key)) !== undefined;
    },

    async put(key, bytes, mime) {
      const copy = new Uint8Array(bytes);
      const tx = db.transaction(["blobs", "blobMeta"], "readwrite");
      await tx.objectStore("blobs").put(copy, key);
      await tx.objectStore("blobMeta").put({ size: copy.length, lastUsed: options.now(), mime }, key);
      await tx.done;
      return publish(key, copy, mime);
    },

    async get(key) {
      const stored = await db.get("blobs", key);
      if (stored === undefined) return null;
      await touch(key);
      return stored;
    },

    async uri(key) {
      const known = objectUrls.get(key);
      if (known !== undefined) return known;
      const stored = await db.get("blobs", key);
      if (stored === undefined) return null;
      const meta = await db.get("blobMeta", key);
      await touch(key);
      return publish(key, stored, meta?.mime ?? FALLBACK_MIME);
    },

    async delete(key) {
      releaseUrl(key);
      const tx = db.transaction(["blobs", "blobMeta"], "readwrite");
      await tx.objectStore("blobs").delete(key);
      await tx.objectStore("blobMeta").delete(key);
      await tx.done;
    },

    async sizeBytes() {
      let total = 0;
      for (const { meta } of await listMeta()) total += meta.size;
      return total;
    },

    async evictLru(maxBytes, pinned) {
      const rows = await listMeta();
      let total = 0;
      for (const { meta } of rows) total += meta.size;
      const doomed = rows.filter(({ key }) => !pinned(key)).sort((left, right) => left.meta.lastUsed - right.meta.lastUsed);
      const removing: string[] = [];
      let freed = 0;
      for (const { key, meta } of doomed) {
        if (total <= maxBytes) break;
        removing.push(key);
        total -= meta.size;
        freed += meta.size;
      }
      if (removing.length === 0) return freed;
      const tx = db.transaction(["blobs", "blobMeta"], "readwrite");
      for (const key of removing) {
        await tx.objectStore("blobs").delete(key);
        await tx.objectStore("blobMeta").delete(key);
        releaseUrl(key);
      }
      await tx.done;
      return freed;
    },
  };
}
