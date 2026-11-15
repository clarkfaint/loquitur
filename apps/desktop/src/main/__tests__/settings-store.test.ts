/**
 * The settings record, on disk (F§10.3).
 *
 * Every case works on a directory of its own, so nothing here depends on the order the cases run in or on a
 * machine's state: the directory is made before each case and removed after it.
 */

import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createSettingsStore,
  DEFAULT_HOTKEYS,
  type DesktopSettingsPatch,
  defaultSettings,
  pendingStatus,
  SETTINGS_FILE_NAME,
  settingsDirectory,
} from "../settings-store";

/** The directory this case's record lives in. */
let directory = "";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "lectern-desktop-settings-"));
});

afterEach(async () => {
  // A case that made the directory read-only must hand it back before it can be removed.
  await chmod(directory, 0o700).catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
});

/** The record file's own path. */
function settingsFile(): string {
  return join(directory, SETTINGS_FILE_NAME);
}

describe("the settings record", () => {
  test("a shell that has never run answers F§10.3's defaults", async () => {
    const store = createSettingsStore({ dir: directory });
    expect(await store.get()).toEqual(defaultSettings());
    expect(await readdir(directory)).toEqual([]);
  });

  test("a change is written, and read back whole", async () => {
    const store = createSettingsStore({ dir: directory });
    const written = await store.set({ watchFolders: ["/home/reader/Lectern"], miniBounds: { x: 40, y: 60 } });

    expect(written.watchFolders).toEqual(["/home/reader/Lectern"]);
    expect(written.miniBounds).toEqual({ x: 40, y: 60 });
    // The fields the change did not mention keep their defaults: a patch is a merge, not a replacement.
    expect(written.hotkeys).toEqual(DEFAULT_HOTKEYS);
    expect(written.processedFiles).toEqual([]);

    expect(await store.get()).toEqual(written);
    expect(JSON.parse(await readFile(settingsFile(), "utf8"))).toEqual(written);
  });

  test("a file that does not parse is answered with the defaults and left alone", async () => {
    const corrupt = "{ this is not json";
    await writeFile(settingsFile(), corrupt, "utf8");

    const store = createSettingsStore({ dir: directory });
    expect(await store.get()).toEqual(defaultSettings());
    // Nothing repairs or overwrites it: the operator can still look at what went wrong.
    expect(await readFile(settingsFile(), "utf8")).toBe(corrupt);
  });

  test("a record carrying a field this design does not define is refused the same way", async () => {
    await writeFile(settingsFile(), JSON.stringify({ ...defaultSettings(), theme: "dark" }), "utf8");

    const store = createSettingsStore({ dir: directory });
    expect(await store.get()).toEqual(defaultSettings());
  });

  test("a write leaves one file behind, and a write that cannot finish leaves the record as it was", async () => {
    const store = createSettingsStore({ dir: directory });
    await store.set({ processedFiles: ["a.pdf"] });
    // The temporary file the write goes through is gone; only the record is left.
    expect(await readdir(directory)).toEqual([SETTINGS_FILE_NAME]);

    await chmod(directory, 0o500);
    try {
      await expect(store.set({ processedFiles: ["a.pdf", "b.pdf"] })).rejects.toThrow();
      // The previous record is intact — a half-written file never replaced it.
      expect(await store.get()).toEqual({ ...defaultSettings(), processedFiles: ["a.pdf"] });
    } finally {
      await chmod(directory, 0o700);
    }
  });

  test("a change that is not a settings change is refused before anything is written", async () => {
    const store = createSettingsStore({ dir: directory });
    // Valid to TypeScript and not to the schema: this is what a stale or hostile caller would send, and the
    // store refuses it before it writes anything at all.
    const broken = { watchFolders: "not a list" } as unknown as DesktopSettingsPatch;

    await expect(store.set(broken)).rejects.toThrow(/not a settings change/u);
    expect(await readdir(directory)).toEqual([]);
  });

  test("change events carry the record as written, and stop when they are taken off", async () => {
    const store = createSettingsStore({ dir: directory });
    const seen: string[][] = [];
    const stop = store.onChange((settings) => seen.push(settings.watchFolders));

    await store.set({ watchFolders: ["/one"] });
    await store.set({ watchFolders: ["/one", "/two"] });
    stop();
    await store.set({ watchFolders: ["/three"] });

    expect(seen).toEqual([["/one"], ["/one", "/two"]]);
  });
});

describe("the shell's status", () => {
  test("a fresh shell reports every shortcut pending, and a subscriber hears it at once", () => {
    const store = createSettingsStore({ dir: directory });
    const seen: string[] = [];
    store.onStatus((status) => seen.push(status.hotkeys.togglePlay));

    expect(store.status()).toEqual(pendingStatus());
    expect(seen).toEqual(["pending"]);
  });

  test("a published status reaches every subscriber and is what the shell answers next", () => {
    const store = createSettingsStore({ dir: directory });
    const seen: string[] = [];
    store.onStatus((status) => seen.push(status.selectionProvider));
    const published = { ...pendingStatus(), selectionProvider: "primary-selection" };

    store.publishStatus(published);

    expect(seen).toEqual(["", "primary-selection"]);
    expect(store.status()).toBe(published);
  });
});

describe("the settings directory", () => {
  test("LECTERN_USER_DATA wins, and an empty variable counts as unset", () => {
    expect(settingsDirectory({ LECTERN_USER_DATA: "/tmp/run-7" }, "/home/reader/.config")).toBe("/tmp/run-7");
    expect(settingsDirectory({}, "/home/reader/.config")).toBe("/home/reader/.config");
    expect(settingsDirectory({ LECTERN_USER_DATA: "" }, "/home/reader/.config")).toBe("/home/reader/.config");
  });

  test("a directory that is not there yet is made on the first write", async () => {
    const nested = join(directory, "a", "b");
    const store = createSettingsStore({ dir: nested });

    await store.set({ processedFiles: ["kept.pdf"] });
    expect(await store.get()).toEqual({ ...defaultSettings(), processedFiles: ["kept.pdf"] });
  });
});
