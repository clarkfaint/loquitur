/**
 * F§8.2's record repository and F§8.4's database (U-055): the last-writer-wins rule applied to a real
 * SQLite file, the op ledger that makes a replayed push a no-op, the change log a pull pages through, and
 * the notification the change feed waits on.
 *
 * Every case opens its own database in a temporary directory and closes it afterwards, so nothing is shared
 * between cases and no `rev` from one case can appear in another. The records are F§5.9's `setting` entity —
 * a key, a value and a tombstone flag — because it is the one entity kind whose record needs no document
 * model beside it, and the rule under test is the same for all five.
 *
 * Reading and removing the temporary directory needs `node:fs`, so this file stays outside the package's
 * type-check program (its test directories are excluded): vitest erases types instead of checking them and
 * runs it as written.
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "@lectern/core";
import { afterEach, expect, test } from "vitest";
import { type HubDatabase, openDatabase } from "../database";
import { migrate } from "../migrations";
import { createRecordsRepo, type RecordsRepo } from "../records-repo";

/** One open hub: its database, F§8.2's repository over it, and the directory both live in. */
interface Scratch {
  db: HubDatabase;
  repo: RecordsRepo;
  dir: string;
}

/** The hubs this file has opened, so every case's directory is closed and removed however the case ends. */
const opened: Scratch[] = [];

/** A hub of its own: a temporary data directory, F§8.4's database, its schema, and a repository. */
async function scratch(): Promise<Scratch> {
  const dir = await mkdtemp(join(tmpdir(), "lectern-hub-db-"));
  const db = await openDatabase(dir);
  migrate(db);
  const hub: Scratch = { db, repo: createRecordsRepo(db), dir };
  opened.push(hub);
  return hub;
}

afterEach(async () => {
  for (const hub of opened.splice(0)) {
    hub.db.close();
    await rm(hub.dir, { recursive: true, force: true });
  }
});

/** F§5.9's `setting` record: a key, a value and the tombstone flag. */
function setting(entityId: string, value: unknown, updatedAt: number, deleted: boolean): unknown {
  return { key: entityId, value, updatedAt, deleted };
}

/** A `put` op of the `setting` entity, stamped by the device that made it. */
function put(opId: string, deviceId: string, ts: number, value: unknown, options: { entityId?: string; deleted?: boolean } = {}): Op {
  const entityId = options.entityId ?? "theme";
  return { opId, deviceId, entity: "setting", entityId, kind: "put", ts, record: setting(entityId, value, ts, options.deleted ?? false) };
}

/** A `delete` op, carrying F§5.9's tombstone as its record. */
function remove(opId: string, deviceId: string, ts: number, entityId = "theme"): Op {
  return { opId, deviceId, entity: "setting", entityId, kind: "delete", ts, record: setting(entityId, null, ts, true) };
}

/** The record the hub currently holds for one entity, read back the way a client reads it: through a pull. */
function current(repo: RecordsRepo, entityId: string): Op | undefined {
  return repo.changesSince(0, 500).changes.find((op) => op.entityId === entityId);
}

/** The value inside a record, for the cases that care which write won. */
function recordValue(op: Op | undefined): unknown {
  return (op?.record as { value?: unknown } | undefined)?.value;
}

test("openDatabase opens F§8.4's file with a write-ahead log, foreign keys and a five-second busy timeout", async () => {
  const { db, dir } = await scratch();
  expect(existsSync(join(dir, "lectern.db"))).toBe(true);
  expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
  expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
});

test("migrate creates F§8.4's tables and running it a second time changes nothing", async () => {
  const { db } = await scratch();
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
    .map((row) => row.name)
    .filter((name) => !name.startsWith("sqlite_"))
    .sort();
  expect(tables).toEqual(["changes", "records", "schema_migrations", "seen_ops", "summaries"]);

  // The second run: `scratch` migrated once, so this is the same call on a database that has seen it.
  expect(migrate(db)).toBe(1);
  const versions = (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map((row) => row.version);
  expect(versions).toEqual([1]);
});

test("the same opId twice changes nothing and is accepted both times", async () => {
  const { repo } = await scratch();
  const first = put("op-1", "dev-a", 100, "sepia");

  expect(repo.applyOps("dev-a", [first])).toEqual({ accepted: ["op-1"], rev: 1 });
  expect(repo.applyOps("dev-a", [first])).toEqual({ accepted: ["op-1"], rev: 1 });
  expect(repo.currentRev()).toBe(1);
  expect(repo.changesSince(0, 500).changes.length).toBe(1);

  // The ledger is consulted before the rule, so a replayed opId is ignored even when its stamp would win.
  expect(repo.applyOps("dev-z", [put("op-1", "dev-z", 900, "forged")])).toEqual({ accepted: ["op-1"], rev: 1 });
  expect(recordValue(current(repo, "theme"))).toBe("sepia");
});

test("newer wins, older loses but is accepted, and a tie breaks by deviceId", async () => {
  const { repo } = await scratch();
  expect(repo.applyOps("dev-b", [put("op-1", "dev-b", 100, "b-100")])).toEqual({ accepted: ["op-1"], rev: 1 });

  expect(repo.applyOps("dev-b", [put("op-2", "dev-c", 200, "c-200")])).toEqual({ accepted: ["op-2"], rev: 2 });
  expect(recordValue(current(repo, "theme"))).toBe("c-200");

  // Older, and accepted: F§8.2 answers every opId of the request, whether or not it won.
  expect(repo.applyOps("dev-b", [put("op-3", "dev-z", 150, "z-150")])).toEqual({ accepted: ["op-3"], rev: 2 });
  expect(recordValue(current(repo, "theme"))).toBe("c-200");

  // A tie is broken by the greater deviceId, in either arrival order (F§5.9).
  expect(repo.applyOps("dev-a", [put("op-4", "dev-a", 200, "a-200")])).toEqual({ accepted: ["op-4"], rev: 2 });
  expect(repo.applyOps("dev-a", [put("op-5", "dev-z", 200, "z-200")])).toEqual({ accepted: ["op-5"], rev: 3 });
  expect(recordValue(current(repo, "theme"))).toBe("z-200");

  // The same tie arriving the other way round leaves the winner alone, and equality is not newer.
  expect(repo.applyOps("dev-z", [put("op-6", "dev-a", 200, "a-200-again")])).toEqual({ accepted: ["op-6"], rev: 3 });
  expect(repo.applyOps("dev-z", [put("op-7", "dev-z", 200, "z-200-again")])).toEqual({ accepted: ["op-7"], rev: 3 });
  expect(recordValue(current(repo, "theme"))).toBe("z-200");
});

test("a tombstone follows the last-writer-wins rule like any other record", async () => {
  const { repo } = await scratch();
  repo.applyOps("dev-a", [put("op-1", "dev-a", 100, "sepia")]);

  expect(repo.applyOps("dev-a", [remove("op-2", "dev-b", 200)]).rev).toBe(2);
  const tombstone = current(repo, "theme");
  expect(tombstone?.kind).toBe("delete");
  expect((tombstone?.record as { deleted?: unknown } | undefined)?.deleted).toBe(true);

  // An older write loses to the tombstone and is accepted anyway.
  expect(repo.applyOps("dev-a", [put("op-3", "dev-z", 150, "z-150")])).toEqual({ accepted: ["op-3"], rev: 2 });
  expect(current(repo, "theme")?.kind).toBe("delete");

  // A newer write wins, whatever shape it has: F§5.9's clients may also carry a tombstone in a `put` op.
  expect(repo.applyOps("dev-a", [put("op-4", "dev-a", 300, "sepia-again")]).rev).toBe(3);
  expect(current(repo, "theme")?.kind).toBe("put");
  expect(recordValue(current(repo, "theme"))).toBe("sepia-again");
  expect(repo.applyOps("dev-a", [put("op-5", "dev-a", 400, null, { deleted: true })]).rev).toBe(4);
  expect(current(repo, "theme")?.kind).toBe("delete");
});

test("rev is strictly increasing and only a winner moves it", async () => {
  const { repo } = await scratch();
  const first = repo.applyOps("dev-a", [put("op-1", "dev-a", 100, "a-100")]);
  const second = repo.applyOps("dev-a", [put("op-2", "dev-a", 200, "a-200")]);
  const loser = repo.applyOps("dev-a", [put("op-3", "dev-a", 150, "a-150")]);
  const batch = repo.applyOps("dev-a", [put("op-4", "dev-a", 300, "a-300"), put("op-5", "dev-a", 400, "b-400", { entityId: "font" })]);

  expect([first.rev, second.rev, loser.rev, batch.rev]).toEqual([1, 2, 2, 4]);
  expect(repo.currentRev()).toBe(4);
  expect(repo.changesSince(0, 500).changes.map((op) => op.opId)).toEqual(["setting:theme:3", "setting:font:4"]);
});

test("changesSince pages with more and returns an entity changed three times once", async () => {
  const { repo } = await scratch();
  repo.applyOps("dev-a", [
    put("op-1", "dev-a", 100, "x-1"),
    put("op-2", "dev-a", 200, "x-2"),
    put("op-3", "dev-a", 300, "x-3"),
    put("op-4", "dev-a", 400, "y-1", { entityId: "font" }),
    put("op-5", "dev-a", 500, "z-1", { entityId: "speed" }),
  ]);
  expect(repo.currentRev()).toBe(5);

  const first = repo.changesSince(0, 2);
  expect(first.changes.map((op) => [op.entityId, op.ts])).toEqual([
    ["theme", 300],
    ["font", 400],
  ]);
  expect(first.nextRev).toBe(4);
  expect(first.more).toBe(true);

  const second = repo.changesSince(first.nextRev, 2);
  expect(second.changes.map((op) => op.entityId)).toEqual(["speed"]);
  expect(second.nextRev).toBe(5);
  expect(second.more).toBe(false);

  expect(repo.changesSince(second.nextRev, 2)).toEqual({ changes: [], nextRev: 5, more: false });

  // Three writes to one entity are one entry, holding the record that won rather than the first or the last.
  const theme = current(repo, "theme");
  expect(theme?.opId).toBe("setting:theme:3");
  expect(theme?.ts).toBe(300);
  expect(recordValue(theme)).toBe("x-3");
});

test("onChange fires once per committing batch and not for a batch with no winners", async () => {
  const { repo } = await scratch();
  const seen: number[] = [];
  const stop = repo.onChange((rev) => seen.push(rev));

  repo.applyOps("dev-a", [put("op-1", "dev-a", 100, "a"), put("op-2", "dev-a", 200, "b", { entityId: "font" })]);
  expect(seen).toEqual([2]);

  // Every op lost: `theme` already holds a write from ts 100, and this one is older, so nothing commits
  // and no listener hears about it.
  repo.applyOps("dev-a", [put("op-3", "dev-a", 50, "old")]);
  expect(seen).toEqual([2]);

  // A replayed opId is not a commit either.
  repo.applyOps("dev-a", [put("op-1", "dev-a", 100, "a")]);
  expect(seen).toEqual([2]);

  repo.applyOps("dev-a", [put("op-4", "dev-a", 300, "c")]);
  expect(seen).toEqual([2, 3]);

  // A listener that stopped watching is not called again, and the others still are.
  stop();
  repo.applyOps("dev-a", [put("op-5", "dev-a", 400, "d")]);
  expect(seen).toEqual([2, 3]);
});
