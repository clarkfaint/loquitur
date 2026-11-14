/**
 * The IndexedDB `LibraryStore` (F§5.9): the records a reader owns, the outbox that carries every mutation
 * to the hub, and one version stamp per entity so the last-writer-wins rule has something to compare.
 *
 * Four decisions the interface leaves open, each chosen so a browser tab can be closed at any moment:
 *
 * - the store owns the clock. A mutation stamps `updatedAt` from `now()` and gives its op the same `ts`,
 *   so a record and the op that carries it agree on every device that applies them;
 * - a mutation and its outbox entry commit in **one** transaction. A record without its op would be a
 *   change no other device ever hears about, and an op without its record would be one they cannot apply;
 * - the outbox is a queue of envelopes only. `applyRemote` writes records and the stamp, and never queues
 *   what it applied — a change that arrived from the network is not a change to send back;
 * - a version stamp lives in the `meta` store under `version:<entity>:<id>`. `meta` is part of the schema
 *   this package already declares, so LWW needs no store the layout does not already have, and the stamp
 *   survives a reload beside the record it describes;
 * - the model is stored beside its metadata but never inside an op. Ops carry records; a document's text
 *   travels as its own payload, so a device that applies a remote `document` op holds the metadata and
 *   waits for the file (F§8.2) — which is why applying one leaves any model already on hand alone.
 */

import {
  type Bookmark,
  BookmarkSchema,
  type DocumentMeta,
  DocumentMetaSchema,
  type EntityKind,
  type Folder,
  FolderSchema,
  isNewer,
  type LibraryStore,
  type Op,
  OpSchema,
  ProgressSchema,
  SettingRecordSchema,
  type Version,
} from "@lectern/core";
import type { IDBPDatabase } from "idb";
import type { LecternDbSchema, MetaValue } from "./idb-schema";

/** What an IndexedDB library store needs from its host: a connection, an identity, a clock and op ids. */
export interface IdbLibraryStoreOptions {
  db: IDBPDatabase<LecternDbSchema>;
  deviceId: string;
  now: () => number;
  newId: () => string;
}

/** The `meta` key the sync cursor is kept under. */
const CURSOR_KEY = "cursor";

/** The `meta` key one entity's last-writer-wins stamp is kept under (F§5.9). */
function versionKey(entity: EntityKind, entityId: string): string {
  return `version:${entity}:${entityId}`;
}

/** Narrow a `meta` value to a version stamp, so a value of another shape is never compared as one. */
function isVersion(value: MetaValue | undefined): value is Version {
  return typeof value === "object" && value !== null && "ts" in value && "deviceId" in value;
}

/**
 * Copy a document's metadata with a fresh stamp, listing its fields one by one: an optional `sourceUri`
 * present as an explicit `undefined` is refused by the schema, so the key is added only when it holds a
 * value.
 */
function stampMeta(meta: DocumentMeta, updatedAt: number): DocumentMeta {
  const stamped: DocumentMeta = {
    docId: meta.docId,
    title: meta.title,
    sourceKind: meta.sourceKind,
    folderId: meta.folderId,
    addedAt: meta.addedAt,
    wordCount: meta.wordCount,
    sentenceCount: meta.sentenceCount,
    updatedAt,
    deleted: meta.deleted,
  };
  return meta.sourceUri === undefined ? stamped : { ...stamped, sourceUri: meta.sourceUri };
}

/**
 * The document record a document op writes: its own record, or for a delete op its tombstone. A delete op
 * that carries no parsable record still tombstones the record on hand, so a delete cannot be lost.
 */
async function documentMetaFor(db: IDBPDatabase<LecternDbSchema>, op: Op): Promise<DocumentMeta | null> {
  const parsed = DocumentMetaSchema.safeParse(op.record);
  if (parsed.success) return op.kind === "delete" ? { ...parsed.data, deleted: true } : parsed.data;
  if (op.kind !== "delete") return null;
  const existing = await db.get("documents", op.entityId);
  return existing === undefined ? null : { ...existing, updatedAt: op.ts, deleted: true };
}

/** Write one remote op's record into the store it belongs to. The stamp is the caller's business. */
async function applyRemoteRecord(db: IDBPDatabase<LecternDbSchema>, op: Op): Promise<void> {
  switch (op.entity) {
    case "document": {
      const meta = await documentMetaFor(db, op);
      if (meta === null) return;
      const tx = db.transaction(["documents", "models"], "readwrite");
      await tx.objectStore("documents").put(meta);
      if (meta.deleted) await tx.objectStore("models").delete(meta.docId);
      await tx.done;
      return;
    }
    case "folder": {
      const parsed = FolderSchema.safeParse(op.record);
      if (parsed.success) {
        await db.put("folders", op.kind === "delete" ? { ...parsed.data, deleted: true } : parsed.data);
        return;
      }
      if (op.kind !== "delete") return;
      const existing = await db.get("folders", op.entityId);
      if (existing !== undefined) await db.put("folders", { ...existing, updatedAt: op.ts, deleted: true });
      return;
    }
    case "bookmark": {
      const parsed = BookmarkSchema.safeParse(op.record);
      if (parsed.success) {
        await db.put("bookmarks", op.kind === "delete" ? { ...parsed.data, deleted: true } : parsed.data);
        return;
      }
      if (op.kind !== "delete") return;
      const existing = await db.get("bookmarks", op.entityId);
      if (existing !== undefined) await db.put("bookmarks", { ...existing, updatedAt: op.ts, deleted: true });
      return;
    }
    case "progress": {
      if (op.kind === "delete") {
        await db.delete("progress", op.entityId);
        return;
      }
      const parsed = ProgressSchema.safeParse(op.record);
      if (parsed.success) await db.put("progress", parsed.data);
      return;
    }
    case "setting": {
      const parsed = SettingRecordSchema.safeParse(op.record);
      if (parsed.success) {
        await db.put("settings", op.kind === "delete" ? { ...parsed.data, deleted: true } : parsed.data);
        return;
      }
      if (op.kind === "delete") await db.delete("settings", op.entityId);
      return;
    }
  }
}

/**
 * `createIdbLibraryStore({ db, deviceId, now, newId })` — a `LibraryStore` over one IndexedDB connection.
 *
 * The connection is the caller's: it comes from `openLecternDb`, so this module declares no schema and a
 * second store over the same connection shares everything the first one wrote.
 */
export function createIdbLibraryStore(options: IdbLibraryStoreOptions): LibraryStore {
  const { db, deviceId } = options;

  /** The op one mutation appends, stamped by the device that made it. */
  const opFor = (entity: EntityKind, entityId: string, kind: "put" | "delete", ts: number, record: unknown): Op => ({
    opId: options.newId(),
    deviceId,
    entity,
    entityId,
    kind,
    ts,
    record,
  });

  /** The stamp a mutation establishing `ts` leaves for its entity. */
  const stampOf = (ts: number): Version => ({ ts, deviceId });

  return {
    async putDocument(meta, model) {
      const updatedAt = options.now();
      const stored = DocumentMetaSchema.parse(stampMeta(meta, updatedAt));
      const tx = db.transaction(["documents", "models", "outbox", "meta"], "readwrite");
      await tx.objectStore("documents").put(stored);
      const models = tx.objectStore("models");
      if (stored.deleted) await models.delete(stored.docId);
      else await models.put(model);
      await tx.objectStore("outbox").add(opFor("document", stored.docId, "put", updatedAt, stored));
      await tx.objectStore("meta").put(stampOf(updatedAt), versionKey("document", stored.docId));
      await tx.done;
    },

    async getDocumentMeta(docId) {
      const stored = await db.get("documents", docId);
      if (stored === undefined || stored.deleted) return null;
      return stored;
    },

    async getDocumentModel(docId) {
      const stored = await db.get("documents", docId);
      if (stored === undefined || stored.deleted) return null;
      return (await db.get("models", docId)) ?? null;
    },

    async listDocuments(q) {
      const listed: DocumentMeta[] = [];
      for (const meta of await db.getAll("documents")) {
        if (meta.deleted) continue;
        if (q?.folderId !== undefined && meta.folderId !== q.folderId) continue;
        if (q?.text !== undefined && !meta.title.toLowerCase().includes(q.text.toLowerCase())) continue;
        listed.push(meta);
      }
      return listed;
    },

    async deleteDocument(docId) {
      const tx = db.transaction(["documents", "models", "outbox", "meta"], "readwrite");
      const documents = tx.objectStore("documents");
      const existing = await documents.get(docId);
      if (existing === undefined || existing.deleted) {
        await tx.done;
        return;
      }
      const updatedAt = options.now();
      const stored = DocumentMetaSchema.parse({ ...existing, updatedAt, deleted: true });
      await documents.put(stored);
      await tx.objectStore("models").delete(docId);
      await tx.objectStore("outbox").add(opFor("document", docId, "delete", updatedAt, stored));
      await tx.objectStore("meta").put(stampOf(updatedAt), versionKey("document", docId));
      await tx.done;
    },

    async putFolder(folder) {
      const updatedAt = options.now();
      const stored = FolderSchema.parse({ ...folder, updatedAt });
      const tx = db.transaction(["folders", "outbox", "meta"], "readwrite");
      await tx.objectStore("folders").put(stored);
      await tx.objectStore("outbox").add(opFor("folder", stored.id, "put", updatedAt, stored));
      await tx.objectStore("meta").put(stampOf(updatedAt), versionKey("folder", stored.id));
      await tx.done;
    },

    async listFolders() {
      const listed: Folder[] = [];
      for (const folder of await db.getAll("folders")) {
        if (folder.deleted) continue;
        listed.push(folder);
      }
      return listed;
    },

    async deleteFolder(id) {
      const tx = db.transaction(["folders", "outbox", "meta"], "readwrite");
      const folders = tx.objectStore("folders");
      const existing = await folders.get(id);
      if (existing === undefined || existing.deleted) {
        await tx.done;
        return;
      }
      const updatedAt = options.now();
      const stored = FolderSchema.parse({ ...existing, updatedAt, deleted: true });
      await folders.put(stored);
      await tx.objectStore("outbox").add(opFor("folder", id, "delete", updatedAt, stored));
      await tx.objectStore("meta").put(stampOf(updatedAt), versionKey("folder", id));
      await tx.done;
    },

    async putBookmark(bookmark) {
      const updatedAt = options.now();
      const stored = BookmarkSchema.parse({ ...bookmark, updatedAt });
      const tx = db.transaction(["bookmarks", "outbox", "meta"], "readwrite");
      await tx.objectStore("bookmarks").put(stored);
      await tx.objectStore("outbox").add(opFor("bookmark", stored.id, "put", updatedAt, stored));
      await tx.objectStore("meta").put(stampOf(updatedAt), versionKey("bookmark", stored.id));
      await tx.done;
    },

    async listBookmarks(docId) {
      const listed: Bookmark[] = [];
      for (const bookmark of await db.getAll("bookmarks")) {
        if (bookmark.deleted || bookmark.docId !== docId) continue;
        listed.push(bookmark);
      }
      return listed;
    },

    async deleteBookmark(id) {
      const tx = db.transaction(["bookmarks", "outbox", "meta"], "readwrite");
      const bookmarks = tx.objectStore("bookmarks");
      const existing = await bookmarks.get(id);
      if (existing === undefined || existing.deleted) {
        await tx.done;
        return;
      }
      const updatedAt = options.now();
      const stored = BookmarkSchema.parse({ ...existing, updatedAt, deleted: true });
      await bookmarks.put(stored);
      await tx.objectStore("outbox").add(opFor("bookmark", id, "delete", updatedAt, stored));
      await tx.objectStore("meta").put(stampOf(updatedAt), versionKey("bookmark", id));
      await tx.done;
    },

    async setProgress(p) {
      const updatedAt = options.now();
      const stored = ProgressSchema.parse({ ...p, updatedAt });
      const tx = db.transaction(["progress", "outbox", "meta"], "readwrite");
      await tx.objectStore("progress").put(stored);
      await tx.objectStore("outbox").add(opFor("progress", stored.docId, "put", updatedAt, stored));
      await tx.objectStore("meta").put(stampOf(updatedAt), versionKey("progress", stored.docId));
      await tx.done;
    },

    async getProgress(docId) {
      return (await db.get("progress", docId)) ?? null;
    },

    async setSetting(key, value) {
      const updatedAt = options.now();
      const stored = SettingRecordSchema.parse({ key, value, updatedAt, deleted: false });
      const tx = db.transaction(["settings", "outbox", "meta"], "readwrite");
      await tx.objectStore("settings").put(stored);
      await tx.objectStore("outbox").add(opFor("setting", key, "put", updatedAt, stored));
      await tx.objectStore("meta").put(stampOf(updatedAt), versionKey("setting", key));
      await tx.done;
    },

    async getSetting<T>(key: string) {
      const stored = await db.get("settings", key);
      if (stored === undefined || stored.deleted) return null;
      return stored.value as T;
    },

    async pendingOps(limit) {
      const bound = Math.max(0, limit);
      const ops: Op[] = [];
      if (bound === 0) return ops;
      const tx = db.transaction("outbox");
      let cursor = await tx.store.openCursor();
      while (cursor !== null && ops.length < bound) {
        ops.push(cursor.value);
        cursor = await cursor.continue();
      }
      await tx.done;
      return ops;
    },

    async ackOps(opIds) {
      if (opIds.length === 0) return;
      const target = new Set(opIds);
      const tx = db.transaction("outbox", "readwrite");
      const index = tx.store.index("opId");
      for (const opId of target) {
        let cursor = await index.openCursor(opId);
        while (cursor !== null) {
          await cursor.delete();
          cursor = await cursor.continue();
        }
      }
      await tx.done;
    },

    async applyRemote(ops) {
      for (const incoming of ops) {
        const op = OpSchema.parse(incoming);
        const key = versionKey(op.entity, op.entityId);
        const current = await db.get("meta", key);
        if (isVersion(current) && !isNewer(op, current)) continue;
        await applyRemoteRecord(db, op);
        await db.put("meta", { ts: op.ts, deviceId: op.deviceId }, key);
      }
    },

    async getCursor() {
      const stored = await db.get("meta", CURSOR_KEY);
      return typeof stored === "number" ? stored : 0;
    },

    async setCursor(rev) {
      await db.put("meta", rev, CURSOR_KEY);
    },
  };
}
