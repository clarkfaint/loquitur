/**
 * The hub's schema (F§8.4), as numbered migrations.
 *
 * A migration is a version, a name and the SQL that takes an empty database to that version. `migrate(db)`
 * applies the ones a database has not seen, each inside its own transaction, and records the version it
 * applied in `schema_migrations` — so it is idempotent by construction: a second call, a second connection
 * and a hub restarted after a crash all find the versions already recorded and do nothing.
 *
 * An applied migration is never edited (the contract's *Forbidden Actions*). A schema change is a new
 * migration with the next number, which is why the list below is append-only and why each entry's SQL
 * creates what it names rather than guessing whether something already exists.
 *
 * The five tables are F§8.4's own list. `records` holds the winning record per entity — the row a pull
 * answers with — and `changes` is the log a pull pages through, one row per accepted winning op. `seen_ops`
 * is the op ledger that makes a replayed push idempotent without reading `records`. `summaries` is where
 * F§7.2's summary routes keep a status per document and mode; a summary's text is not here, because a
 * document's body is a file (F§8.4).
 */

import type { HubDatabase } from "./database";

/** One numbered step of F§8.4's schema. */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** The bookkeeping table itself: the versions a database has already applied. */
const MIGRATIONS_TABLE = "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)";

/**
 * F§8.4's tables, in the order they were introduced. Version 1 is the whole of F§8.4: the record store,
 * the change log, the op ledger and the summary table.
 *
 * `ts` is a JSON number rather than a whole second, so it is stored with REAL affinity — SQLite keeps an
 * integer that fits exactly, and a client that stamps a fractional millisecond is not rounded behind its
 * back. The two provenance columns of `summaries` are nullable because a row exists while its summary is
 * still pending, and a pending summary has neither a model nor a prompt version yet.
 */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "records, changes, seen_ops, summaries",
    sql: `
      CREATE TABLE records (
        entity TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        ts REAL NOT NULL,
        device_id TEXT NOT NULL,
        deleted INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (entity, entity_id)
      );

      CREATE TABLE changes (
        rev INTEGER PRIMARY KEY AUTOINCREMENT,
        entity TEXT NOT NULL,
        entity_id TEXT NOT NULL
      );

      CREATE TABLE seen_ops (
        op_id TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL
      );

      CREATE TABLE summaries (
        doc_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        model TEXT,
        prompt_version TEXT,
        status TEXT NOT NULL,
        json TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (doc_id, mode)
      );
    `,
  },
];

/** The highest version this build of the hub knows how to apply. */
export const SCHEMA_VERSION = MIGRATIONS.reduce((highest, migration) => Math.max(highest, migration.version), 0);

/** The versions one database has applied, read from the bookkeeping table. */
function appliedVersions(db: HubDatabase): Set<number> {
  const rows = db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[];
  return new Set(rows.map((row) => row.version));
}

/**
 * `migrate(db)` — take the database to F§8.4's schema and answer the version it is at.
 *
 * Each migration runs in a transaction with the row that records it, so a migration that fails part way
 * leaves neither half of its work behind: SQLite's own DDL is transactional, and the version row commits
 * with the tables it describes. The bookkeeping table is created before anything is read from it, so a
 * brand-new database and a database from an earlier build take the same path.
 */
export function migrate(db: HubDatabase): number {
  db.exec(MIGRATIONS_TABLE);
  const applied = appliedVersions(db);
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(migration.version);
    })();
  }
  return Math.max(0, ...appliedVersions(db));
}
