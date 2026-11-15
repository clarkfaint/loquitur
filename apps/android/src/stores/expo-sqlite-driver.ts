/**
 * `SqlDriver` over `expo-sqlite`'s asynchronous API (F§5.9, F§10.4).
 *
 * The store package knows nothing about SQLite on a device: it asks for `exec`, `run`, `all` and
 * `transaction`, and this module is the whole translation. Every member is the asynchronous one — the
 * synchronous variants of the same calls exist, but a store that blocks the JavaScript thread while a
 * document is written would freeze the reader, which is the one thing a read-aloud app cannot do.
 *
 * **The platform module is loaded when a database is opened, not when this module is imported.** The
 * diagnostics registry reaches the store checks, and the registry is imported by a Node test that runs
 * `vitest` on a machine with no device and no Hermes — where `expo-sqlite` (and, through it, `react-native`)
 * cannot even be parsed. Loading it inside the factory keeps "import the registry" harmless everywhere and
 * puts the requirement where it belongs: only *opening a database* needs SQLite.
 *
 * Transactions go through `withTransactionAsync`, which is what makes two mutations issued at the same
 * moment queue instead of interleaving: an explicit `BEGIN` on a shared connection would raise "cannot start
 * a transaction within a transaction" the moment two screens wrote at once.
 */

import type { SqlDriver, SqlParam } from "@lectern/store-sql";
import type { SQLiteDatabase } from "expo-sqlite";

/**
 * The database a store runs on, plus the one thing a `SqlDriver` has no member for: closing it. The
 * diagnostics check opens and closes a scratch database per case, and a device that never closed one would
 * hold a native connection per run.
 */
export interface ExpoSqliteDriver extends SqlDriver {
  close(): Promise<void>;
}

/**
 * `openExpoSqliteDriver(databaseName)` — open (or create) a database and answer a driver over it.
 *
 * The name is the platform's own, so `lectern.db` is the file the app keeps its library in and
 * `deleteDatabaseAsync` can remove a scratch database by the same string it was opened with.
 */
export async function openExpoSqliteDriver(databaseName: string): Promise<ExpoSqliteDriver> {
  const sqlite: typeof import("expo-sqlite") = await import("expo-sqlite");
  const database: SQLiteDatabase = await sqlite.openDatabaseAsync(databaseName);

  return {
    async exec(sql) {
      await database.execAsync(sql);
    },

    async run(sql, params = []) {
      await database.runAsync(sql, [...params]);
    },

    async all<T>(sql: string, params: readonly SqlParam[] = []) {
      return database.getAllAsync<T>(sql, [...params]);
    },

    /**
     * expo-sqlite's own transaction helper answers `Promise<void>`, so the callback's answer is carried out
     * of it in a local. The rollback is the platform's: a throw inside the callback aborts the transaction
     * and propagates, which is what the store's mutations rely on.
     */
    async transaction<T>(fn: () => Promise<T>) {
      let answer: T | undefined;
      await database.withTransactionAsync(async () => {
        answer = await fn();
      });
      return answer as T;
    },

    async close() {
      await database.closeAsync();
    },
  };
}

/** `deleteExpoSqliteDatabase(name)` — remove a database this app created, by the name it was opened with. */
export async function deleteExpoSqliteDatabase(name: string): Promise<void> {
  const sqlite: typeof import("expo-sqlite") = await import("expo-sqlite");
  await sqlite.deleteDatabaseAsync(name);
}
