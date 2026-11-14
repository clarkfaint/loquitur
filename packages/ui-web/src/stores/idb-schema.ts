/**
 * The IndexedDB schema a reader's library lives in (F§5.9): one database named `lectern` and ten object
 * stores — the five record kinds, the document models, the sync outbox, the key/value `meta` store the
 * bookkeeping lives in, and the two stores a `BlobCache` needs for bytes and for their metadata.
 *
 * The schema is written in exactly one place. `openLecternDb` is the only declaration of a version, so a
 * later change to the layout has a single upgrade step to add (version 2) and every store module keeps
 * working against the connection it is handed. Nothing here opens a store of its own.
 *
 * Three stores deliberately carry no key path of their own. `outbox` is keyed by an auto-incrementing
 * number, which is what makes insertion order the outbox's order and lets `pendingOps` answer "the oldest
 * n" with a plain cursor; its `opId` index is what `ackOps` removes by. `meta` and the two blob stores are
 * keyed from the outside, because their values are a string, a number, a small record or raw bytes — none
 * of which can hold a key of its own.
 */

import type { Bookmark, DocumentMeta, DocumentModel, Folder, Op, Progress, SettingRecord, Version } from "@lectern/core";
import { type DBSchema, type IDBPDatabase, openDB } from "idb";

/** What one `blobMeta` row holds: the size eviction measures, the counter a read bumps, and the type. */
export interface BlobMetaRecord {
  size: number;
  lastUsed: number;
  mime: string;
}

/** What the `meta` store holds: the sync cursor, the device identity, and one stamp per entity (F§5.9). */
export type MetaValue = string | number | Version;

/**
 * Every store in the database, described to `idb` so a key and a value have a type at each call site.
 * The keys are the schema's own: a document by `docId`, a folder and a bookmark by `id`, progress and
 * settings by the identifier they are looked up with.
 */
export interface LecternDbSchema extends DBSchema {
  documents: { key: string; value: DocumentMeta };
  models: { key: string; value: DocumentModel };
  folders: { key: string; value: Folder };
  bookmarks: { key: string; value: Bookmark };
  progress: { key: string; value: Progress };
  settings: { key: string; value: SettingRecord };
  outbox: { key: number; value: Op; indexes: { opId: string } };
  meta: { key: string; value: MetaValue };
  blobs: { key: string; value: Uint8Array };
  blobMeta: { key: string; value: BlobMetaRecord };
}

/** The database name a reader's library uses unless a test asks for another one. */
export const LECTERN_DB_NAME = "lectern";

/** The layout's version. A change to the stores below is a new number plus an upgrade step for it. */
const LECTERN_DB_VERSION = 1;

/**
 * `openLecternDb(name?)` — open the library database, creating it and its ten stores on first use.
 *
 * A second connection to a name already at this version runs no upgrade at all, which is what makes a
 * store opened again after a tab closed see exactly the layout — and the records — it left behind.
 */
export function openLecternDb(name: string = LECTERN_DB_NAME): Promise<IDBPDatabase<LecternDbSchema>> {
  return openDB<LecternDbSchema>(name, LECTERN_DB_VERSION, {
    upgrade(database) {
      database.createObjectStore("documents", { keyPath: "docId" });
      database.createObjectStore("models", { keyPath: "docId" });
      database.createObjectStore("folders", { keyPath: "id" });
      database.createObjectStore("bookmarks", { keyPath: "id" });
      database.createObjectStore("progress", { keyPath: "docId" });
      database.createObjectStore("settings", { keyPath: "key" });
      const outbox = database.createObjectStore("outbox", { autoIncrement: true });
      outbox.createIndex("opId", "opId");
      database.createObjectStore("meta");
      database.createObjectStore("blobs");
      database.createObjectStore("blobMeta");
    },
  });
}
