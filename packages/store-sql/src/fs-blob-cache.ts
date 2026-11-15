/**
 * The file-backed `BlobCache` (F§5.9): the bytes a reader plays, kept in files, with their metadata in the
 * database.
 *
 * The split is the point. A blob never goes into SQLite — a synthesized chunk is hundreds of kilobytes and a
 * document's original bytes can be tens of megabytes, and neither belongs in a row that every query has to
 * carry. So `blob_meta` holds the four things a decision needs (`size`, `mime`, `lastUsed` and the key) and
 * the file holds the bytes; `evictLru` deletes the row and the file together, so the two cannot drift.
 *
 * Three further decisions:
 *
 * - **recency comes from the injected `now()`.** Eviction order is a property of the store's clock rather
 *   than of how many calls a screen happened to make, so a test can say exactly which entry is coldest;
 * - **the MIME type is kept beside the size.** F§5.9 asks the metadata to track size and last access; `uri`
 *   has to hand back a *playable* location, so the type is recorded when the bytes are written — a cache
 *   that rediscovered it later would have to guess;
 * - **a key is present when its row and its file agree.** `has`, `get` and `uri` all check both, so a file
 *   deleted under the cache's feet reads as absent rather than as an error.
 */

import type { BlobCache } from "@lectern/core";
import type { BlobFs, SqlDriver } from "./driver";

/** What a file blob cache needs from its host: a place for bytes, a database, and a clock. */
export interface FsBlobCacheOptions {
  fs: BlobFs;
  driver: SqlDriver;
  now: () => number;
}

/** One `blob_meta` row: the metadata a blob's file does not carry. */
interface BlobMetaRow {
  key: string;
  size: number;
  mime: string;
  lastUsed: number;
}

/**
 * `createFsBlobCache({ fs, driver, now })` — a `BlobCache` whose bytes are files and whose bookkeeping is a
 * table. The cache owns no state of its own, so two caches over the same file system and database share
 * everything either of them wrote.
 */
export function createFsBlobCache(options: FsBlobCacheOptions): BlobCache {
  const { fs, driver } = options;

  /** One key's metadata row, or `null` when the database has never seen the key. */
  const metaFor = async (key: string): Promise<BlobMetaRow | null> => {
    const rows = await driver.all<BlobMetaRow>("SELECT key, size, mime, lastUsed FROM blob_meta WHERE key = ?", [key]);
    return rows[0] ?? null;
  };

  /** Every row with its key, so one read can answer what the cache holds and what it is worth. */
  const listMeta = async (): Promise<BlobMetaRow[]> => driver.all<BlobMetaRow>("SELECT key, size, mime, lastUsed FROM blob_meta");

  /** Forget a key: its file first, then its row. Called for a delete and for an eviction alike. */
  const forget = async (key: string): Promise<void> => {
    await fs.remove(key);
    await driver.run("DELETE FROM blob_meta WHERE key = ?", [key]);
  };

  /** Mark a key as used, which is the order `evictLru` removes in. */
  const touch = async (key: string): Promise<void> => {
    await driver.run("UPDATE blob_meta SET lastUsed = ? WHERE key = ?", [options.now(), key]);
  };

  return {
    async has(key) {
      const meta = await metaFor(key);
      if (meta === null) return false;
      return fs.exists(key);
    },

    async put(key, bytes, mime) {
      const copy = new Uint8Array(bytes);
      await fs.write(key, copy);
      await driver.run("INSERT OR REPLACE INTO blob_meta (key, size, mime, lastUsed) VALUES (?, ?, ?, ?)", [
        key,
        copy.length,
        mime,
        options.now(),
      ]);
      const uri = await fs.uri(key);
      if (uri === null) throw new Error(`the blob file for ${key} is not there after writing it`);
      return uri;
    },

    async get(key) {
      const meta = await metaFor(key);
      if (meta === null) return null;
      const bytes = await fs.read(key);
      if (bytes === null) return null;
      await touch(key);
      return bytes;
    },

    async uri(key) {
      const meta = await metaFor(key);
      if (meta === null) return null;
      const uri = await fs.uri(key);
      if (uri === null) return null;
      await touch(key);
      return uri;
    },

    async delete(key) {
      await forget(key);
    },

    async sizeBytes() {
      let total = 0;
      for (const meta of await listMeta()) total += meta.size;
      return total;
    },

    async evictLru(maxBytes, pinned) {
      const rows = await listMeta();
      let total = 0;
      for (const meta of rows) total += meta.size;
      const coldest = rows.filter((row) => !pinned(row.key)).sort((left, right) => left.lastUsed - right.lastUsed);
      const removing: string[] = [];
      let freed = 0;
      for (const row of coldest) {
        if (total <= maxBytes) break;
        removing.push(row.key);
        total -= row.size;
        freed += row.size;
      }
      for (const key of removing) await forget(key);
      return freed;
    },
  };
}
