/**
 * The in-memory `LibraryStore` (F§5.9): the reference implementation every other store is measured
 * against, and the store the tests and the web build fall back to before a platform database exists.
 *
 * Three design points the interface leaves open:
 *
 * - the store owns the clock. Each mutation stamps `updatedAt` with `now()` and gives its op the same
 *   `ts`, so a record's timestamp and the op that carries it agree on every device that applies it, and
 *   nothing here reads the wall clock;
 * - the outbox is a queue of envelopes only. `applyRemote` writes records and the per-entity version, and
 *   never queues what it applied — a change that arrived from the network is not a change to send back;
 * - the model is stored beside its metadata but never inside an op. Ops carry records; a document's text
 *   travels as its own payload, so a device that applies a remote `document` op holds the metadata and
 *   waits for the file (F§8.2).
 */

import type { DocumentModel } from "../model";
import { isNewer, type Version } from "./lww";
import {
  type Bookmark,
  BookmarkSchema,
  type DocumentMeta,
  DocumentMetaSchema,
  type EntityKind,
  type Folder,
  FolderSchema,
  type LibraryStore,
  type Op,
  OpSchema,
  type Progress,
  ProgressSchema,
  type SettingRecord,
  SettingRecordSchema,
} from "./types";

/** What a memory store needs from its host: an identity, a clock, and a source of op identifiers. */
export interface MemoryLibraryStoreOptions {
  deviceId: string;
  now: () => number;
  newId: () => string;
}

/** A document's metadata and, once its file has been read, the model itself. */
interface DocumentEntry {
  meta: DocumentMeta;
  model: DocumentModel | null;
}

/**
 * Copy a document's metadata with a fresh stamp. The fields are listed one by one rather than spread,
 * because an optional `sourceUri` present as an explicit `undefined` is refused by the schema
 * (`exactOptionalPropertyTypes` says the same thing at the type level).
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
 * `createMemoryLibraryStore({ deviceId, now, newId })` — a `LibraryStore` over `Map`s, holding the outbox in
 * arrival order and one `Version` per entity so F§5.9's rule has something to compare against.
 */
export function createMemoryLibraryStore(options: MemoryLibraryStoreOptions): LibraryStore {
  const documents = new Map<string, DocumentEntry>();
  const folders = new Map<string, Folder>();
  const bookmarks = new Map<string, Bookmark>();
  const progress = new Map<string, Progress>();
  const settings = new Map<string, SettingRecord>();
  const versions = new Map<string, Version>();
  let outbox: Op[] = [];
  let cursor = 0;

  const versionKey = (entity: EntityKind, entityId: string): string => `${entity}\u0000${entityId}`;

  /** Queue one mutation and remember the version it established. */
  const append = (entity: EntityKind, entityId: string, kind: "put" | "delete", ts: number, record: unknown): void => {
    outbox.push({ opId: options.newId(), deviceId: options.deviceId, entity, entityId, kind, ts, record });
    versions.set(versionKey(entity, entityId), { ts, deviceId: options.deviceId });
  };

  /** The document a document op writes: its own record, or for a delete op its tombstone. */
  const documentMetaFor = (op: Op): DocumentMeta | null => {
    const parsed = DocumentMetaSchema.safeParse(op.record);
    if (parsed.success) return op.kind === "delete" ? { ...parsed.data, deleted: true } : parsed.data;
    if (op.kind !== "delete") return null;
    const existing = documents.get(op.entityId);
    return existing === undefined ? null : { ...existing.meta, updatedAt: op.ts, deleted: true };
  };

  /** Write one remote record into the maps. A delete op's record is applied as its tombstone. */
  const applyRecord = (op: Op): void => {
    switch (op.entity) {
      case "document": {
        const meta = documentMetaFor(op);
        if (meta === null) return;
        const existing = documents.get(meta.docId);
        documents.set(meta.docId, { meta, model: meta.deleted ? null : (existing?.model ?? null) });
        return;
      }
      case "folder": {
        const parsed = FolderSchema.safeParse(op.record);
        if (parsed.success) {
          folders.set(parsed.data.id, op.kind === "delete" ? { ...parsed.data, deleted: true } : parsed.data);
          return;
        }
        const existing = folders.get(op.entityId);
        if (op.kind === "delete" && existing !== undefined) folders.set(op.entityId, { ...existing, updatedAt: op.ts, deleted: true });
        return;
      }
      case "bookmark": {
        const parsed = BookmarkSchema.safeParse(op.record);
        if (parsed.success) {
          bookmarks.set(parsed.data.id, op.kind === "delete" ? { ...parsed.data, deleted: true } : parsed.data);
          return;
        }
        const existing = bookmarks.get(op.entityId);
        if (op.kind === "delete" && existing !== undefined) {
          bookmarks.set(op.entityId, { ...existing, updatedAt: op.ts, deleted: true });
        }
        return;
      }
      case "progress": {
        if (op.kind === "delete") {
          progress.delete(op.entityId);
          return;
        }
        const parsed = ProgressSchema.safeParse(op.record);
        if (parsed.success) progress.set(parsed.data.docId, parsed.data);
        return;
      }
      case "setting": {
        const parsed = SettingRecordSchema.safeParse(op.record);
        if (parsed.success) {
          settings.set(parsed.data.key, op.kind === "delete" ? { ...parsed.data, deleted: true } : parsed.data);
          return;
        }
        if (op.kind === "delete") settings.delete(op.entityId);
        return;
      }
    }
  };

  return {
    async putDocument(meta, model) {
      const updatedAt = options.now();
      const stored = DocumentMetaSchema.parse(stampMeta(meta, updatedAt));
      documents.set(stored.docId, { meta: stored, model: stored.deleted ? null : model });
      append("document", stored.docId, "put", updatedAt, stored);
    },

    async getDocumentMeta(docId) {
      const entry = documents.get(docId);
      if (entry === undefined || entry.meta.deleted) return null;
      return { ...entry.meta };
    },

    async getDocumentModel(docId) {
      const entry = documents.get(docId);
      if (entry === undefined || entry.meta.deleted) return null;
      return entry.model;
    },

    async listDocuments(q) {
      const listed: DocumentMeta[] = [];
      for (const entry of documents.values()) {
        const meta = entry.meta;
        if (meta.deleted) continue;
        if (q?.folderId !== undefined && meta.folderId !== q.folderId) continue;
        if (q?.text !== undefined && !meta.title.toLowerCase().includes(q.text.toLowerCase())) continue;
        listed.push({ ...meta });
      }
      return listed;
    },

    async deleteDocument(docId) {
      const entry = documents.get(docId);
      if (entry === undefined || entry.meta.deleted) return;
      const updatedAt = options.now();
      const stored = DocumentMetaSchema.parse({ ...entry.meta, updatedAt, deleted: true });
      documents.set(docId, { meta: stored, model: null });
      append("document", docId, "delete", updatedAt, stored);
    },

    async putFolder(folder) {
      const updatedAt = options.now();
      const stored = FolderSchema.parse({ ...folder, updatedAt });
      folders.set(stored.id, stored);
      append("folder", stored.id, "put", updatedAt, stored);
    },

    async listFolders() {
      const listed: Folder[] = [];
      for (const folder of folders.values()) {
        if (folder.deleted) continue;
        listed.push({ ...folder });
      }
      return listed;
    },

    async deleteFolder(id) {
      const folder = folders.get(id);
      if (folder === undefined || folder.deleted) return;
      const updatedAt = options.now();
      const stored = FolderSchema.parse({ ...folder, updatedAt, deleted: true });
      folders.set(id, stored);
      append("folder", id, "delete", updatedAt, stored);
    },

    async putBookmark(bookmark) {
      const updatedAt = options.now();
      const stored = BookmarkSchema.parse({ ...bookmark, updatedAt });
      bookmarks.set(stored.id, stored);
      append("bookmark", stored.id, "put", updatedAt, stored);
    },

    async listBookmarks(docId) {
      const listed: Bookmark[] = [];
      for (const bookmark of bookmarks.values()) {
        if (bookmark.deleted || bookmark.docId !== docId) continue;
        listed.push({ ...bookmark });
      }
      return listed;
    },

    async deleteBookmark(id) {
      const bookmark = bookmarks.get(id);
      if (bookmark === undefined || bookmark.deleted) return;
      const updatedAt = options.now();
      const stored = BookmarkSchema.parse({ ...bookmark, updatedAt, deleted: true });
      bookmarks.set(id, stored);
      append("bookmark", id, "delete", updatedAt, stored);
    },

    async setProgress(p) {
      const updatedAt = options.now();
      const stored = ProgressSchema.parse({ ...p, updatedAt });
      progress.set(stored.docId, stored);
      append("progress", stored.docId, "put", updatedAt, stored);
    },

    async getProgress(docId) {
      const stored = progress.get(docId);
      return stored === undefined ? null : { ...stored };
    },

    async setSetting(key, value) {
      const updatedAt = options.now();
      const stored = SettingRecordSchema.parse({ key, value, updatedAt, deleted: false });
      settings.set(key, stored);
      append("setting", key, "put", updatedAt, stored);
    },

    async getSetting<T>(key: string) {
      const stored = settings.get(key);
      if (stored === undefined || stored.deleted) return null;
      return stored.value as T;
    },

    async pendingOps(limit) {
      return outbox.slice(0, Math.max(0, limit)).map((op) => ({ ...op }));
    },

    async ackOps(opIds) {
      const acknowledged = new Set(opIds);
      outbox = outbox.filter((op) => !acknowledged.has(op.opId));
    },

    async applyRemote(ops) {
      for (const incoming of ops) {
        const op = OpSchema.parse(incoming);
        const key = versionKey(op.entity, op.entityId);
        const current = versions.get(key);
        if (current !== undefined && !isNewer(op, current)) continue;
        applyRecord(op);
        versions.set(key, { ts: op.ts, deviceId: op.deviceId });
      }
    },

    async getCursor() {
      return cursor;
    },

    async setCursor(rev) {
      cursor = rev;
    },
  };
}
