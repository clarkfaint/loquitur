/**
 * The extension's settings (F§10.2): one record in `chrome.storage.local`.
 *
 * They are kept in `local` and not in `sync`, because a page-reading session is a fact about this browser
 * profile — the hub it talks to, the token F§11 shares, the web app a PDF is handed to, and the reading
 * preferences the reader last chose. Everything a caller hands in or a stored record contains is validated
 * here, field by field (AGENTS.md §7): a value of the wrong shape, an absurd speed or a URL with a trailing
 * slash is normalized or replaced by its default at this boundary, never carried into a reader.
 */

import { clampRate } from "@lectern/core";

/** Everything the extension remembers between sessions. */
export interface ExtSettings {
  /** The hub's origin, for example `http://127.0.0.1:8787`, or empty while none is configured. */
  hubUrl: string;
  /** F§11's single pre-shared bearer token, or empty. */
  token: string;
  /** The web app's address, where a PDF tab is handed off (F§10.2), or empty. */
  webAppUrl: string;
  /** The `engine:voice` id F§6 names, or empty while the reader has not picked one. */
  voiceId: string;
  /** Playback speed, inside F§10.1's range. */
  rate: number;
  /** Whether the in-page widget appears on its own when a page has readable text. */
  autoShowWidget: boolean;
  /** Hosts the reader has switched the extension off for, in the order they were added. */
  disabledSites: string[];
  /** Whether skipped furniture (headers, footers, footnotes) is left unread (F§5.4). */
  skipFurniture: boolean;
}

/** Where the record lives in `chrome.storage.local`. */
export const SETTINGS_KEY = "lectern.extension.settings";

/** What the extension holds before anything has been saved: no hub, no voice, the cache's speed. */
export const DEFAULT_EXT_SETTINGS: ExtSettings = {
  hubUrl: "",
  token: "",
  webAppUrl: "",
  voiceId: "",
  rate: 1,
  autoShowWidget: false,
  disabledSites: [],
  skipFurniture: true,
};

/** The one field a patch may carry. */
export type ExtSettingsPatch = Partial<ExtSettings>;

/** A URL as the extension stores it: without surrounding whitespace and without a trailing slash. */
export function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

/** Whether a string is the absolute `http(s)` address a hub client can be built from (F§7.1's own rule). */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\/[^\s/]+/u.test(value);
}

/**
 * The host permission pattern a hub URL needs: `http://127.0.0.1:8787/*`. `null` when the URL is not one the
 * extension can ask permission for, so a caller refuses instead of requesting an origin it guessed.
 */
export function originPattern(hubUrl: string): string | null {
  if (!isHttpUrl(hubUrl)) return null;
  try {
    return `${new URL(hubUrl).origin}/*`;
  } catch {
    return null;
  }
}

/** A host name as the disable list keeps it: trimmed, lower case, non-empty, each host once. */
export function normalizeDisabledSites(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const hosts: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const host = entry.trim().toLowerCase();
    if (host === "" || hosts.includes(host)) continue;
    hosts.push(host);
  }
  return hosts;
}

/** A stored string field, or the default when the record does not hold one. */
function stringFrom(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** A stored boolean field, or the default when the record does not hold one. */
function booleanFrom(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** A stored speed, clamped into F§10.1's range, or the default when the record does not hold a number. */
function rateFrom(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clampRate(value) : fallback;
}

/** The settings a stored value means, every field validated against the shape it must have. */
export function settingsFrom(value: unknown): ExtSettings {
  if (typeof value !== "object" || value === null) return DEFAULT_EXT_SETTINGS;
  const record = value as Record<string, unknown>;
  return {
    hubUrl: normalizeUrl(stringFrom(record.hubUrl, DEFAULT_EXT_SETTINGS.hubUrl)),
    token: stringFrom(record.token, DEFAULT_EXT_SETTINGS.token).trim(),
    webAppUrl: normalizeUrl(stringFrom(record.webAppUrl, DEFAULT_EXT_SETTINGS.webAppUrl)),
    voiceId: stringFrom(record.voiceId, DEFAULT_EXT_SETTINGS.voiceId),
    rate: rateFrom(record.rate, DEFAULT_EXT_SETTINGS.rate),
    autoShowWidget: booleanFrom(record.autoShowWidget, DEFAULT_EXT_SETTINGS.autoShowWidget),
    disabledSites: normalizeDisabledSites(record.disabledSites),
    skipFurniture: booleanFrom(record.skipFurniture, DEFAULT_EXT_SETTINGS.skipFurniture),
  };
}

/** The settings a patch produces: every field it names normalized, every field it does not, kept. */
export function applyPatch(current: ExtSettings, patch: ExtSettingsPatch): ExtSettings {
  return {
    hubUrl: patch.hubUrl === undefined ? current.hubUrl : normalizeUrl(patch.hubUrl),
    token: patch.token === undefined ? current.token : patch.token.trim(),
    webAppUrl: patch.webAppUrl === undefined ? current.webAppUrl : normalizeUrl(patch.webAppUrl),
    voiceId: patch.voiceId === undefined ? current.voiceId : patch.voiceId,
    rate: patch.rate === undefined ? current.rate : clampRate(patch.rate),
    autoShowWidget: patch.autoShowWidget === undefined ? current.autoShowWidget : patch.autoShowWidget,
    disabledSites: patch.disabledSites === undefined ? current.disabledSites : normalizeDisabledSites(patch.disabledSites),
    skipFurniture: patch.skipFurniture === undefined ? current.skipFurniture : patch.skipFurniture,
  };
}

/** The settings `chrome.storage.local` holds, or the defaults when it holds nothing usable. */
export async function getSettings(): Promise<ExtSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return settingsFrom(stored[SETTINGS_KEY]);
}

/** Apply a patch: normalize it, write the record, and answer with what was written. */
export async function setSettings(patch: ExtSettingsPatch): Promise<ExtSettings> {
  const next = applyPatch(await getSettings(), patch);
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/** Watch the record. The returned function stops watching. */
export function onSettingsChanged(listener: (settings: ExtSettings) => void): () => void {
  const handle = (changes: { [key: string]: chrome.storage.StorageChange }): void => {
    if (changes[SETTINGS_KEY] === undefined) return;
    listener(settingsFrom(changes[SETTINGS_KEY].newValue));
  };
  chrome.storage.local.onChanged.addListener(handle);
  return () => chrome.storage.local.onChanged.removeListener(handle);
}
