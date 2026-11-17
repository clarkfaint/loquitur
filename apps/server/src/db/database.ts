/**
 * The hub's database file (F§8.4): one SQLite file under the data directory F§7.1 configures, opened with
 * the three settings every repository in this directory depends on.
 *
 * The write-ahead log is what lets a reader work while a writer holds the database — the sync routes, the
 * summary writer and a backup snapshot all reach this one file — and it is why the file gains two siblings
 * (`-wal` and `-shm`) once the hub has written anything. Foreign keys are enforced so a relation a later
 * migration adds cannot be left dangling, and the busy timeout is F§8.4's answer to a second connection: a
 * statement waits five seconds for a lock instead of failing at once.
 *
 * The data directory is created here when it is missing. SQLite refuses to create a database whose
 * directory does not exist, and F§7.1's default data directory is a relative path a fresh checkout does not
 * have, so a hub that is configured correctly must not fail to start because nobody made the directory.
 *
 * `better-sqlite3` and the host's file API are reached through `string`-typed specifiers rather than static
 * imports, and the part of their API this hub uses is described below. That is measured rather than
 * stylistic: `@types/better-sqlite3` opens with `/// <reference types="node" />`, so a *static* import of
 * that module resolves those declarations and puts Node's ambient types into `apps/server`'s program —
 * which compiles `packages/core`'s sources — and two frozen lines there stop type-checking the moment
 * `Buffer` becomes a real type. A dynamic import of a non-literal specifier type-checks without them and
 * still loads the real module under `vitest`, which is the boundary this package already uses for
 * `node:fs/promises` and the store-sql package uses for this same native addon. The installed declarations
 * stay the truth for what the host offers, and this unit's evidence quotes them.
 */

/** The subset of the host's file API this module uses. */
interface HostFiles {
  mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
}

/** A statement as this hub prepares one: parameters bound per call, and a row the caller reads by field. */
export interface HubStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}

/** The callable a transaction returns: the function it wraps, plus SQLite's three transaction modes. */
export interface HubTransaction<Args extends unknown[], Result> {
  (...args: Args): Result;
  default(...args: Args): Result;
  deferred(...args: Args): Result;
  immediate(...args: Args): Result;
}

/** The handle every repository under `src/db` is built over: the part of the host's API this hub uses. */
export interface HubDatabase {
  prepare(source: string): HubStatement;
  transaction<Args extends unknown[], Result>(fn: (...args: Args) => Result): HubTransaction<Args, Result>;
  exec(source: string): unknown;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  close(): unknown;
}

/** What the module exports: the constructor of a database, which the loader finds under `default`. */
interface SqliteModule {
  default: new (filename?: string, options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number }) => HubDatabase;
}

/** The file F§8.4 keeps the library's records in, under the data directory F§7.1 configures. */
const DATABASE_FILE = "lectern.db";

/** F§8.4's busy timeout: how long a statement waits for another connection to release its write lock. */
const BUSY_TIMEOUT_MS = 5000;

/** The host's file API, reached by specifier when it is first needed. */
async function hostFiles(): Promise<HostFiles> {
  const specifier: string = "node:fs/promises";
  return (await import(specifier)) as HostFiles;
}

/** The SQLite module, reached by specifier when it is first needed. */
async function sqliteModule(): Promise<SqliteModule> {
  const specifier: string = "better-sqlite3";
  return (await import(specifier)) as SqliteModule;
}

/** One path from segments, with any trailing separator removed so no segment doubles it. */
function joinPath(...segments: string[]): string {
  return segments.map((segment) => segment.replace(/\/+$/, "")).join("/");
}

/**
 * `openDatabase(dataDir)` — the hub's database, open and configured (F§8.4).
 *
 * The pragmas are set per connection rather than stored in the file, so every connection the hub opens
 * asks for the same behaviour; `journal_mode` is the one SQLite persists, and asking for it again on a
 * database that already uses it is a no-op.
 */
export async function openDatabase(dataDir: string): Promise<HubDatabase> {
  const files = await hostFiles();
  await files.mkdir(dataDir, { recursive: true });
  const sqlite = await sqliteModule();
  const db = new sqlite.default(joinPath(dataDir, DATABASE_FILE));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return db;
}
