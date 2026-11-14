/**
 * The app's composition root (F§10.1): everything a screen needs, built once and handed over.
 *
 * Two things are deliberately separate here:
 *
 * - the **storage** — the `lectern` database and the two stores over it — needs no hub, so the app can read
 *   the reader's preferences before any connection is saved. That is what `getStorage` is for, and what
 *   `main.tsx` calls first.
 * - the **hub client and the chunk source** are built from the saved connection, so they are rebuilt when the
 *   connection changes: a reader who points the app at another hub talks to that hub from the next call on,
 *   with no reload. `getServices` answers with the objects of the connection it saw, and the same objects
 *   again while the connection stands, so a screen that asks twice does not hold two clients.
 *
 * Nothing here reads the environment or hard-codes a hub: the connection is the reader's, kept in settings
 * (F§10.1), and with none saved there is no client to build — the shell is on the settings screen anyway.
 */

import { type CachingChunkSource, createCachingChunkSource, createHubClient, type HubClient } from "@lectern/api-client";
import type { BlobCache, LibraryStore } from "@lectern/core";
import { createIdbBlobCache, createIdbLibraryStore, getDeviceId, openLecternDb } from "@lectern/ui-web";
import { useSettingsStore } from "./settings/settings";

/** The library database and the two stores over it, none of which depends on a hub being configured. */
export interface Storage {
  /** The `lectern` database, as `@lectern/ui-web` hands it over — one connection, whoever asks. */
  db: Awaited<ReturnType<typeof openLecternDb>>;
  /** The records a reader owns (F§5.9). */
  store: LibraryStore;
  /** The bytes a reader plays (F§5.9). */
  cache: BlobCache;
}

/** Everything a screen needs, once a connection is configured. */
export interface Services extends Storage {
  /** The hub's typed client (F§7.2). */
  client: HubClient;
  /** F§5.8's chunk source over the hub client and the cache. */
  chunks: CachingChunkSource;
}

/** The failure a caller sees when it asks for services before a connection is saved. */
const NO_CONNECTION = "no hub is configured — save a hub URL and token in #/settings (F§10.1)";

/** The database connection is the app's for as long as the page lives, whoever asks for it. */
let storage: Promise<Storage> | null = null;

/** The services of one connection, kept so the same objects serve until the connection changes. */
let cached: { signature: string; services: Services } | null = null;

/** The identity of a connection: either half changing rebuilds the client and the chunk source. */
function signatureOf(hubUrl: string, token: string): string {
  return `${hubUrl}\u0000${token}`;
}

/** Open the database and build the two stores over it. */
async function openStorage(): Promise<Storage> {
  const db = await openLecternDb();
  const deviceId = await getDeviceId(db);
  return {
    db,
    store: createIdbLibraryStore({ db, deviceId, now: () => Date.now(), newId: () => crypto.randomUUID() }),
    cache: createIdbBlobCache({ db, now: () => Date.now() }),
  };
}

/**
 * `getStorage()` — the database and the two stores over it, opened on first use.
 *
 * It needs no connection, which is why the shell can read the reader's saved preferences before a hub is
 * configured, and why the database survives a connection change with its store and cache intact.
 */
export function getStorage(): Promise<Storage> {
  storage ??= openStorage();
  return storage;
}

/**
 * `getServices()` — the whole composition, for the connection the settings hold right now.
 *
 * A changed connection rebuilds the client and the chunk source; the database, the record store and the cache
 * are the app's own and are handed over again. A caller that asks while the connection still stands receives
 * the objects it received before.
 */
export async function getServices(): Promise<Services> {
  const connection = useSettingsStore.getState().connection;
  if (connection.hubUrl === "") throw new Error(NO_CONNECTION);

  const signature = signatureOf(connection.hubUrl, connection.token);
  if (cached !== null && cached.signature === signature) return cached.services;

  const opened = await getStorage();
  const client = createHubClient({
    baseUrl: connection.hubUrl,
    token: connection.token,
    // F§11: the token rides in a header, never in a URL. The transport is the page's own `fetch`, called
    // as a method of the global object so a browser does not refuse it as an illegal invocation.
    fetch: (input, init) => globalThis.fetch(input, init),
  });
  const services: Services = { ...opened, client, chunks: createCachingChunkSource({ client, cache: opened.cache }) };
  cached = { signature, services };
  return services;
}
