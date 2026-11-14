/**
 * The desktop shell's bridge, as the web app sees it (F§10.3).
 *
 * The shell's preload script exposes one object on `window.lecternDesktop`; this module is the whole of the
 * web app's knowledge of it. Nothing here imports Electron — the desktop package is a consumer of this
 * interface, never a dependency of it — and a browser page reaches the shell only through
 * `getDesktopBridge()`, which answers `null` unless the object really carries the members below.
 *
 * The player half of the bridge carries a snapshot and a command in the two directions F§10.1's `PlayerBus`
 * needs (the host publishes state, a remote sends commands), which is what lets the mini-player window and
 * the main window share one player over the IPC boundary instead of a web channel.
 */

import type { PlayerCommand, PlayerSnapshot } from "@lectern/core";

/**
 * What crosses the bridge about the player: the snapshot F§5.7 defines, plus the title of the document it
 * belongs to (F§10.3). The bus widens this with the figures its own view needs — see `PlayerBusSnapshot` —
 * and a wider object is assignable here, so the bridge is typed exactly as F§10.3 writes it.
 */
export type BusSnapshot = PlayerSnapshot & { title: string };

/** Every trigger the desktop shell can raise, and the default hotkey of each (F§10.3). */
export type DesktopAction =
  | "readSelection"
  | "readRegion"
  | "togglePlay"
  | "nextSentence"
  | "previousSentence"
  | "faster"
  | "slower"
  | "toggleMini"
  | "showMain";

/** What the shell keeps between runs (F§10.3). */
export interface DesktopSettings {
  hotkeys: Record<DesktopAction, string>;
  watchFolders: string[];
  miniBounds: { x: number; y: number } | null;
  processedFiles: string[];
}

/** What the shell reports about its own registration state (F§10.3). */
export interface DesktopStatus {
  hotkeys: Record<DesktopAction, "registered" | "failed" | "pending">;
  selectionProvider: string;
  watchers: { folder: string; ok: boolean; error?: string }[];
}

/** Files the shell hands the app to import, already read into memory (F§10.3). */
export interface DesktopImportRequest {
  files: { name: string; mime: string; bytes: Uint8Array }[];
  play: boolean;
  folderName?: string;
}

/** Text the shell hands the app to read, from a selection or a screen region (F§10.3). */
export interface DesktopReadRequest {
  text: string;
  title: string;
}

/**
 * The bridge itself (F§10.3): these are all of its members, and this interface is the only place they are
 * declared. Every member that carries a value across the boundary hands it over as plain data, so the web
 * app can validate it; every member that subscribes answers with the function that unsubscribes.
 */
export interface LecternDesktopBridge {
  platform: "linux" | "win32";
  player: {
    send(cmd: PlayerCommand): void;
    onSnapshot(cb: (s: BusSnapshot) => void): () => void;
    publish(s: BusSnapshot): void;
    onCommand(cb: (cmd: PlayerCommand) => void): () => void;
  };
  onImportRequest(cb: (req: DesktopImportRequest) => void): () => void;
  onReadText(cb: (req: DesktopReadRequest) => void): () => void;
  settings: {
    get(): Promise<DesktopSettings>;
    set(patch: Partial<DesktopSettings>): Promise<DesktopSettings>;
    onStatus(cb: (s: DesktopStatus) => void): () => void;
    pickFolder(): Promise<string | null>;
  };
  windows: { toggleMini(): void; showMain(): void };
  captureRegion(): Promise<void>;
}

declare global {
  interface Window {
    /** What the shell's preload script exposes (F§10.3). Absent in a browser and in every test. */
    lecternDesktop?: LecternDesktopBridge | undefined;
  }
}

/** Whether a value is an object carrying a member under every one of the given names, all of them functions. */
function hasFunctions(value: unknown, names: readonly string[]): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return names.every((name) => typeof record[name] === "function");
}

/**
 * Whether a value carries the members F§10.3 lists. A page can be loaded with anything in
 * `window.lecternDesktop` — another extension's object, a stale shell — so the accessor checks before it
 * hands the object out rather than trusting the name.
 */
export function isDesktopBridge(value: unknown): value is LecternDesktopBridge {
  if (typeof value !== "object" || value === null) return false;
  const platform = (value as Record<string, unknown>).platform;
  if (platform !== "linux" && platform !== "win32") return false;
  return (
    hasFunctions(value, ["onImportRequest", "onReadText", "captureRegion"]) &&
    hasFunctions((value as Record<string, unknown>).player, ["send", "onSnapshot", "publish", "onCommand"]) &&
    hasFunctions((value as Record<string, unknown>).settings, ["get", "set", "onStatus", "pickFolder"]) &&
    hasFunctions((value as Record<string, unknown>).windows, ["toggleMini", "showMain"])
  );
}

/**
 * `getDesktopBridge()` — the shell's bridge, or `null` when the page is not running inside the shell.
 *
 * The accessor is the only place `window.lecternDesktop` is read (F§10.3), so the rest of the app — and the
 * bus, which prefers this transport when it exists — never has to ask whether it is in a browser.
 */
export function getDesktopBridge(): LecternDesktopBridge | null {
  if (typeof window === "undefined") return null;
  const candidate: unknown = window.lecternDesktop;
  return isDesktopBridge(candidate) ? candidate : null;
}
