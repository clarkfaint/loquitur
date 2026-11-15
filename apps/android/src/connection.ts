/**
 * The hub connection (F§11, F§7.2).
 *
 * Two values describe the reader's hub: the address it answers on and the one pre-shared bearer token. The
 * token is a credential, so both live in the platform's secure store (`expo-secure-store`, which is
 * the Android Keystore-backed `EncryptedSharedPreferences` on device) and never in plain file storage;
 * F§11's whole model is that one token reaches one hub, so there is no user, no session and no refresh.
 *
 * Everything a caller hands in passes a check here — a hub address has to be an `http(s)` URL without a
 * trailing slash and a token has to be non-empty — because the values come from a deep link or a text field
 * and a reader must see a refusal rather than a request that goes nowhere (AGENTS.md §7's boundary rule).
 *
 * `createClient()` builds F§7.2's typed client over `expo/fetch`, the platform's own HTTP implementation:
 * the client itself is isomorphic and takes its transport as an argument, so nothing else in the app knows
 * which `fetch` is in use.
 */

import { createHubClient, type HubClient } from "@lectern/api-client";
import { fetch as expoFetch } from "expo/fetch";
import * as SecureStore from "expo-secure-store";

/** A hub connection: F§11's origin and token, both already validated. */
export interface Connection {
  hubUrl: string;
  token: string;
}

/** The secure-store key holding the hub's address. */
export const HUB_URL_KEY = "lectern.hub-url";

/** The secure-store key holding F§11's bearer token. */
export const TOKEN_KEY = "lectern.hub-token";

/**
 * `expo/fetch`'s own signature, from `expo@58.0.25`'s `build/winter/fetch/fetch.d.ts`:
 *
 *   fetch(input: string | URL | FetchRequestLike, init?: FetchRequestInit): Promise<FetchResponse>
 *
 * The client asks for the platform `fetch` type, and the two declarations differ only in the names Expo
 * gives the same shapes — a `URL` input and the same init fields — so the transport is handed over through
 * this one alias rather than being wrapped in a second function that would only restate the call.
 */
const hubTransport: typeof fetch = expoFetch as unknown as typeof fetch;

/** The connection in memory, so a screen does not read the secure store on every keystroke. */
let cached: Connection | null = null;

/** Whether the secure store has been read at least once in this app run. */
let loaded = false;

/** Everything waiting to hear that the connection changed. */
const listeners = new Set<(connection: Connection | null) => void>();

/**
 * The address as the app stores it: `http(s)` only, no query and no fragment, no trailing slash — so two
 * spellings of one hub compare equal, which is what makes a re-save a no-op and a diagnostic message honest.
 */
export function normalizeHubUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.search !== "" || parsed.hash !== "") return null;
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${path}`;
}

/**
 * Two stored strings as a connection, or `null` when the pair does not describe one. A record written by an
 * older build, a half-written pair and an address no request can reach all read as "no hub is configured".
 */
export function parseConnection(hubUrl: string | null, token: string | null): Connection | null {
  if (hubUrl === null || token === null) return null;
  const normalized = normalizeHubUrl(hubUrl);
  const trimmed = token.trim();
  if (normalized === null || trimmed === "") return null;
  return { hubUrl: normalized, token: trimmed };
}

/** The connection the reader last saved, or `null` while none is configured. Reads the store once. */
export async function getConnection(): Promise<Connection | null> {
  if (!loaded) {
    const hubUrl = await SecureStore.getItemAsync(HUB_URL_KEY);
    const token = await SecureStore.getItemAsync(TOKEN_KEY);
    cached = parseConnection(hubUrl, token);
    loaded = true;
  }
  return cached;
}

/**
 * Save a connection: both values are validated first, then written to the secure store, then handed to every
 * listener. A refusal throws before anything is written, so a bad deep link cannot leave half a connection
 * behind.
 */
export async function setConnection(next: Connection): Promise<void> {
  const connection = parseConnection(next.hubUrl, next.token);
  if (connection === null) {
    throw new Error("the hub address must be an http(s) URL and the token must not be empty");
  }
  await SecureStore.setItemAsync(HUB_URL_KEY, connection.hubUrl);
  await SecureStore.setItemAsync(TOKEN_KEY, connection.token);
  cached = connection;
  loaded = true;
  for (const listener of listeners) listener(connection);
}

/** Watch the connection: the listener runs on every save, and returns its own unsubscribe. */
export function onConnectionChanged(listener: (connection: Connection | null) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * F§7.2's routes as a typed client over the saved connection. The token travels in the `Authorization`
 * header of every request and never in a URL.
 */
export async function createClient(): Promise<HubClient> {
  const connection = await getConnection();
  if (connection === null) {
    throw new Error("the hub is not configured yet — connect from Settings or a lectern://setup link");
  }
  return createHubClient({ baseUrl: connection.hubUrl, token: connection.token, fetch: hubTransport });
}
