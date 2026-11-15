/**
 * The SQLite layout a reader's library lives in (F§5.9), and the one step that creates it.
 *
 * `migrate(driver)` is the only place a table is declared. It reads the version table first and does nothing
 * when the database is already at `SCHEMA_VERSION`, so calling it on every start-up is both safe and the way
 * a database written by an older build gets its upgrade: a new version is a new branch plus a new number.
 *
 * The layout is F§5.9's entity set, one table each, plus two tables the interface implies rather than names:
 * `meta`, which holds the sync cursor and one last-writer-wins stamp per entity, and `blob_meta`, which holds
 * a cached blob's size, type and last use while the bytes live in files (a blob is never stored in SQLite).
 * `outbox` is keyed by an auto-incrementing `seq`, because insertion order *is* the outbox's order: it is
 * what makes `pendingOps(limit)` "the oldest n" and `ackOps` a delete by the op's own identifier.
 *
 * `documents` carries `titleFold` beside `title`: the library's text filter is a SQL predicate, and SQLite's
 * built-in `lower()` folds ASCII only, so the folded title is written once, by the caller's own JavaScript
 * `toLowerCase()`, and searched against the same way.
 */

import type { SqlDriver } from "./driver";

/** The layout this module creates. A change to a table below is a new number plus a branch for it. */
export const SCHEMA_VERSION = 1;

/** The version table's name. It has one row, whose `version` column is `SCHEMA_VERSION`. */
export const SCHEMA_VERSION_TABLE = "schema_version";

/** What one version row looks like. */
interface VersionRow {
  version: number;
}

/** The table definitions of version 1, in creation order. */
const TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS documents (
    docId TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    titleFold TEXT NOT NULL,
    sourceKind TEXT NOT NULL,
    sourceUri TEXT,
    folderId TEXT,
    addedAt INTEGER NOT NULL,
    wordCount INTEGER NOT NULL,
    sentenceCount INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    deleted INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS models (
    docId TEXT PRIMARY KEY,
    model TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parentId TEXT,
    updatedAt INTEGER NOT NULL,
    deleted INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS bookmarks (
    id TEXT PRIMARY KEY,
    docId TEXT NOT NULL,
    sentenceIndex INTEGER NOT NULL,
    wordIndex INTEGER NOT NULL,
    note TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    deleted INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS progress (
    docId TEXT PRIMARY KEY,
    sentenceIndex INTEGER NOT NULL,
    wordIndex INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updatedAt INTEGER NOT NULL,
    deleted INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    opId TEXT NOT NULL UNIQUE,
    deviceId TEXT NOT NULL,
    entity TEXT NOT NULL,
    entityId TEXT NOT NULL,
    kind TEXT NOT NULL,
    ts INTEGER NOT NULL,
    record TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS blob_meta (
    key TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    mime TEXT NOT NULL,
    lastUsed INTEGER NOT NULL
  )`,
];

/**
 * `migrate(driver)` — bring the database up to `SCHEMA_VERSION`, creating what is missing.
 *
 * The version table is created first and on its own: it is the only statement that has to be safe on a
 * database that has never been opened, and reading it is what decides whether the rest runs. The tables and
 * the new version row commit together, so a database cannot be left claiming a version it does not have.
 */
export async function migrate(driver: SqlDriver): Promise<void> {
  await driver.exec(`CREATE TABLE IF NOT EXISTS ${SCHEMA_VERSION_TABLE} (version INTEGER NOT NULL)`);
  const stored = await driver.all<VersionRow>(`SELECT version FROM ${SCHEMA_VERSION_TABLE} LIMIT 1`);
  const current = stored[0]?.version ?? 0;
  if (current >= SCHEMA_VERSION) return;
  await driver.transaction(async () => {
    for (const table of TABLES) await driver.exec(table);
    if (stored.length === 0) {
      await driver.run(`INSERT INTO ${SCHEMA_VERSION_TABLE} (version) VALUES (?)`, [SCHEMA_VERSION]);
      return;
    }
    await driver.run(`UPDATE ${SCHEMA_VERSION_TABLE} SET version = ?`, [SCHEMA_VERSION]);
  });
}
