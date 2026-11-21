/**
 * Watching the operator's folders (F§10.3): every document the shell imports without being asked to.
 *
 * F§10.3's file watcher is one sentence — "chokidar watches configured folders (default `~/Lectern/Inbox`) for
 * `pdf, epub, docx, txt, md, html`; waits for writes to finish; never modifies the watched files; imports through
 * the web app's import pipeline; de-duplicates by `docId` and by a ledger of processed files" — and this module
 * is the shell's whole half of it. It runs no parser, computes no `docId`, and writes nothing into a watched
 * folder: it reads a file's bytes and hands them over F§10.3's import channel, where the app's ordinary
 * pipeline turns them into a document exactly as a dropped file does.
 *
 * Four decisions are this module's, and they are all about when a file becomes a request.
 *
 * - **One file at a time, and each one through the ledger.** A watcher that read a whole folder at once would be
 *   a memory spike and a burst of imports; a single queue drains one file per turn, so the app is handed one
 *   document at a time and the ledger write that follows each one can never race another (`processedFiles` is
 *   read, extended and written for every file). A file seen twice while it waits is processed once, by its last
 *   state — the second event replaces nothing, because the key is computed when the file is read, not when the
 *   event arrives.
 * - **The ledger is what makes a restart quiet, and it is newest-first.** A key that is already there is a file
 *   the shell has imported; a file whose size or modification time has changed carries a new key and is read
 *   again, which is the difference between "the operator has not touched this" and "the operator changed this".
 *   The list is capped at the contract's 5 000 keys, newest first, so a folder full of documents cannot grow
 *   the settings record without bound.
 * - **The shell watches one folder of its own.** F§10.3's default is `~/Lectern/Inbox`, "created on first run",
 *   and this is the one folder the operator did not add: it is made on start-up and watched beside the folders
 *   they chose. Nothing else outside their list is watched, and nothing is watched at a drive root — the
 *   contract's *Forbidden Actions*. The record is never written to say so, so a shell that has changed nothing
 *   still has no settings file (§7 (1) files the alternative).
 * - **Settings changes are applied as a diff.** The record is the operator's, so each change is compared with
 *   the folders in force and only what arrived is watched while only what left is given up. The watcher writes
 *   the ledger into the same record, so a change that compares equal must not restart anything: a diff is what
 *   keeps the shell's own write from tearing its own watchers down.
 *
 * Everything the module touches outside itself is a surface it is given (`WatcherHost`), and `watcherFeature` is
 * the only place the shell's own are built — the shape U-041 and U-042 use, and what keeps this file free of any
 * decision that would need an application running to observe.
 */

import { mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { type ChokidarOptions, type FSWatcher, watch } from "chokidar";
import type { MainContext } from "../context";
import type { ShellFeature } from "../features";
import { IPC_CHANNELS } from "../ipc";
import type { DesktopSettings, DesktopStatus } from "../settings-store";
import { fileKey, isImportable, mimeForExtension, shouldProcess } from "./watch-model";

/** The word the shell files a watched file under (F§10.3): the app's `Inbox`, named by the shell that asked. */
export const INBOX_FOLDER = "Inbox";

/** Where the shell's own folder sits under the operator's home (F§10.3's `~/Lectern/Inbox`). */
export const DEFAULT_WATCH_FOLDER_PARTS = ["Loquitur", "Inbox"] as const;

/** How far below a watched folder the shell looks: the contract's three levels. */
export const WATCH_DEPTH = 3;

/** How many keys of the ledger of imported files are kept: the contract's newest 5 000. */
export const PROCESSED_FILE_LIMIT = 5000;

/** How long a file must hold still before it is read (F§10.3's "waits for writes to finish"). */
export const WRITE_STABILITY_MS = 500;

/** How often a file still being written is asked about while it settles. */
export const WRITE_POLL_MS = 100;

/**
 * How a watched folder is watched.
 *
 * `followSymlinks: false` and `depth` are the contract's own rules (a link out of a watched folder is not a file
 * in it, and three levels is where the shell stops looking); `awaitWriteFinish` is F§10.3's "waits for writes to
 * finish", which is what keeps a half-copied file from being read; a folder's own contents are looked at when
 * the watch begins, because a folder the operator points the shell at is a folder they want imported, and the
 * ledger is what stops the second look from being a second import.
 */
export const WATCH_OPTIONS: ChokidarOptions = {
  persistent: true,
  ignoreInitial: false,
  followSymlinks: false,
  depth: WATCH_DEPTH,
  awaitWriteFinish: { stabilityThreshold: WRITE_STABILITY_MS, pollInterval: WRITE_POLL_MS },
  ignorePermissionErrors: true,
};

/** The folder the shell watches when the operator has configured nothing (F§10.3's default). */
export function defaultWatchFolder(home: string): string {
  return join(home, ...DEFAULT_WATCH_FOLDER_PARTS);
}

/** The surfaces the watcher works through: `chokidar` and `node:fs/promises` in the shell, stand-ins in a test. */
export interface WatcherHost {
  /** Watch one folder, answering the watcher F§10.3's options describe. */
  watch(folder: string): FSWatcher;
  /** A file's size and modification time, or a rejection when it is not there any more. */
  stat(path: string): Promise<{ size: number; mtimeMs: number }>;
  /** One file's bytes, as the app's import pipeline takes them. */
  read(path: string): Promise<Uint8Array>;
  /** Make a directory, the shell's own folder included. */
  makeDirectory(path: string): Promise<void>;
  /** The operator's home directory, which is where the shell's own folder sits. */
  home: string;
}

/** The shell's own surfaces. This is the only place this module's Electron-free world meets the machine. */
export function shellWatcherHost(): WatcherHost {
  return {
    watch: (folder) => watch(folder, WATCH_OPTIONS),
    stat: async (path) => {
      const info = await stat(path);
      return { size: info.size, mtimeMs: info.mtimeMs };
    },
    read: async (path) => new Uint8Array(await readFile(path)),
    makeDirectory: async (path) => {
      await mkdir(path, { recursive: true });
    },
    home: homedir(),
  };
}

/** One folder being watched, as the shell reports it (`DesktopStatus.watchers`). */
export type WatchedFolder = DesktopStatus["watchers"][number];

/** What a watcher offers back: the folders it holds, and the way to let go of all of them. */
export interface FileWatcher {
  /** Every folder being watched, in the order the shell took them on, with its own state. */
  watched(): readonly WatchedFolder[];
  /** Stop watching everything and stop listening to the settings. */
  stop(): void;
}

/** How the watcher is built: its surfaces, and nothing else. */
export interface FileWatcherOptions {
  /** The surfaces the watcher works through; the shell's own by default. */
  host?: WatcherHost;
}

/** What a folder the watcher could not hold is reported as: nothing is waiting to be told, so it is a line. */
function report(cause: unknown): void {
  console.error(`a watched folder could not be read: ${cause instanceof Error ? cause.message : String(cause)}`);
}

/** One line for a failure, as `DesktopStatus` carries it. */
function reasonFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Whether a failure is a file that is not there any more: a file that went away while it waited its turn. */
function isMissing(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ENOENT";
}

/**
 * `createFileWatcher(ctx, options)` — watch the operator's folders, and import what arrives in them.
 *
 * The folders are read once at start-up and every later change is applied as a diff, so the shell's own ledger
 * writes do not disturb what it is watching. The shell's own folder is made here rather than in the settings,
 * which is what "created on first run" costs and what keeps a shell that has changed nothing free of a settings
 * file.
 */
export function createFileWatcher(ctx: MainContext, options: FileWatcherOptions = {}): FileWatcher {
  const host = options.host ?? shellWatcherHost();
  const ownFolder = defaultWatchFolder(host.home);

  /** The watcher of each folder in force, in the order they were taken on. */
  const watchers = new Map<string, FSWatcher>();
  /** What the shell says about each: watching, or the reason it is not. */
  const states = new Map<string, { ok: boolean; error?: string }>();
  /** Paths waiting their turn, each once. */
  const queue: string[] = [];
  let draining = false;

  /** One folder as F§10.3's status carries it, with the error key absent when there is no error. */
  function describe(folder: string): WatchedFolder {
    const state = states.get(folder);
    const ok = state?.ok ?? false;
    const error = state?.error;
    return error === undefined ? { folder, ok } : { folder, ok, error };
  }

  /** Tell the store, and the renderer, what the shell is watching. Both, because they are two readers. */
  function publish(): void {
    const status: DesktopStatus = { ...ctx.settings.status(), watchers: [...watchers.keys()].map(describe) };
    ctx.settings.publishStatus(status);
    ctx.sendToMain(IPC_CHANNELS.settingsStatus, status);
  }

  /** One file's event: whatever happened to it, it is read once its write has settled. */
  function enqueue(path: string): void {
    if (!queue.includes(path)) queue.push(path);
    void drain();
  }

  /** Read the files that are waiting, one at a time, until none are left. */
  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      let next = queue.shift();
      while (next !== undefined) {
        await importOne(next);
        next = queue.shift();
      }
    } finally {
      draining = false;
    }
  }

  /** Record one reading of one file as done, newest first, and keep the ledger to the contract's 5 000 keys. */
  async function remember(key: string): Promise<void> {
    const held = (await ctx.settings.get()).processedFiles.filter((existing) => existing !== key);
    await ctx.settings.set({ processedFiles: [key, ...held].slice(0, PROCESSED_FILE_LIMIT) });
  }

  /**
   * Read one file and hand it to the app, or decide there is nothing to do.
   *
   * Every ending is quiet: a file the shell does not import, one it has imported already, one that has been
   * deleted between its event and its turn, and one that cannot be read are all "nothing arrives". The ledger
   * is written *after* the hand-off, so a hand-off that could not be made leaves the file to be read again
   * rather than losing it — the app's own `docId` de-duplication is the second line F§10.3 names.
   */
  async function importOne(path: string): Promise<void> {
    try {
      const info = await host.stat(path);
      if (!isImportable(path, info.size)) return;
      const key = fileKey(path, info.size, info.mtimeMs);
      const settings = await ctx.settings.get();
      if (!shouldProcess(key, settings.processedFiles)) return;

      const bytes = await host.read(path);
      ctx.sendToMain(IPC_CHANNELS.importRequest, {
        files: [{ name: basename(path), mime: mimeForExtension(extname(path)), bytes }],
        play: false,
        folderName: INBOX_FOLDER,
      });
      await remember(key);
    } catch (cause) {
      if (isMissing(cause)) return;
      report(cause);
    }
  }

  /** Watch one folder: its files' events, and whatever the folder itself has to report. */
  function startWatching(folder: string): void {
    try {
      const watcher = host.watch(folder);
      watchers.set(folder, watcher);
      states.set(folder, { ok: true });
      watcher.on("add", enqueue);
      watcher.on("change", enqueue);
      watcher.on("error", (cause: unknown) => {
        states.set(folder, { ok: false, error: reasonFor(cause) });
        publish();
        report(cause);
      });
    } catch (cause) {
      states.set(folder, { ok: false, error: reasonFor(cause) });
      report(cause);
    }
  }

  /** Give one folder up. Its state goes with it: a folder nobody watches has nothing to report. */
  function stopWatching(folder: string): void {
    const watcher = watchers.get(folder);
    watchers.delete(folder);
    states.delete(folder);
    if (watcher !== undefined) void watcher.close();
  }

  /**
   * The folders the shell should be watching: the operator's own, and its own one.
   *
   * The shell's folder is always there — it is the shell's inbox, not a folder the operator added — and a folder
   * the operator *did* add that happens to be it keeps its own place in the list rather than being watched twice.
   */
  function wantedFolders(settings: DesktopSettings): string[] {
    const wanted = [...settings.watchFolders];
    if (!wanted.includes(ownFolder)) wanted.push(ownFolder);
    return wanted;
  }

  /** Bring the watchers in line with the record, and say what that leaves the shell watching. */
  function apply(settings: DesktopSettings): void {
    const wanted = wantedFolders(settings);
    let changed = false;
    for (const folder of [...watchers.keys()]) {
      if (wanted.includes(folder)) continue;
      stopWatching(folder);
      changed = true;
    }
    for (const folder of wanted) {
      if (watchers.has(folder)) continue;
      startWatching(folder);
      changed = true;
    }
    if (changed) publish();
  }

  const ready = ctx.settings.get().then(async (settings) => {
    // The shell's own folder is made before it is watched, so the first run of a shell that has never been
    // configured really has a folder to drop a file into (F§10.3's "created on first run").
    await host.makeDirectory(ownFolder);
    apply(settings);
  });
  ready.catch(report);

  const stopListening = ctx.settings.onChange((settings) => {
    apply(settings);
  });

  return {
    watched: () => [...watchers.keys()].map(describe),
    stop: () => {
      stopListening();
      for (const folder of [...watchers.keys()]) stopWatching(folder);
      publish();
    },
  };
}

/**
 * `watcherFeature` — what `features.ts` registers (the registry U-038 marked).
 *
 * The watcher runs for as long as the shell does and has no trigger of its own: F§10.3's folders are watched
 * from the moment the shell is ready until it quits, and everything it does is a reaction to a file or to the
 * settings.
 */
export const watcherFeature: ShellFeature = (ctx: MainContext): void => {
  createFileWatcher(ctx);
};
