/**
 * A real SQLite database behind `SqlDriver`, for tests (F§5.9).
 *
 * `better-sqlite3` is a native addon, and its package ships no declarations — R10 forbids adding typings for
 * it — so the module is reached through a specifier held in a `string`-typed variable and the little of its
 * API this file uses is described below as an interface of its own. That is the same boundary the Node-only
 * modules use for `node:fs` and `node:buffer`: a dynamic import of a non-literal specifier type-checks
 * without `@types/node` and still loads the real module under `vitest`.
 *
 * The database is opened `:memory:`, so a driver is a database of its own and disappears with it — which is
 * exactly what a conformance case wants, and what makes "the same database" in a test mean "the same
 * driver".
 */

import type { SqlDriver, SqlParam } from "../driver";

/** The half of a prepared statement this driver uses. */
interface BetterSqliteStatement {
  run(...params: SqlParam[]): unknown;
  all(...params: SqlParam[]): unknown[];
}

/** The half of a `better-sqlite3` database this driver uses. */
interface BetterSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): BetterSqliteStatement;
  close(): void;
}

/** The module's own export: the constructor of a database. */
interface BetterSqliteModule {
  default: new (path: string) => BetterSqliteDatabase;
}

/**
 * `createBetterSqlite3Driver()` — a `SqlDriver` over a new in-memory SQLite database.
 *
 * Transactions are explicit (`BEGIN`/`COMMIT`/`ROLLBACK`) rather than the engine's own `db.transaction(...)`
 * helper, because that helper commits as soon as the callback returns and this interface's callback is
 * asynchronous: a `BEGIN` the driver can await around is the only shape that keeps a mutation atomic.
 */
export async function createBetterSqlite3Driver(): Promise<SqlDriver> {
  const specifier: string = "better-sqlite3";
  const loaded = (await import(specifier)) as BetterSqliteModule;
  const database = new loaded.default(":memory:");

  return {
    async exec(sql) {
      database.exec(sql);
    },

    async run(sql, params = []) {
      database.prepare(sql).run(...params);
    },

    async all<T>(sql: string, params: readonly SqlParam[] = []) {
      return database.prepare(sql).all(...params) as T[];
    },

    async transaction<T>(fn: () => Promise<T>) {
      database.exec("BEGIN");
      try {
        const answer = await fn();
        database.exec("COMMIT");
        return answer;
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    },
  };
}
