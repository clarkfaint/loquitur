/**
 * The settings record's tests (F§10.2).
 *
 * They run against an in-memory `chrome.storage.local`: the defaults before anything is saved, a round trip
 * through the record, the normalization every stored value passes through, and the change notification the
 * rest of the extension listens to.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  applyPatch,
  DEFAULT_EXT_SETTINGS,
  type ExtSettings,
  getSettings,
  onSettingsChanged,
  originPattern,
  SETTINGS_KEY,
  setSettings,
  settingsFrom,
} from "../settings";

/** One listener watching `chrome.storage.local`, as `chrome` types it. */
type ChangeListener = (changes: { [key: string]: chrome.storage.StorageChange }) => void;

/** What the double holds, and who is watching it. */
let stored: Record<string, unknown> = {};
let watchers: ChangeListener[] = [];

/** An in-memory stand-in for the one storage area the extension uses. */
function installChromeDouble(): void {
  stored = {};
  watchers = [];
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key: string) => (key in stored ? { [key]: stored[key] } : {}),
        set: async (record: Record<string, unknown>) => {
          const changes: { [key: string]: chrome.storage.StorageChange } = {};
          for (const [key, newValue] of Object.entries(record)) {
            changes[key] = { oldValue: stored[key], newValue };
            stored[key] = newValue;
          }
          for (const watcher of watchers) watcher(changes);
        },
        onChanged: {
          addListener: (listener: ChangeListener) => {
            watchers.push(listener);
          },
          removeListener: (listener: ChangeListener) => {
            watchers = watchers.filter((watcher) => watcher !== listener);
          },
        },
      },
    },
  } as unknown as typeof chrome;
}

beforeEach(installChromeDouble);

describe("the stored record", () => {
  it("is the defaults before anything has been saved", async () => {
    await expect(getSettings()).resolves.toEqual(DEFAULT_EXT_SETTINGS);
  });

  it("comes back as it was written", async () => {
    const written: ExtSettings = {
      hubUrl: "http://127.0.0.1:8787",
      token: "a-token-of-at-least-32-characters",
      webAppUrl: "https://reader.example",
      voiceId: "mock:mock-a",
      rate: 1.5,
      autoShowWidget: true,
      disabledSites: ["example.com"],
      skipFurniture: false,
    };
    await expect(setSettings(written)).resolves.toEqual(written);
    await expect(getSettings()).resolves.toEqual(written);
    expect(stored[SETTINGS_KEY]).toEqual(written);
  });

  it("normalizes what a patch carries", async () => {
    const saved = await setSettings({
      hubUrl: "  http://127.0.0.1:8787/  ",
      token: "  spaced-token-of-at-least-32-chars  ",
      webAppUrl: "https://reader.example///",
      rate: 9,
      disabledSites: ["Example.com", "example.com", "  ", "other.example"],
    });
    expect(saved.hubUrl).toBe("http://127.0.0.1:8787");
    expect(saved.token).toBe("spaced-token-of-at-least-32-chars");
    expect(saved.webAppUrl).toBe("https://reader.example");
    expect(saved.rate).toBe(5);
    expect(saved.disabledSites).toEqual(["example.com", "other.example"]);
    await expect(getSettings()).resolves.toEqual(saved);
  });

  it("keeps the fields a patch does not name", async () => {
    const first = await setSettings({ hubUrl: "http://hub.example", voiceId: "mock:mock-a", skipFurniture: false });
    const second = await setSettings({ rate: 2 });
    expect(second).toEqual({ ...first, rate: 2 });
  });

  it("falls back to the default for a stored value of the wrong shape", () => {
    const settings = settingsFrom({
      hubUrl: 42,
      token: null,
      webAppUrl: [],
      voiceId: {},
      rate: "fast",
      autoShowWidget: "yes",
      disabledSites: "example.com",
      skipFurniture: 1,
    });
    expect(settings).toEqual(DEFAULT_EXT_SETTINGS);
  });

  it("reads a record that holds only some of the fields", () => {
    const settings = settingsFrom({ hubUrl: "http://hub.example/", rate: 3 });
    expect(settings).toMatchObject({ hubUrl: "http://hub.example", rate: 3, token: "", autoShowWidget: false });
  });

  it("applies a patch without touching the record it was given", () => {
    const patch = applyPatch(DEFAULT_EXT_SETTINGS, { rate: 4.5 });
    expect(patch.rate).toBe(4.5);
    expect(DEFAULT_EXT_SETTINGS.rate).toBe(1);
  });
});

describe("the change notification", () => {
  it("reports the settings a write produced", async () => {
    const seen: ExtSettings[] = [];
    const stop = onSettingsChanged((settings) => seen.push(settings));

    await setSettings({ hubUrl: "http://hub.example", rate: 2 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ hubUrl: "http://hub.example", rate: 2 });

    stop();
    await setSettings({ rate: 3 });
    expect(seen).toHaveLength(1);
  });

  it("says nothing about a change to another key", async () => {
    const seen: ExtSettings[] = [];
    onSettingsChanged((settings) => seen.push(settings));
    await chrome.storage.local.set({ "some.other.key": 1 });
    expect(seen).toEqual([]);
  });
});

describe("the hub origin", () => {
  it("is the origin of the hub URL, as a host permission pattern", () => {
    expect(originPattern("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787/*");
    expect(originPattern("https://hub.example/reader")).toBe("https://hub.example/*");
  });

  it("is null for an address the extension cannot ask to reach", () => {
    expect(originPattern("")).toBeNull();
    expect(originPattern("ftp://hub.example")).toBeNull();
    expect(originPattern("not a url")).toBeNull();
  });
});
