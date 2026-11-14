/**
 * The settings tests (F§10.1): the defaults, the two halves' persistence, and the validation that keeps a bad
 * value out of the player — a speed outside F§10.1's range, a hub URL that kept its trailing slash, and a
 * stored record whose shape is not what the app writes.
 *
 * The library store is `@lectern/core`'s in-memory one rather than IndexedDB: these tests are about the
 * settings' own rules, and the durable store has its own conformance suite (F§5.9).
 */

import { createMemoryLibraryStore, type LibraryStore } from "@lectern/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyTheme,
  CONNECTION_KEY,
  clampRate,
  DEFAULT_CACHE_LIMIT_BYTES,
  DEFAULT_CONNECTION,
  DEFAULT_PREFERENCES,
  isHubUrl,
  isTheme,
  normalizeConnection,
  normalizeHubUrl,
  PREFERENCE_KEYS,
  readConnection,
  THEME_ATTRIBUTE,
  useSettingsStore,
  validateConnection,
  writeConnection,
} from "../settings/settings";

/** A library store to keep preferences in, with a fixed clock and op ids so a run is reproducible. */
function library(): LibraryStore {
  let ops = 0;
  return createMemoryLibraryStore({
    deviceId: "web-test-device",
    now: () => 1_700_000_000_000,
    newId: () => {
      ops += 1;
      return `op-${ops}`;
    },
  });
}

/** The store's current state, which is what the app reads through the zustand hook. */
function settings(): ReturnType<typeof useSettingsStore.getState> {
  return useSettingsStore.getState();
}

beforeEach(() => {
  globalThis.localStorage.clear();
  useSettingsStore.setState({ connection: DEFAULT_CONNECTION, preferences: DEFAULT_PREFERENCES, loaded: false });
});

describe("defaults", () => {
  it("starts at the defaults when nothing is saved", async () => {
    await settings().load(library());
    expect(settings().loaded).toBe(true);
    expect(settings().connection).toEqual(DEFAULT_CONNECTION);
    expect(settings().preferences).toEqual(DEFAULT_PREFERENCES);
    expect(settings().preferences.cacheLimitBytes).toBe(DEFAULT_CACHE_LIMIT_BYTES);
    expect(settings().preferences.theme).toBe("system");
  });
});

describe("the connection", () => {
  it("keeps the connection in localStorage without a trailing slash", async () => {
    await settings().load(library());
    await settings().update({ connection: { hubUrl: "  http://127.0.0.1:8787/  ", token: "  a-token  " } });

    const expected = { hubUrl: "http://127.0.0.1:8787", token: "a-token" };
    expect(settings().connection).toEqual(expected);
    expect(readConnection()).toEqual(expected);
    expect(JSON.parse(localStorage.getItem(CONNECTION_KEY) ?? "null")).toEqual(expected);
  });

  it("reads an unusable stored connection as the empty one", () => {
    localStorage.setItem(CONNECTION_KEY, "not json at all");
    expect(readConnection()).toEqual(DEFAULT_CONNECTION);
    localStorage.setItem(CONNECTION_KEY, JSON.stringify({ hubUrl: 42, token: null }));
    expect(readConnection()).toEqual(DEFAULT_CONNECTION);
  });

  it("normalizes a URL and trims a token", () => {
    expect(normalizeHubUrl("  http://hub.local:8787/  ")).toBe("http://hub.local:8787");
    expect(normalizeHubUrl("http://hub.local:8787///")).toBe("http://hub.local:8787");
    expect(normalizeHubUrl("   ")).toBe("");
    expect(normalizeConnection({ hubUrl: " http://hub.local:8787/ ", token: " t " })).toEqual({
      hubUrl: "http://hub.local:8787",
      token: "t",
    });
    expect(writeConnection({ hubUrl: "http://hub.local:8787/", token: "t" })).toEqual({
      hubUrl: "http://hub.local:8787",
      token: "t",
    });
    expect(readConnection()).toEqual({ hubUrl: "http://hub.local:8787", token: "t" });
  });

  it("accepts an absolute http(s) address and refuses anything else", () => {
    expect(isHubUrl("http://127.0.0.1:8787")).toBe(true);
    expect(isHubUrl("https://hub.local")).toBe(true);
    expect(isHubUrl("127.0.0.1:8787")).toBe(false);

    expect(validateConnection({ hubUrl: "", token: "t" })).toBe("a hub URL is required");
    expect(validateConnection({ hubUrl: "127.0.0.1:8787", token: "t" })).toBe("the hub URL must be an absolute http or https address");
    expect(validateConnection({ hubUrl: "http://127.0.0.1:8787", token: "" })).toBe("the token is required");
    expect(validateConnection({ hubUrl: "http://127.0.0.1:8787", token: "t" })).toBeNull();
  });
});

describe("the preferences", () => {
  it("writes one library record per field and reads them back after a reload", async () => {
    const store = library();
    await settings().load(store);
    await settings().update({ preferences: { rate: 2.5, skipFurniture: false, theme: "dark", voiceId: "mock:mock-a" } });

    expect(await store.getSetting(PREFERENCE_KEYS.rate)).toBe(2.5);
    expect(await store.getSetting(PREFERENCE_KEYS.theme)).toBe("dark");
    expect(await store.getSetting(PREFERENCE_KEYS.voiceId)).toBe("mock:mock-a");
    // A field the patch did not name is not written at all, so it cannot compete with another device's value.
    expect(await store.getSetting(PREFERENCE_KEYS.skipCitations)).toBeNull();

    // A reload: the in-memory settings are dropped and `load` reads the library again.
    useSettingsStore.setState({ preferences: DEFAULT_PREFERENCES, loaded: false });
    await settings().load(store);
    expect(settings().preferences.rate).toBe(2.5);
    expect(settings().preferences.skipFurniture).toBe(false);
    expect(settings().preferences.theme).toBe("dark");
    expect(settings().preferences.voiceId).toBe("mock:mock-a");
    expect(settings().preferences.lookaheadMs).toBe(DEFAULT_PREFERENCES.lookaheadMs);
  });

  it("clamps the speed into F§10.1's range at a tenth of a step", async () => {
    await settings().load(library());
    await settings().update({ preferences: { rate: 9 } });
    expect(settings().preferences.rate).toBe(5);
    await settings().update({ preferences: { rate: 0.1 } });
    expect(settings().preferences.rate).toBe(0.5);

    expect(clampRate(3.14)).toBe(3.1);
    expect(clampRate(Number.NaN)).toBe(DEFAULT_PREFERENCES.rate);
  });

  it("ignores a stored value whose shape is not the one the app writes", async () => {
    const store = library();
    await store.setSetting(PREFERENCE_KEYS.rate, "fast");
    await store.setSetting(PREFERENCE_KEYS.skipFurniture, 3);
    await store.setSetting(PREFERENCE_KEYS.theme, "neon");
    await store.setSetting(PREFERENCE_KEYS.lookaheadMs, -5);
    await store.setSetting(PREFERENCE_KEYS.cacheLimitBytes, "lots");

    await settings().load(store);
    expect(settings().preferences.rate).toBe(DEFAULT_PREFERENCES.rate);
    expect(settings().preferences.skipFurniture).toBe(DEFAULT_PREFERENCES.skipFurniture);
    expect(settings().preferences.theme).toBe(DEFAULT_PREFERENCES.theme);
    expect(settings().preferences.lookaheadMs).toBe(DEFAULT_PREFERENCES.lookaheadMs);
    expect(settings().preferences.cacheLimitBytes).toBe(DEFAULT_CACHE_LIMIT_BYTES);
  });

  it("knows the three themes", () => {
    expect(isTheme("dark")).toBe(true);
    expect(isTheme("system")).toBe(true);
    expect(isTheme("neon")).toBe(false);
    expect(isTheme(3)).toBe(false);
  });
});

describe("the theme", () => {
  it("pins the attribute the stylesheet reads, and clears it again for `system`", () => {
    const root = document.createElement("div");
    applyTheme("dark", root);
    expect(root.getAttribute(THEME_ATTRIBUTE)).toBe("dark");
    applyTheme("light", root);
    expect(root.getAttribute(THEME_ATTRIBUTE)).toBe("light");
    applyTheme("system", root);
    expect(root.hasAttribute(THEME_ATTRIBUTE)).toBe(false);
  });
});
