/**
 * The two seams between the SQL stores and the platform underneath them (F§5.9).
 *
 * `SqlDriver` is the whole database surface a store or a blob cache may touch: four asynchronous members,
 * none of them a connection, a transaction builder or an engine object. `BlobFs` is the whole file surface a
 * blob cache may touch. Everything in `src/` outside `testing/` therefore speaks to these two interfaces and
 * to nothing else — no `expo-*`, no `react-native`, no `better-sqlite3` — so the same store code runs over
 * an in-memory database in a Node test and over the device's own SQLite and file system on Android.
 *
 * Both interfaces are asynchronous even where a native engine answers synchronously: a device database call
 * crosses a JS/native bridge and a file read is I/O, and an interface that pretended otherwise could not be
 * implemented honestly by the platform it exists for.
 */

/**
 * A value a statement can be given. It is a subset of what every engine accepts, deliberately: no date, no
 * object, no `undefined` — a record's shape is JSON in a text column, and an absent value is SQL `NULL`.
 */
export type SqlParam = string | number | null | boolean;

/**
 * The database a store runs on. A driver owns one connection and, with it, the meaning of a transaction.
 *
 * Statements are written in the engine's own SQL and are given values as parameters — never assembled from
 * them — which is what keeps a docId, a title fragment or a note from becoming part of a query.
 */
export interface SqlDriver {
  /** Run one or more statements that answer nothing: schema changes and the begin/commit of a transaction. */
  exec(sql: string): Promise<void>;
  /** Run one statement whose answer nobody reads, binding `params` to its placeholders. */
  run(sql: string, params?: readonly SqlParam[]): Promise<void>;
  /**
   * Run one statement and answer its rows. A row is an object keyed by the statement's own column names,
   * which is what the engine answers in every implementation this repository has.
   */
  all<T>(sql: string, params?: readonly SqlParam[]): Promise<T[]>;
  /**
   * Run `fn` inside one transaction: everything it executes commits together, and a throw rolls the whole
   * thing back and propagates. The answer is `fn`'s own, which is what lets a caller read a record and
   * decide inside the same transaction that will write it.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * The file system a blob cache keeps its bytes on. Keys are the cache's own — a chunk id, `orig/<docId>`,
 * `anchors/<docId>` — and mapping one onto a file name is the implementation's business.
 */
export interface BlobFs {
  /** Write a key's bytes, creating or replacing the file. */
  write(key: string, bytes: Uint8Array): Promise<void>;
  /** A key's bytes, or `null` when the key has no file. */
  read(key: string): Promise<Uint8Array | null>;
  /** Remove a key's file. Removing a key that is absent is not an error. */
  remove(key: string): Promise<void>;
  /** Whether a key has a file. */
  exists(key: string): Promise<boolean>;
  /** A key's playable location — a `file://` URL on a device — or `null` when the key has no file. */
  uri(key: string): Promise<string | null>;
}
