/**
 * The app's settings (F§10.1), in two halves that are kept in two places for a reason:
 *
 * - the **connection** — the hub's address and F§11's shared token — lives in `localStorage`, because it is
 *   what the app needs before any database is open, and reading it must not be a round trip.
 * - the **preferences** live in the `LibraryStore` (F§5.9), one record per field, so they travel to the
 *   reader's other devices with the rest of the library (F§8) and a device that changes the speed cannot
 *   overwrite another device's theme through the last-writer-wins rule. A single `preferences` record would
 *   make every setting a competitor of every other one.
 *
 * Everything a caller hands in is validated here (AGENTS.md §7): a stored value of the wrong shape, an
 * absurd speed or a URL with a trailing slash is normalized or refused at this boundary, never carried into
 * the player.
 */

import type { LibraryStore } from "@lectern/core";
import { create } from "zustand";

/** A hub connection: the hub's origin, and the one bearer token F§11 shares with it. */
export interface Connection {
  hubUrl: string;
  token: string;
}

/** F§10.1's speed range, and the step its slider moves in. */
export const MIN_RATE = 0.5;
export const MAX_RATE = 5;

/** The themes a reader can pin; `system` follows the operating system, which is the stylesheet's default. */
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

/** The reader's preferences: the values a document is read with (F§5.6, F§5.9). */
export interface Preferences {
  /** The `engine:voice` id F§6 names, or empty while the reader has not picked one. */
  voiceId: string;
  /** Playback speed, inside F§10.1's range. */
  rate: number;
  /** Whether skipped furniture (headers, footers, footnotes) is left unread (F§5.4). */
  skipFurniture: boolean;
  /** Whether citation markers inside the text are left unread (F§5.4). */
  skipCitations: boolean;
  /** How far ahead of the sink's position the highlight is drawn (F§5.6(d)), in milliseconds. */
  lookaheadMs: number;
  /** The theme to pin, or `system` to follow the operating system. */
  theme: Theme;
  /** How many bytes of synthesized audio the cache may hold (F§5.9). */
  cacheLimitBytes: number;
}

/** A patch to the settings: either half, with only the fields the caller means to change. */
export interface SettingsPatch {
  connection?: Partial<Connection>;
  preferences?: Partial<Preferences>;
}

/** `localStorage`'s key for the connection (F§10.1). */
export const CONNECTION_KEY = "lectern.connection";

/** Where one preference is kept in the `LibraryStore`: one `setting` record per field. */
export const PREFERENCE_KEYS: Record<keyof Preferences, string> = {
  voiceId: "pref:voiceId",
  rate: "pref:rate",
  skipFurniture: "pref:skipFurniture",
  skipCitations: "pref:skipCitations",
  lookaheadMs: "pref:lookaheadMs",
  theme: "pref:theme",
  cacheLimitBytes: "pref:cacheLimitBytes",
};

/** The attribute `@lectern/ui-web/styles.css` reads to pin a theme instead of following the system. */
export const THEME_ATTRIBUTE = "data-lectern-theme";

/** The default audio-cache limit: a quarter of a gigabyte, which is a few hours of speech. */
export const DEFAULT_CACHE_LIMIT_BYTES = 256 * 1024 * 1024;

/** What a connection holds before the reader has saved one. F§10.1: the default is empty — no hub is assumed. */
export const DEFAULT_CONNECTION: Connection = { hubUrl: "", token: "" };

/** What the preferences hold before the library has any: F§5.8's policy, read at the speed a cache serves. */
export const DEFAULT_PREFERENCES: Preferences = {
  voiceId: "",
  rate: 1,
  skipFurniture: true,
  skipCitations: true,
  lookaheadMs: 0,
  theme: "system",
  cacheLimitBytes: DEFAULT_CACHE_LIMIT_BYTES,
};

/** The one thing the settings need from the browser to keep a connection: a key/value store. */
export interface ConnectionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The page's own `localStorage`, used unless a caller hands in another store. */
const browserStorage: ConnectionStorage = {
  getItem: (key) => globalThis.localStorage.getItem(key),
  setItem: (key, value) => globalThis.localStorage.setItem(key, value),
};

/** A hub URL as the app stores it: without surrounding whitespace and without a trailing slash. */
export function normalizeHubUrl(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

/** Whether a string is the absolute `http(s)` address a hub client can be built from (F§7.1's own rule). */
export function isHubUrl(value: string): boolean {
  return /^https?:\/\/[^\s/]+/u.test(value);
}

/** What is wrong with a connection, or `null` when the app can use it. */
export function validateConnection(connection: Connection): string | null {
  if (connection.hubUrl === "") return "a hub URL is required";
  if (!isHubUrl(connection.hubUrl)) return "the hub URL must be an absolute http or https address";
  if (connection.token === "") return "the token is required";
  return null;
}

/** A connection as the app keeps it: the URL normalized, the token trimmed of surrounding whitespace. */
export function normalizeConnection(connection: Connection): Connection {
  return { hubUrl: normalizeHubUrl(connection.hubUrl), token: connection.token.trim() };
}

/**
 * A speed inside F§10.1's range, at the tenth its slider moves in. A value that is not a number at all is the
 * default rather than a rejection: the caller is a slider or a stored record, and neither can be argued with.
 */
export function clampRate(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PREFERENCES.rate;
  const clamped = Math.min(MAX_RATE, Math.max(MIN_RATE, value));
  return Math.round(clamped * 10) / 10;
}

/** A whole, non-negative number of bytes, or the default when the stored value is not one. */
function cacheLimitFrom(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return DEFAULT_CACHE_LIMIT_BYTES;
  return Math.round(value);
}

/** A whole, non-negative number of milliseconds, or the default when the stored value is not one. */
function lookaheadFrom(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return DEFAULT_PREFERENCES.lookaheadMs;
  return Math.round(value);
}

/** Whether a value is one of the themes the app offers. */
export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/** A connection rebuilt from whatever `JSON.parse` produced, field by field. */
function connectionFrom(value: unknown): Connection {
  if (typeof value !== "object" || value === null) return DEFAULT_CONNECTION;
  const record = value as Record<string, unknown>;
  return {
    hubUrl: typeof record.hubUrl === "string" ? normalizeHubUrl(record.hubUrl) : "",
    token: typeof record.token === "string" ? record.token : "",
  };
}

/** The preferences a set of stored values means, each field validated against the shape it must have. */
function preferencesFrom(stored: Partial<Record<keyof Preferences, unknown>>, base: Preferences): Preferences {
  return {
    voiceId: typeof stored.voiceId === "string" ? stored.voiceId : base.voiceId,
    rate: typeof stored.rate === "number" ? clampRate(stored.rate) : base.rate,
    skipFurniture: typeof stored.skipFurniture === "boolean" ? stored.skipFurniture : base.skipFurniture,
    skipCitations: typeof stored.skipCitations === "boolean" ? stored.skipCitations : base.skipCitations,
    lookaheadMs: lookaheadFrom(stored.lookaheadMs ?? base.lookaheadMs),
    theme: isTheme(stored.theme) ? stored.theme : base.theme,
    cacheLimitBytes: cacheLimitFrom(stored.cacheLimitBytes ?? base.cacheLimitBytes),
  };
}

/** The connection `localStorage` holds, or the empty one when it holds nothing usable. */
export function readConnection(storage: ConnectionStorage = browserStorage): Connection {
  const raw = storage.getItem(CONNECTION_KEY);
  if (raw === null) return DEFAULT_CONNECTION;
  try {
    return connectionFrom(JSON.parse(raw));
  } catch {
    return DEFAULT_CONNECTION;
  }
}

/** Keep a connection, normalized, under F§10.1's key. */
export function writeConnection(connection: Connection, storage: ConnectionStorage = browserStorage): Connection {
  const normalized = normalizeConnection(connection);
  storage.setItem(CONNECTION_KEY, JSON.stringify(normalized));
  return normalized;
}

/**
 * Apply a theme to the document's root element: `system` removes the attribute, which is what leaves the
 * stylesheet following the operating system's own preference.
 */
export function applyTheme(theme: Theme, root: HTMLElement): void {
  if (theme === "system") {
    root.removeAttribute(THEME_ATTRIBUTE);
    return;
  }
  root.setAttribute(THEME_ATTRIBUTE, theme);
}

/** The settings, and the two calls that move them. */
export interface SettingsState {
  connection: Connection;
  preferences: Preferences;
  /** Whether `load` has read the library's preferences. */
  loaded: boolean;
  /** Read the connection from its storage and every preference from the library store. */
  load(library: LibraryStore): Promise<void>;
  /** Apply a patch: normalize and validate it, write it through, and adopt it as the current settings. */
  update(patch: SettingsPatch): Promise<void>;
}

/** The library store `load` was last given, which is what `update` writes preferences through. */
let library: LibraryStore | null = null;

/** The preference fields a patch names. */
function fieldsOf(patch: Partial<Preferences>): (keyof Preferences)[] {
  return Object.keys(patch) as (keyof Preferences)[];
}

/**
 * `useSettingsStore` — the app's one settings store.
 *
 * The connection starts from what `localStorage` holds, because it must be available on the first render;
 * the preferences start at their defaults and arrive with `load`, which needs the library store to be open.
 * `update` adopts the new values before it writes them, so a controlled input never lags a keystroke behind
 * an IndexedDB transaction, and the write-through follows for whichever half the patch touched.
 */
export const useSettingsStore = create<SettingsState>()((set, get) => ({
  connection: readConnection(),
  preferences: DEFAULT_PREFERENCES,
  loaded: false,

  async load(source) {
    library = source;
    const fields = Object.keys(PREFERENCE_KEYS) as (keyof Preferences)[];
    const stored: Partial<Record<keyof Preferences, unknown>> = {};
    for (const field of fields) {
      const value = await source.getSetting<unknown>(PREFERENCE_KEYS[field]);
      if (value !== null) stored[field] = value;
    }
    set({ connection: readConnection(), preferences: preferencesFrom(stored, DEFAULT_PREFERENCES), loaded: true });
  },

  async update(patch) {
    const connection = patch.connection === undefined ? get().connection : writeConnection({ ...get().connection, ...patch.connection });
    const preferences =
      patch.preferences === undefined
        ? get().preferences
        : preferencesFrom({ ...get().preferences, ...patch.preferences }, get().preferences);

    set({ connection, preferences });

    if (patch.preferences === undefined) return;
    if (library === null) {
      throw new Error("settings were updated before they were loaded — call load(library) first (F§10.1)");
    }
    for (const field of fieldsOf(patch.preferences)) {
      await library.setSetting(PREFERENCE_KEYS[field], preferences[field]);
    }
  },
}));
