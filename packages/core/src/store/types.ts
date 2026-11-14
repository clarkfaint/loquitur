/**
 * The local-first store contracts (F§5.9): five entity kinds, one sync envelope, and the two interfaces a
 * platform implements — `LibraryStore` for the records a reader owns, `BlobCache` for the bytes it plays.
 *
 * A record carries no owner, account or tenant field: one installation holds one library. Every record is
 * a strict schema, so a record that grows a field this design does not define is refused at the store
 * boundary instead of being stored and synced to every device.
 */

import { z } from "zod";
import { type DocumentModel, SourceKindSchema } from "../model";

/** The five kinds of record an op can carry (F§5.9); nothing else may enter the outbox. */
export const EntityKindSchema = z.enum(["document", "folder", "bookmark", "progress", "setting"]);
export type EntityKind = z.infer<typeof EntityKindSchema>;

/** What a library list can show about a document without loading its model (F§5.9). */
export const DocumentMetaSchema = z.strictObject({
  docId: z.string(),
  title: z.string(),
  sourceKind: SourceKindSchema,
  sourceUri: z.string().exactOptional(),
  folderId: z.string().nullable(),
  addedAt: z.number(),
  wordCount: z.int().nonnegative(),
  sentenceCount: z.int().nonnegative(),
  updatedAt: z.number(),
  deleted: z.boolean(),
});
export type DocumentMeta = z.infer<typeof DocumentMetaSchema>;

/** A folder of the library tree (F§5.9); `parentId` is `null` at the root. */
export const FolderSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable(),
  updatedAt: z.number(),
  deleted: z.boolean(),
});
export type Folder = z.infer<typeof FolderSchema>;

/** A place in a document the reader marked, with the reader's own note (F§5.9). */
export const BookmarkSchema = z.strictObject({
  id: z.string(),
  docId: z.string(),
  sentenceIndex: z.int().nonnegative(),
  wordIndex: z.int().nonnegative(),
  note: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  deleted: z.boolean(),
});
export type Bookmark = z.infer<typeof BookmarkSchema>;

/** Where the reader stopped in a document (F§5.9). Progress is replaced, never deleted. */
export const ProgressSchema = z.strictObject({
  docId: z.string(),
  sentenceIndex: z.int().nonnegative(),
  wordIndex: z.int().nonnegative(),
  updatedAt: z.number(),
});
export type Progress = z.infer<typeof ProgressSchema>;

/**
 * One setting, named by its key (F§5.9's fifth entity kind): the record an op carries. It is stored with
 * the same tombstone rule as the other four, so a setting removed on one device stays removed.
 */
export const SettingRecordSchema = z.strictObject({
  key: z.string(),
  value: z.unknown(),
  updatedAt: z.number(),
  deleted: z.boolean(),
});
export type SettingRecord = z.infer<typeof SettingRecordSchema>;

/** One mutation, stamped by the device that made it (F§5.9). `record` is the record or its tombstone. */
export const OpSchema = z.strictObject({
  opId: z.string(),
  deviceId: z.string(),
  entity: EntityKindSchema,
  entityId: z.string(),
  kind: z.enum(["put", "delete"]),
  ts: z.number(),
  record: z.unknown(),
});
export type Op = z.infer<typeof OpSchema>;

/**
 * The record store every platform implements (F§5.9). Every method is asynchronous, because a real
 * implementation writes to IndexedDB, SQLite or the file system; the reference implementation behind this
 * interface answers from memory.
 *
 * Each local mutation appends one op to the outbox, and `applyRemote` is the only other writer — it never
 * queues what it applies.
 */
export interface LibraryStore {
  putDocument(meta: DocumentMeta, model: DocumentModel): Promise<void>;
  getDocumentMeta(docId: string): Promise<DocumentMeta | null>;
  getDocumentModel(docId: string): Promise<DocumentModel | null>;
  listDocuments(q?: { folderId?: string | null; text?: string }): Promise<DocumentMeta[]>;
  deleteDocument(docId: string): Promise<void>;
  putFolder(f: Folder): Promise<void>;
  listFolders(): Promise<Folder[]>;
  deleteFolder(id: string): Promise<void>;
  putBookmark(b: Bookmark): Promise<void>;
  listBookmarks(docId: string): Promise<Bookmark[]>;
  deleteBookmark(id: string): Promise<void>;
  setProgress(p: Progress): Promise<void>;
  getProgress(docId: string): Promise<Progress | null>;
  setSetting(key: string, value: unknown): Promise<void>;
  getSetting<T>(key: string): Promise<T | null>;
  pendingOps(limit: number): Promise<Op[]>;
  ackOps(opIds: string[]): Promise<void>;
  applyRemote(ops: Op[]): Promise<void>;
  getCursor(): Promise<number>;
  setCursor(rev: number): Promise<void>;
}

/**
 * The byte cache a reader plays from (F§5.9): keyed chunks and downloaded assets, with a least-recently-used
 * eviction that the caller's `pinned` predicate can hold back.
 */
export interface BlobCache {
  has(key: string): Promise<boolean>;
  put(key: string, bytes: Uint8Array, mime: string): Promise<string>;
  get(key: string): Promise<Uint8Array | null>;
  uri(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
  sizeBytes(): Promise<number>;
  evictLru(maxBytes: number, pinned: (key: string) => boolean): Promise<number>;
}
