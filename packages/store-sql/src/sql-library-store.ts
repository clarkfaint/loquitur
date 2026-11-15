/**
 * The SQLite `LibraryStore` (F§5.9): the records a reader owns, the outbox that carries every mutation to
 * the hub, and one version stamp per entity so the last-writer-wins rule has something to compare.
 *
 * It is the same store on every platform, because it talks to a `SqlDriver` and to nothing else. Six
 * decisions the interface leaves open, each of them chosen so the process can be killed at any moment:
 *
 * - **the store owns the clock.** A mutation stamps `updatedAt` from `now()` and gives its op the same `ts`,
 *   so a record and the op that carries it agree on every device that applies them;
 * - **a mutation and its outbox row commit in one transaction.** A record whose op is missing is a change no
 *   other device ever hears about; an op whose record is missing is one they cannot apply;
 * - **the outbox is a queue of envelopes only.** `applyRemote` writes records and stamps, and never queues
 *   what it applied — a change that arrived from the network is not a change to send back. The stamp it
 *   records is the **op's own** (`ts` and the sending device), never this device's identity: the tie-break
 *   compares `deviceId` strings, so a store that stamped itself would refuse a later record from another
 *   device that happens to carry the same timestamp;
 * - **a version stamp lives in `meta` under `version:<entity>:<id>`.** F§5.9's tables have no versions table
 *   and `meta` is one of them, so LWW needs no store the layout does not already declare;
 * - **the model is stored beside its metadata and never inside an op.** Ops carry records; a document's text
 *   travels as its own payload, so a device that applies a remote `document` op holds the metadata and waits
 *   for the file (F§8.2) — which is why applying one leaves a model already on hand alone;
 * - **every value is bound, never written into the SQL.** A query's shape is assembled from a fixed set of
 *   clauses; a docId, a title fragment and an op id all travel as parameters.
 */

import {
  type Bookmark,
  BookmarkSchema,
  type DocumentMeta,
  DocumentMetaSchema,
  DocumentModelSchema,
  type EntityKind,
  type Folder,
  FolderSchema,
  isNewer,
  type LibraryStore,
  type Op,
  OpSchema,
  type Progress,
  ProgressSchema,
  SettingRecordSchema,
  type Version,
} from "@lectern/core";
import { z } from "zod";
import type { SqlDriver, SqlParam } from "./driver";

/** What a SQL library store needs from its host: a connection, an identity, a clock and op identifiers. */
export interface SqlLibraryStoreOptions {
  driver: SqlDriver;
  deviceId: string;
  now: () => number;
  newId: () => string;
}

/** The `meta` key the sync cursor is kept under. */
const CURSOR_KEY = "cursor";

/** A stamp as it is stored: F§5.9's `Version`, validated on the way back out of a text column. */
const VersionSchema = z.strictObject({ ts: z.number(), deviceId: z.string() });

/** One `documents` row. `titleFold` is the search key, not a field of F§5.9's record. */
interface DocumentRow {
  docId: string;
  title: string;
  titleFold: string;
  sourceKind: string;
  sourceUri: string | null;
  folderId: string | null;
  addedAt: number;
  wordCount: number;
  sentenceCount: number;
  updatedAt: number;
  deleted: number;
}

/** One `folders` row. */
interface FolderRow {
  id: string;
  name: string;
  parentId: string | null;
  updatedAt: number;
  deleted: number;
}

/** One `bookmarks` row. */
interface BookmarkRow {
  id: string;
  docId: string;
  sentenceIndex: number;
  wordIndex: number;
  note: string;
  createdAt: number;
  updatedAt: number;
  deleted: number;
}

/** One `settings` row. The value is JSON, because F§5.9's setting carries whatever the field holds. */
interface SettingRow {
  key: string;
  value: string;
  updatedAt: number;
  deleted: number;
}

/** One `progress` row. */
interface ProgressRow {
  docId: string;
  sentenceIndex: number;
  wordIndex: number;
  updatedAt: number;
}

/** One `outbox` row: F§5.9's op, with its record as JSON. */
interface OpRow {
  opId: string;
  deviceId: string;
  entity: string;
  entityId: string;
  kind: string;
  ts: number;
  record: string;
}

/** One `meta` row, of which this store reads the stamp and the cursor. */
interface MetaRow {
  value: string;
}

/** The `meta` key one entity's last-writer-wins stamp is kept under (F§5.9). */
function versionKey(entity: EntityKind, entityId: string): string {
  return `version:${entity}:${entityId}`;
}

/** Parse a text column, or answer `null` when it is not the JSON it should be. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Copy a document's metadata with a fresh stamp, listing its fields one by one: an optional `sourceUri`
 * present as an explicit `undefined` is refused by the schema, so the key is added only when it holds a
 * value — and a SQL row has no key for it at all.
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

/** A `documents` row as F§5.9's record, validated so a row of another shape is refused rather than trusted. */
function toDocumentMeta(row: DocumentRow): DocumentMeta {
  const base = {
    docId: row.docId,
    title: row.title,
    sourceKind: row.sourceKind,
    folderId: row.folderId,
    addedAt: row.addedAt,
    wordCount: row.wordCount,
    sentenceCount: row.sentenceCount,
    updatedAt: row.updatedAt,
    deleted: row.deleted !== 0,
  };
  return DocumentMetaSchema.parse(row.sourceUri === null ? base : { ...base, sourceUri: row.sourceUri });
}

/** A `folders` row as F§5.9's record. */
function toFolder(row: FolderRow): Folder {
  return FolderSchema.parse({
    id: row.id,
    name: row.name,
    parentId: row.parentId,
    updatedAt: row.updatedAt,
    deleted: row.deleted !== 0,
  });
}

/** A `bookmarks` row as F§5.9's record. */
function toBookmark(row: BookmarkRow): Bookmark {
  return BookmarkSchema.parse({
    id: row.id,
    docId: row.docId,
    sentenceIndex: row.sentenceIndex,
    wordIndex: row.wordIndex,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deleted: row.deleted !== 0,
  });
}

/** A `progress` row as F§5.9's record. */
function toProgress(row: ProgressRow): Progress {
  return ProgressSchema.parse(row);
}

/** One SQL boolean as JavaScript's. */
function flag(value: boolean): number {
  return value ? 1 : 0;
}

/**
 * `createSqlLibraryStore({ driver, deviceId, now, newId })` — a `LibraryStore` over one connection.
 *
 * The connection is the caller's: it comes from opening and migrating a database, so a second store over the
 * same driver shares everything the first one wrote, and nothing here declares a schema or opens a file.
 */
export function createSqlLibraryStore(options: SqlLibraryStoreOptions): LibraryStore {
  const { driver, deviceId } = options;

  /** Write one document's metadata, folding its title for the library's search on the way in. */
  const writeDocument = async (meta: DocumentMeta): Promise<void> => {
    await driver.run(
      "INSERT OR REPLACE INTO documents (docId, title, titleFold, sourceKind, sourceUri, folderId, addedAt, wordCount, sentenceCount, updatedAt, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        meta.docId,
        meta.title,
        meta.title.toLowerCase(),
        meta.sourceKind,
        meta.sourceUri ?? null,
        meta.folderId,
        meta.addedAt,
        meta.wordCount,
        meta.sentenceCount,
        meta.updatedAt,
        flag(meta.deleted),
      ],
    );
  };

  /** The `documents` row a document op writes: its own record, or for a delete op its tombstone. */
  const documentMetaFor = async (op: Op): Promise<DocumentMeta | null> => {
    const parsed = DocumentMetaSchema.safeParse(op.record);
    if (parsed.success) return op.kind === "delete" ? { ...parsed.data, deleted: true } : parsed.data;
    if (op.kind !== "delete") return null;
    const rows = await driver.all<DocumentRow>("SELECT * FROM documents WHERE docId = ?", [op.entityId]);
    const row = rows[0];
    return row === undefined ? null : { ...toDocumentMeta(row), updatedAt: op.ts, deleted: true };
  };

  /** Write one remote op's record into the table it belongs to. The stamp is the caller's business. */
  const applyRemoteRecord = async (op: Op): Promise<void> => {
    switch (op.entity) {
      case "document": {
        const meta = await documentMetaFor(op);
        if (meta === null) return;
        await writeDocument(meta);
        if (meta.deleted) await driver.run("DELETE FROM models WHERE docId = ?", [meta.docId]);
        return;
      }
      case "folder": {
        const parsed = FolderSchema.safeParse(op.record);
        if (parsed.success) {
          const stored = op.kind === "delete" ? { ...parsed.data, deleted: true } : parsed.data;
          await driver.run("INSERT OR REPLACE INTO folders (id, name, parentId, updatedAt, deleted) VALUES (?, ?, ?, ?, ?)", [
            stored.id,
            stored.name,
            stored.parentId,
            stored.updatedAt,
            flag(stored.deleted),
          ]);
          return;
        }
        if (op.kind !== "delete") return;
        const rows = await driver.all<FolderRow>("SELECT * FROM folders WHERE id = ?", [op.entityId]);
        const row = rows[0];
        if (row === undefined) return;
        await driver.run("UPDATE folders SET updatedAt = ?, deleted = 1 WHERE id = ?", [op.ts, op.entityId]);
        return;
      }
      case "bookmark": {
        const parsed = BookmarkSchema.safeParse(op.record);
        if (parsed.success) {
          const stored = op.kind === "delete" ? { ...parsed.data, deleted: true } : parsed.data;
          await driver.run(
            "INSERT OR REPLACE INTO bookmarks (id, docId, sentenceIndex, wordIndex, note, createdAt, updatedAt, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [
              stored.id,
              stored.docId,
              stored.sentenceIndex,
              stored.wordIndex,
              stored.note,
              stored.createdAt,
              stored.updatedAt,
              flag(stored.deleted),
            ],
          );
          return;
        }
        if (op.kind !== "delete") return;
        const rows = await driver.all<BookmarkRow>("SELECT * FROM bookmarks WHERE id = ?", [op.entityId]);
        const row = rows[0];
        if (row === undefined) return;
        await driver.run("UPDATE bookmarks SET updatedAt = ?, deleted = 1 WHERE id = ?", [op.ts, op.entityId]);
        return;
      }
      case "progress": {
        if (op.kind === "delete") {
          await driver.run("DELETE FROM progress WHERE docId = ?", [op.entityId]);
          return;
        }
        const parsed = ProgressSchema.safeParse(op.record);
        if (!parsed.success) return;
        await driver.run("INSERT OR REPLACE INTO progress (docId, sentenceIndex, wordIndex, updatedAt) VALUES (?, ?, ?, ?)", [
          parsed.data.docId,
          parsed.data.sentenceIndex,
          parsed.data.wordIndex,
          parsed.data.updatedAt,
        ]);
        return;
      }
      case "setting": {
        const parsed = SettingRecordSchema.safeParse(op.record);
        if (parsed.success) {
          const stored = op.kind === "delete" ? { ...parsed.data, deleted: true } : parsed.data;
          await driver.run("INSERT OR REPLACE INTO settings (key, value, updatedAt, deleted) VALUES (?, ?, ?, ?)", [
            stored.key,
            JSON.stringify(stored.value ?? null),
            stored.updatedAt,
            flag(stored.deleted),
          ]);
          return;
        }
        if (op.kind === "delete") await driver.run("DELETE FROM settings WHERE key = ?", [op.entityId]);
        return;
      }
    }
  };

  /** Append one mutation's op to the outbox, stamped by this device. */
  const appendOp = async (entity: EntityKind, entityId: string, kind: "put" | "delete", ts: number, record: unknown): Promise<void> => {
    await driver.run("INSERT INTO outbox (opId, deviceId, entity, entityId, kind, ts, record) VALUES (?, ?, ?, ?, ?, ?, ?)", [
      options.newId(),
      deviceId,
      entity,
      entityId,
      kind,
      ts,
      JSON.stringify(record),
    ]);
  };

  /** The stamp a local mutation establishing `ts` leaves for its entity. */
  const stampOf = (ts: number): Version => ({ ts, deviceId });

  /** Remember the version on record for one entity — a local mutation's own, or the one an op carried. */
  const writeVersion = async (entity: EntityKind, entityId: string, stamp: Version): Promise<void> => {
    await driver.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [versionKey(entity, entityId), JSON.stringify(stamp)]);
  };

  /** The version on record for one entity, or `null` when the database has never seen it. */
  const readVersion = async (entity: EntityKind, entityId: string): Promise<Version | null> => {
    const rows = await driver.all<MetaRow>("SELECT value FROM meta WHERE key = ?", [versionKey(entity, entityId)]);
    const stored = rows[0];
    if (stored === undefined) return null;
    const parsed = VersionSchema.safeParse(parseJson(stored.value));
    return parsed.success ? parsed.data : null;
  };

  /** One row, or `null` when the statement answered none. */
  const one = async <T>(sql: string, params: readonly SqlParam[]): Promise<T | null> => {
    const rows = await driver.all<T>(sql, params);
    return rows[0] ?? null;
  };

  return {
    async putDocument(meta, model) {
      const updatedAt = options.now();
      const stored = DocumentMetaSchema.parse(stampMeta(meta, updatedAt));
      const payload = JSON.stringify(model);
      await driver.transaction(async () => {
        await writeDocument(stored);
        if (stored.deleted) await driver.run("DELETE FROM models WHERE docId = ?", [stored.docId]);
        else await driver.run("INSERT OR REPLACE INTO models (docId, model) VALUES (?, ?)", [stored.docId, payload]);
        await appendOp("document", stored.docId, "put", updatedAt, stored);
        await writeVersion("document", stored.docId, stampOf(updatedAt));
      });
    },

    async getDocumentMeta(docId) {
      const row = await one<DocumentRow>("SELECT * FROM documents WHERE docId = ?", [docId]);
      if (row === null) return null;
      const meta = toDocumentMeta(row);
      return meta.deleted ? null : meta;
    },

    async getDocumentModel(docId) {
      const row = await one<DocumentRow>("SELECT * FROM documents WHERE docId = ?", [docId]);
      if (row === null || row.deleted !== 0) return null;
      const stored = await one<MetaRow>("SELECT model AS value FROM models WHERE docId = ?", [docId]);
      if (stored === null) return null;
      return DocumentModelSchema.parse(parseJson(stored.value));
    },

    async listDocuments(q) {
      const clauses = ["deleted = 0"];
      const params: SqlParam[] = [];
      if (q?.folderId !== undefined) {
        if (q.folderId === null) clauses.push("folderId IS NULL");
        else {
          clauses.push("folderId = ?");
          params.push(q.folderId);
        }
      }
      if (q?.text !== undefined) {
        clauses.push("instr(titleFold, ?) > 0");
        params.push(q.text.toLowerCase());
      }
      const rows = await driver.all<DocumentRow>(`SELECT * FROM documents WHERE ${clauses.join(" AND ")}`, params);
      return rows.map(toDocumentMeta);
    },

    async deleteDocument(docId) {
      await driver.transaction(async () => {
        const row = await one<DocumentRow>("SELECT * FROM documents WHERE docId = ?", [docId]);
        if (row === null) return;
        const existing = toDocumentMeta(row);
        if (existing.deleted) return;
        const updatedAt = options.now();
        const stored = DocumentMetaSchema.parse({ ...existing, updatedAt, deleted: true });
        await writeDocument(stored);
        await driver.run("DELETE FROM models WHERE docId = ?", [docId]);
        await appendOp("document", docId, "delete", updatedAt, stored);
        await writeVersion("document", docId, stampOf(updatedAt));
      });
    },

    async putFolder(folder) {
      const updatedAt = options.now();
      const stored = FolderSchema.parse({ ...folder, updatedAt });
      await driver.transaction(async () => {
        await driver.run("INSERT OR REPLACE INTO folders (id, name, parentId, updatedAt, deleted) VALUES (?, ?, ?, ?, ?)", [
          stored.id,
          stored.name,
          stored.parentId,
          updatedAt,
          flag(stored.deleted),
        ]);
        await appendOp("folder", stored.id, "put", updatedAt, stored);
        await writeVersion("folder", stored.id, stampOf(updatedAt));
      });
    },

    async listFolders() {
      const rows = await driver.all<FolderRow>("SELECT * FROM folders WHERE deleted = 0");
      return rows.map(toFolder);
    },

    async deleteFolder(id) {
      await driver.transaction(async () => {
        const row = await one<FolderRow>("SELECT * FROM folders WHERE id = ?", [id]);
        if (row === null) return;
        const existing = toFolder(row);
        if (existing.deleted) return;
        const updatedAt = options.now();
        const stored = FolderSchema.parse({ ...existing, updatedAt, deleted: true });
        await driver.run("INSERT OR REPLACE INTO folders (id, name, parentId, updatedAt, deleted) VALUES (?, ?, ?, ?, ?)", [
          stored.id,
          stored.name,
          stored.parentId,
          updatedAt,
          flag(stored.deleted),
        ]);
        await appendOp("folder", id, "delete", updatedAt, stored);
        await writeVersion("folder", id, stampOf(updatedAt));
      });
    },

    async putBookmark(bookmark) {
      const updatedAt = options.now();
      const stored = BookmarkSchema.parse({ ...bookmark, updatedAt });
      await driver.transaction(async () => {
        await driver.run(
          "INSERT OR REPLACE INTO bookmarks (id, docId, sentenceIndex, wordIndex, note, createdAt, updatedAt, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [stored.id, stored.docId, stored.sentenceIndex, stored.wordIndex, stored.note, stored.createdAt, updatedAt, flag(stored.deleted)],
        );
        await appendOp("bookmark", stored.id, "put", updatedAt, stored);
        await writeVersion("bookmark", stored.id, stampOf(updatedAt));
      });
    },

    async listBookmarks(docId) {
      const rows = await driver.all<BookmarkRow>("SELECT * FROM bookmarks WHERE deleted = 0 AND docId = ?", [docId]);
      return rows.map(toBookmark);
    },

    async deleteBookmark(id) {
      await driver.transaction(async () => {
        const row = await one<BookmarkRow>("SELECT * FROM bookmarks WHERE id = ?", [id]);
        if (row === null) return;
        const existing = toBookmark(row);
        if (existing.deleted) return;
        const updatedAt = options.now();
        const stored = BookmarkSchema.parse({ ...existing, updatedAt, deleted: true });
        await driver.run(
          "INSERT OR REPLACE INTO bookmarks (id, docId, sentenceIndex, wordIndex, note, createdAt, updatedAt, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [stored.id, stored.docId, stored.sentenceIndex, stored.wordIndex, stored.note, stored.createdAt, updatedAt, flag(stored.deleted)],
        );
        await appendOp("bookmark", id, "delete", updatedAt, stored);
        await writeVersion("bookmark", id, stampOf(updatedAt));
      });
    },

    async setProgress(p) {
      const updatedAt = options.now();
      const stored = ProgressSchema.parse({ ...p, updatedAt });
      await driver.transaction(async () => {
        await driver.run("INSERT OR REPLACE INTO progress (docId, sentenceIndex, wordIndex, updatedAt) VALUES (?, ?, ?, ?)", [
          stored.docId,
          stored.sentenceIndex,
          stored.wordIndex,
          updatedAt,
        ]);
        await appendOp("progress", stored.docId, "put", updatedAt, stored);
        await writeVersion("progress", stored.docId, stampOf(updatedAt));
      });
    },

    async getProgress(docId) {
      const row = await one<ProgressRow>("SELECT * FROM progress WHERE docId = ?", [docId]);
      return row === null ? null : toProgress(row);
    },

    async setSetting(key, value) {
      const updatedAt = options.now();
      const stored = SettingRecordSchema.parse({ key, value, updatedAt, deleted: false });
      await driver.transaction(async () => {
        await driver.run("INSERT OR REPLACE INTO settings (key, value, updatedAt, deleted) VALUES (?, ?, ?, 0)", [
          key,
          JSON.stringify(value ?? null),
          updatedAt,
        ]);
        await appendOp("setting", key, "put", updatedAt, stored);
        await writeVersion("setting", key, stampOf(updatedAt));
      });
    },

    async getSetting<T>(key: string) {
      const row = await one<SettingRow>("SELECT * FROM settings WHERE key = ?", [key]);
      if (row === null || row.deleted !== 0) return null;
      return parseJson(row.value) as T;
    },

    async pendingOps(limit) {
      const bound = Math.max(0, Math.floor(limit));
      if (bound === 0) return [];
      const rows = await driver.all<OpRow>(
        "SELECT opId, deviceId, entity, entityId, kind, ts, record FROM outbox ORDER BY seq ASC LIMIT ?",
        [bound],
      );
      return rows.map((row) =>
        OpSchema.parse({
          opId: row.opId,
          deviceId: row.deviceId,
          entity: row.entity,
          entityId: row.entityId,
          kind: row.kind,
          ts: row.ts,
          record: parseJson(row.record),
        }),
      );
    },

    async ackOps(opIds) {
      if (opIds.length === 0) return;
      const placeholders = opIds.map(() => "?").join(", ");
      await driver.run(`DELETE FROM outbox WHERE opId IN (${placeholders})`, [...opIds]);
    },

    async applyRemote(ops) {
      for (const incoming of ops) {
        const op = OpSchema.parse(incoming);
        const current = await readVersion(op.entity, op.entityId);
        if (current !== null && !isNewer(op, current)) continue;
        await applyRemoteRecord(op);
        await writeVersion(op.entity, op.entityId, { ts: op.ts, deviceId: op.deviceId });
      }
    },

    async getCursor() {
      const row = await one<MetaRow>("SELECT value FROM meta WHERE key = ?", [CURSOR_KEY]);
      if (row === null) return 0;
      const parsed = parseJson(row.value);
      return typeof parsed === "number" ? parsed : 0;
    },

    async setCursor(rev) {
      await driver.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [CURSOR_KEY, JSON.stringify(rev)]);
    },
  };
}
