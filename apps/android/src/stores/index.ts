/**
 * The app's stores (F§5.9, F§10.4): one database, one blob directory, and this installation's identity.
 *
 * `getStores()` is the only place a connection is opened. It runs `migrate` before it hands anything back, so
 * every caller starts on the current schema, and it memoizes the promise — the app's screens call it freely,
 * and the second call joins the first rather than opening a second connection to the same file.
 *
 * The `deviceId` is F§5.9's stamp for every op this installation appends. It is created once, with
 * `expo-crypto`, and kept in the same `meta` table the last-writer-wins stamps live in, so an installation
 * keeps its name across restarts. Memoizing the promise is what makes "once" true: two screens asking at the
 * same moment wait on one creation instead of minting two identities, which would turn every tie between two
 * records into a coin toss.
 */

import type { BlobCache, LibraryStore } from "@lectern/core";
import { createFsBlobCache, createSqlLibraryStore, migrate, type SqlDriver } from "@lectern/store-sql";
import * as Crypto from "expo-crypto";
import { createExpoBlobFs } from "./expo-blob-fs";
import { openExpoSqliteDriver } from "./expo-sqlite-driver";

/** The database file this installation keeps its library in. */
export const DATABASE_NAME = "lectern.db";

/** The `meta` key this installation's identifier is kept under. */
const DEVICE_ID_KEY = "deviceId";

/** Everything the app needs to read, play and file a document (F§5.9). */
export interface Stores {
  store: LibraryStore;
  cache: BlobCache;
  deviceId: string;
}

/** The one connection this app run has, from the first caller to the last. */
let open: Promise<Stores> | null = null;

/** A stored string, or `null` when the column holds something else — or is not JSON at all. */
function storedString(value: string): string | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" && parsed !== "" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * This installation's identifier, created the first time it is asked for.
 *
 * A value the table already holds wins, so the identity survives a restart; only a column that is absent or
 * unreadable is replaced, which is what makes a damaged row a new identity rather than a crash on start-up.
 */
async function readOrCreateDeviceId(driver: SqlDriver): Promise<string> {
  const rows = await driver.all<{ value: string }>("SELECT value FROM meta WHERE key = ?", [DEVICE_ID_KEY]);
  const stored = rows[0];
  const existing = stored === undefined ? null : storedString(stored.value);
  if (existing !== null) return existing;
  const created = Crypto.randomUUID();
  await driver.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [DEVICE_ID_KEY, JSON.stringify(created)]);
  return created;
}

/**
 * `getStores()` — open the library, bring its schema up to date, and answer the store, the blob cache and
 * this installation's identity. Repeated calls answer the same objects.
 */
export async function getStores(): Promise<Stores> {
  if (open === null) {
    open = (async (): Promise<Stores> => {
      const driver = await openExpoSqliteDriver(DATABASE_NAME);
      await migrate(driver);
      const deviceId = await readOrCreateDeviceId(driver);
      return {
        store: createSqlLibraryStore({ driver, deviceId, now: () => Date.now(), newId: () => Crypto.randomUUID() }),
        cache: createFsBlobCache({ fs: await createExpoBlobFs(), driver, now: () => Date.now() }),
        deviceId,
      };
    })();
  }
  return open;
}
