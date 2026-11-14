/**
 * This installation's identity (F§5.9): the `deviceId` every op it appends is stamped with, created once
 * and kept in the database's `meta` store so the same installation keeps the same name across reloads.
 *
 * The name matters to the last-writer-wins rule, which breaks a tie between two records with the same
 * timestamp by comparing their `deviceId` strings. Two tabs of one installation must therefore agree on
 * it, which is why the identifier is created inside the read-write transaction that reads it: a second
 * tab opening the database a moment later waits for that transaction and finds the value already there,
 * rather than minting a rival identity and making every later write a coin toss.
 */

import type { IDBPDatabase } from "idb";
import type { LecternDbSchema } from "./idb-schema";

/** The `meta` key this installation's identifier is kept under. */
const DEVICE_ID_KEY = "deviceId";

/** Bytes of randomness behind a fallback identifier. */
const RANDOM_BYTES = 16;

/**
 * `getDeviceId(db)` — the identifier stored for this installation, creating one on first use. Every later
 * call — in this tab, in another one, after a reload — answers the same string.
 */
export async function getDeviceId(db: IDBPDatabase<LecternDbSchema>): Promise<string> {
  const tx = db.transaction("meta", "readwrite");
  const meta = tx.objectStore("meta");
  const existing = await meta.get(DEVICE_ID_KEY);
  if (typeof existing === "string" && existing.length > 0) {
    await tx.done;
    return existing;
  }
  const created = randomDeviceId();
  await meta.put(created, DEVICE_ID_KEY);
  await tx.done;
  return created;
}

/**
 * A random identifier. `crypto.randomUUID()` is the first choice because it is a name collision cannot
 * happen to; the random-bytes path is there for a context that exposes `crypto` without it.
 */
function randomDeviceId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  let hex = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(RANDOM_BYTES))) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}
