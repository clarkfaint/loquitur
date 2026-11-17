/**
 * The hub's record repository (F§8.2, F§8.4): the one place a pushed op is applied, the change log a pull
 * pages through, and the notification the change feed waits on.
 *
 * The hub is the meeting point, not the owner (F§8.1). It holds one row per entity — the record that won
 * the last-writer-wins rule of F§5.9 — and a log of the winning ops in the order it accepted them, so a
 * device that was away asks for what changed after the `rev` it last saw and receives each changed entity
 * once, as it stands now.
 *
 * Four decisions the contract leaves to this module:
 *
 * - **The op's own stamp decides.** F§5.9's rule compares `(ts, deviceId)`, and the device that made an op
 *   stamped it; a hub that substituted anything else for that stamp could reach a different winner than the
 *   devices that hold the same ops, which is exactly the divergence the rule exists to prevent. The
 *   `deviceId` a push is made under is the fallback for an op that carries none (F§5.9's `deviceId` is a
 *   plain string, so the empty one is representable) and is otherwise unused.
 * - **A batch is one transaction.** Every op of a push is applied or none is, so a `rev` a client stored as
 *   its cursor always describes a batch it can also see in `changes`.
 * - **An op that lost is still accepted.** F§8.2 returns every `opId` of the request in `accepted` — a
 *   client whose op was silently dropped would believe it had synced — and the op ledger remembers it, so
 *   re-pushing it changes nothing.
 * - **A pulled op is built from the record that won.** The `changes` table holds no record; the row a page
 *   answers with is `records`'s current winner, stamped with the writer that established it. Its `opId` is
 *   derived from the change (`entity:entityId:rev`) because the hub does not keep the winning op's own id —
 *   a client applies pulled ops through `applyRemote`, which reads the stamp and never the `opId`.
 */

import { isNewer, type Op, OpSchema } from "@lectern/core";
import type { HubDatabase, HubStatement } from "./database";

/** What one push left behind (F§8.2): every opId it carried, and the `rev` the batch left the log at. */
export interface ApplyResult {
  accepted: string[];
  rev: number;
}

/** One page of F§8.2's pull: the changed entities, the cursor to store, and whether another page waits. */
export interface ChangesPage {
  changes: Op[];
  nextRev: number;
  more: boolean;
}

/** What a route is given (F§8.2): the four operations of the record store and the change log. */
export interface RecordsRepo {
  /** Apply one device's pending ops (F§8.2), in one transaction, and answer what the push left behind. */
  applyOps(deviceId: string, ops: readonly Op[]): ApplyResult;
  /** The changes after `rev`, one entry per changed entity, at most `limit` of them (F§8.2). */
  changesSince(rev: number, limit: number): ChangesPage;
  /** The hub's current `rev`: the newest change it has accepted, or 0 before the first one (F§8.3). */
  currentRev(): number;
  /** Watch for a commit that increased `rev` (F§8.3). Returns the function that stops watching. */
  onChange(listener: (rev: number) => void): () => void;
}

/** A row of F§8.4's `records`: the winning record and the stamp that made it the winner. */
interface StoredRecord {
  ts: number;
  device_id: string;
  deleted: number;
  json: string;
}

/** One entity's latest change, as F§8.2's pull reads it: the entity, and the `rev` it last changed at. */
interface ChangeRow {
  entity: string;
  entity_id: string;
  rev: number;
}

/** The statements this repository runs, by name. Prepared once each, on first use. */
const SQL = {
  stored: "SELECT ts, device_id, deleted, json FROM records WHERE entity = ? AND entity_id = ?",
  seen: "SELECT op_id FROM seen_ops WHERE op_id = ?",
  remember: "INSERT OR IGNORE INTO seen_ops (op_id, received_at) VALUES (?, ?)",
  write: `INSERT INTO records (entity, entity_id, ts, device_id, deleted, json) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (entity, entity_id) DO UPDATE SET
            ts = excluded.ts, device_id = excluded.device_id, deleted = excluded.deleted, json = excluded.json`,
  change: "INSERT INTO changes (entity, entity_id) VALUES (?, ?)",
  rev: "SELECT COALESCE(MAX(rev), 0) AS rev FROM changes",
  page: `SELECT entity, entity_id, MAX(rev) AS rev FROM changes
         WHERE rev > ? GROUP BY entity, entity_id ORDER BY rev ASC LIMIT ?`,
} as const;

/**
 * Whether an op leaves a tombstone: F§5.9's delete op carries the record with `deleted: true`, and a
 * client may also write a tombstone through a `put` op, so both say the same thing and both are stored.
 */
function isTombstone(op: Op): boolean {
  if (op.kind === "delete") return true;
  const record = op.record;
  return typeof record === "object" && record !== null && (record as { deleted?: unknown }).deleted === true;
}

/**
 * `createRecordsRepo(db)` — F§8.2's repository over an open database.
 *
 * The statements are prepared on first use rather than here, so a repository built before `migrate` has run
 * still works once the schema exists; better-sqlite3 reuses one prepared statement for any number of calls,
 * and its parameters are bound per call.
 *
 * The listeners are held per repository, not per module: a hub that is built and closed in a test leaves no
 * callback behind for the next one, and the change feed of a later unit subscribes to the context it was
 * handed.
 */
export function createRecordsRepo(db: HubDatabase): RecordsRepo {
  const listeners = new Set<(rev: number) => void>();
  const prepared = new Map<string, HubStatement>();

  /** One prepared statement per SQL text. */
  function statement(sql: string): HubStatement {
    const cached = prepared.get(sql);
    if (cached !== undefined) return cached;
    const ready = db.prepare(sql);
    prepared.set(sql, ready);
    return ready;
  }

  /** The record the hub currently holds for one entity, or nothing when it holds none. */
  function storedRecord(entity: string, entityId: string): StoredRecord | undefined {
    return statement(SQL.stored).get(entity, entityId) as StoredRecord | undefined;
  }

  /** The hub's current `rev` (F§8.3): 0 until the first change is accepted. */
  function currentRev(): number {
    const row = statement(SQL.rev).get() as { rev: number } | undefined;
    return row === undefined ? 0 : row.rev;
  }

  /**
   * One changed entity as the op a client applies (F§8.2). The record that won is read back and validated
   * with F§5.9's own `OpSchema`, so what a pull answers is what a client's store can apply; a row this
   * design could not have written is skipped rather than failing the whole page.
   */
  function opFor(row: ChangeRow): Op | null {
    const stored = storedRecord(row.entity, row.entity_id);
    if (stored === undefined) return null;
    let record: unknown;
    try {
      record = JSON.parse(stored.json) as unknown;
    } catch {
      return null;
    }
    const parsed = OpSchema.safeParse({
      opId: `${row.entity}:${row.entity_id}:${row.rev}`,
      deviceId: stored.device_id,
      entity: row.entity,
      entityId: row.entity_id,
      kind: stored.deleted === 1 ? "delete" : "put",
      ts: stored.ts,
      record,
    });
    return parsed.success ? parsed.data : null;
  }

  return {
    applyOps: (deviceId: string, ops: readonly Op[]): ApplyResult => {
      const accepted: string[] = [];
      const commit = db.transaction((batch: readonly Op[]): boolean => {
        let committed = false;
        for (const incoming of batch) {
          const op = OpSchema.parse(incoming);
          accepted.push(op.opId);
          if (statement(SQL.seen).get(op.opId) !== undefined) continue;
          statement(SQL.remember).run(op.opId, Date.now());
          const writer = op.deviceId === "" ? deviceId : op.deviceId;
          const stored = storedRecord(op.entity, op.entityId);
          if (stored !== undefined && !isNewer({ ts: op.ts, deviceId: writer }, { ts: stored.ts, deviceId: stored.device_id })) {
            continue;
          }
          statement(SQL.write).run(op.entity, op.entityId, op.ts, writer, isTombstone(op) ? 1 : 0, JSON.stringify(op.record) ?? "null");
          statement(SQL.change).run(op.entity, op.entityId);
          committed = true;
        }
        return committed;
      });

      const committed = commit(ops);
      const rev = currentRev();
      if (committed) for (const listener of listeners) listener(rev);
      return { accepted, rev };
    },

    changesSince: (rev: number, limit: number): ChangesPage => {
      // A page always carries at least one change when one is waiting: F§8.2's pull asks for a positive
      // limit (the route's own query schema enforces one), and a client that asked for none would
      // otherwise be told `more` forever.
      const size = Math.max(1, Math.trunc(limit));
      const rows = statement(SQL.page).all(rev, size + 1) as ChangeRow[];
      const page = rows.slice(0, size);
      const changes: Op[] = [];
      for (const row of page) {
        const op = opFor(row);
        if (op !== null) changes.push(op);
      }
      const last = page[page.length - 1];
      return { changes, nextRev: last === undefined ? rev : last.rev, more: rows.length > page.length };
    },

    currentRev,

    onChange: (listener: (rev: number) => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
