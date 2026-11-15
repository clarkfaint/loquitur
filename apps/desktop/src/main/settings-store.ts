/**
 * What the shell remembers between runs (F§10.3): the hotkey each action answers to, the folders watched for
 * files to import, where the mini-player was last placed, and the ledger of files already imported.
 *
 * The record is one JSON file in the user-data directory, and `LECTERN_USER_DATA` overrides that directory —
 * which is what lets the end-to-end suite give every run a shell with no history to inherit. Writes are
 * atomic: the record is written to a temporary file beside its own name and then renamed onto it, so a window
 * closed mid-write leaves the previous record intact rather than a truncated one.
 *
 * A file that does not parse, or that carries a field this design does not define, is neither repaired nor
 * partly trusted: the defaults are answered instead, and the file is left exactly where it is, so the
 * operator can look at what went wrong. Nothing here writes over a corrupt file until the reader changes
 * something.
 *
 * The record's schema lives in `./ipc`, with the wire shapes that carry the same fields, so the settings the
 * renderer is promised and the settings read off disk cannot become two different shapes. The status half of
 * this module is F§10.3's `DesktopStatus`: the shell's own account of what it has registered, which a feature
 * publishes and every renderer subscribes to.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { z } from "zod";
import { type DesktopAction, DesktopSettingsPatchSchema, DesktopSettingsSchema, type DesktopStatusSchema } from "./ipc";

/** What the shell keeps between runs (F§10.3). */
export type DesktopSettings = z.infer<typeof DesktopSettingsSchema>;

/** A change to the settings: any subset of the record. zod's own partial shape, so a patch the channel
 * accepted is a patch the store takes. */
export type DesktopSettingsPatch = z.infer<typeof DesktopSettingsPatchSchema>;

/** What the shell reports about its own registration state (F§10.3). */
export type DesktopStatus = z.infer<typeof DesktopStatusSchema>;

/** The file the record is kept in, inside the settings directory. */
export const SETTINGS_FILE_NAME = "desktop-settings.json";

/** The default hotkey of every action (F§10.3). `toggleMini` and `showMain` have none in F§10.3's list — they
 * are the tray's and the mini-player's own, which the tray feature (U-039) fills in — so they are unbound,
 * which is what the empty string means here. */
export const DEFAULT_HOTKEYS: Record<DesktopAction, string> = {
  readSelection: "Ctrl+Alt+R",
  readRegion: "Ctrl+Alt+S",
  togglePlay: "Ctrl+Alt+Space",
  nextSentence: "Ctrl+Alt+Right",
  previousSentence: "Ctrl+Alt+Left",
  faster: "Ctrl+Alt+Up",
  slower: "Ctrl+Alt+Down",
  toggleMini: "",
  showMain: "",
};

/** What a shell that has never been configured holds. */
export function defaultSettings(): DesktopSettings {
  return { hotkeys: { ...DEFAULT_HOTKEYS }, watchFolders: [], miniBounds: null, processedFiles: [] };
}

/** What the shell reports before any feature has registered anything: every shortcut still pending, no
 * selection provider chosen, no folder watched. */
export function pendingStatus(): DesktopStatus {
  const hotkeys: DesktopStatus["hotkeys"] = {
    readSelection: "pending",
    readRegion: "pending",
    togglePlay: "pending",
    nextSentence: "pending",
    previousSentence: "pending",
    faster: "pending",
    slower: "pending",
    toggleMini: "pending",
    showMain: "pending",
  };
  return { hotkeys, selectionProvider: "", watchers: [] };
}

/**
 * `settingsDirectory(env, fallback)` — where the record lives.
 *
 * `LECTERN_USER_DATA` wins when the operator set it, which is how a run of the end-to-end suite is given a
 * shell of its own; the app's user-data directory is the fallback, and it is passed in rather than looked up
 * here so this module needs no Electron to be testable.
 */
export function settingsDirectory(env: Readonly<Record<string, string | undefined>>, fallback: string): string {
  const override = env["LECTERN_USER_DATA"];
  return override === undefined || override === "" ? fallback : override;
}

/** What a settings store offers. */
export interface DesktopSettingsStore {
  /** The directory the record is kept in. */
  directory(): string;
  /** The record on disk, or the defaults when there is none to trust. */
  get(): Promise<DesktopSettings>;
  /** Merge a change into the record, write it, and answer the whole record. */
  set(patch: DesktopSettingsPatch): Promise<DesktopSettings>;
  /** Run `handler` after every write, with the record as written. */
  onChange(handler: (settings: DesktopSettings) => void): () => void;
  /** Run `handler` with the current status now, and again whenever a feature publishes a new one. */
  onStatus(handler: (status: DesktopStatus) => void): () => void;
  /** Publish a new status to every subscriber. */
  publishStatus(status: DesktopStatus): void;
  /** The status as it stands. */
  status(): DesktopStatus;
}

/** `createSettingsStore(options)` — the record, its file, and the two subscription lists around it. */
export function createSettingsStore(options: { dir: string }): DesktopSettingsStore {
  const directory = options.dir;
  const file = join(directory, SETTINGS_FILE_NAME);
  const changeHandlers = new Set<(settings: DesktopSettings) => void>();
  const statusHandlers = new Set<(status: DesktopStatus) => void>();
  let currentStatus = pendingStatus();

  /** The record on disk, or the defaults when anything about it cannot be trusted. */
  async function read(): Promise<DesktopSettings> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return defaultSettings();
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return defaultSettings();
    }
    const parsed = DesktopSettingsSchema.safeParse(raw);
    return parsed.success ? parsed.data : defaultSettings();
  }

  /** Write the whole record: a temporary file beside it, then one rename onto its own name. */
  async function write(settings: DesktopSettings): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await rename(temporary, file);
  }

  return {
    directory: () => directory,

    get: read,

    async set(patch: DesktopSettingsPatch): Promise<DesktopSettings> {
      const change = DesktopSettingsPatchSchema.safeParse(patch);
      if (!change.success) {
        throw new Error(`the settings change is not a settings change: ${change.error.issues[0]?.message ?? ""}`);
      }
      const merged = DesktopSettingsSchema.parse({ ...(await read()), ...change.data });
      await write(merged);
      for (const handler of [...changeHandlers]) handler(merged);
      return merged;
    },

    onChange(handler) {
      changeHandlers.add(handler);
      return () => {
        changeHandlers.delete(handler);
      };
    },

    onStatus(handler) {
      statusHandlers.add(handler);
      handler(currentStatus);
      return () => {
        statusHandlers.delete(handler);
      };
    },

    publishStatus(status) {
      currentStatus = status;
      for (const handler of [...statusHandlers]) handler(status);
    },

    status: () => currentStatus,
  };
}
