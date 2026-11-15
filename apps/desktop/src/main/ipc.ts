/**
 * The shell's IPC surface (F§10.3, F§11).
 *
 * One module owns every channel name and every payload shape that crosses between the preload script and the
 * main process, so neither end can drift from the other. `handle` answers an invoke from the renderer and
 * `send` pushes a payload to it, and each validates where it sits: the two ends are separate processes, a
 * renderer can be a stale page, and a channel carries whatever a script puts on it — so a payload that does
 * not parse never reaches a handler and never leaves one, and the boundary carries either a value of the
 * declared shape or nothing at all.
 *
 * Nothing here imports Electron or any Node-only module. `handle` and `send` are handed the surface they
 * speak through — `ipcMain` and a `WebContents` in the shell, a double in a test — and everything else below
 * is a schema (so the same validation runs in either process) or a type. The preload script bundles this
 * module, and a sandboxed preload may require nothing from `node_modules` and no Node built-in, so a runtime
 * import of one here would keep the shell from starting at all.
 */

import { type PlayerCommand, PlayerCommandSchema, PlayerSnapshotSchema } from "@lectern/core";
import type { DesktopImportRequest, DesktopReadRequest, DesktopSettings, DesktopStatus, PlayerBusSnapshot } from "@lectern/ui-web";
import { z } from "zod";

/** Every trigger the shell can raise (F§10.3), in the order the settings screen lists them. */
export const DESKTOP_ACTION_NAMES = [
  "readSelection",
  "readRegion",
  "togglePlay",
  "nextSentence",
  "previousSentence",
  "faster",
  "slower",
  "toggleMini",
  "showMain",
] as const;

/** One of the nine actions. */
export type DesktopAction = (typeof DESKTOP_ACTION_NAMES)[number];

/** The nine actions, as a schema — which is what an incoming action string is validated with. */
export const DesktopActionSchema = z.enum(DESKTOP_ACTION_NAMES);

/** Every channel the shell's two processes share: the renderer asks on six of them, the main process pushes
 * on the other five, and one of the six carries the host's published player state. */
export const IPC_CHANNELS = {
  /** Renderer → main: the state the host publishes for every remote (F§10.3's bus). */
  playerPublish: "lectern:player-publish",
  /** Renderer → main: a command a remote wants the host to run. */
  playerSend: "lectern:player-send",
  /** Main → renderer: a snapshot for a remote view to draw. */
  playerSnapshot: "lectern:player-snapshot",
  /** Main → renderer: a command for the host view to execute. */
  playerCommand: "lectern:player-command",
  /** Main → renderer: files the shell read for the app to import (a watched folder, the region reader). */
  importRequest: "lectern:import-request",
  /** Main → renderer: text the shell read for the app to play at once (a selection, a screen region). */
  readText: "lectern:read-text",
  /** Renderer → main: the settings as they stand on disk. */
  settingsGet: "lectern:settings-get",
  /** Renderer → main: a change to the settings. */
  settingsSet: "lectern:settings-set",
  /** Main → renderer: what the shell reports about its own registration state. */
  settingsStatus: "lectern:settings-status",
  /** Renderer → main: ask the operator for a folder. */
  settingsPickFolder: "lectern:settings-pick-folder",
  /** Renderer → main: the mini-player's toggle (answered by the window feature, U-039). */
  windowsToggleMini: "lectern:windows-toggle-mini",
  /** Renderer → main: bring the main window forward. */
  windowsShowMain: "lectern:windows-show-main",
  /** Renderer → main: begin a screen-region capture, which resolves when the capture is handed over. */
  captureRegion: "lectern:capture-region",
} as const;

/** One of the channel names above. */
export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/** A payload every channel carries. An invoke with no argument carries `undefined`, which is a payload like
 * any other and is checked like any other. */
export const NO_PAYLOAD = z.undefined();

/**
 * What a host publishes over the bridge: F§10.3's snapshot — the player's state and the document's title —
 * with the word being read and the three figures F§10.1's player bar draws, which is what
 * `@lectern/ui-web`'s bus really posts. The schema is spelled out here rather than imported from the bus
 * module because that module's barrel re-exports React components, and this one is bundled into a preload
 * script; the assignment below is what keeps the two spellings the same shape.
 */
export const PlayerBusSnapshotPayloadSchema = z.strictObject({
  ...PlayerSnapshotSchema.shape,
  title: z.string(),
  active: z.strictObject({ sentenceIndex: z.int().nonnegative(), wordIndex: z.int().nonnegative() }),
  progressFraction: z.number(),
  remainingMs: z.number(),
  baseWpm: z.number(),
}) satisfies z.ZodType<PlayerBusSnapshot>;

/** One payload of every action's own hotkey, and the hotkeys a settings patch may carry. */
const HotkeyRecordSchema = z.strictObject({
  readSelection: z.string(),
  readRegion: z.string(),
  togglePlay: z.string(),
  nextSentence: z.string(),
  previousSentence: z.string(),
  faster: z.string(),
  slower: z.string(),
  toggleMini: z.string(),
  showMain: z.string(),
});

/** One registration state per action, as the shell reports it. */
const HotkeyStateRecordSchema = z.strictObject({
  readSelection: z.enum(["registered", "failed", "pending"]),
  readRegion: z.enum(["registered", "failed", "pending"]),
  togglePlay: z.enum(["registered", "failed", "pending"]),
  nextSentence: z.enum(["registered", "failed", "pending"]),
  previousSentence: z.enum(["registered", "failed", "pending"]),
  faster: z.enum(["registered", "failed", "pending"]),
  slower: z.enum(["registered", "failed", "pending"]),
  toggleMini: z.enum(["registered", "failed", "pending"]),
  showMain: z.enum(["registered", "failed", "pending"]),
});

/** What the shell keeps between runs (F§10.3), as one validated record. */
export const DesktopSettingsSchema = z.strictObject({
  hotkeys: HotkeyRecordSchema,
  watchFolders: z.array(z.string()),
  miniBounds: z.strictObject({ x: z.number(), y: z.number() }).nullable(),
  processedFiles: z.array(z.string()),
});

/** A change to the settings: any subset of the record, and nothing else. */
export const DesktopSettingsPatchSchema = DesktopSettingsSchema.partial();

/** What the shell reports about itself (F§10.3). */
export const DesktopStatusSchema = z.strictObject({
  hotkeys: HotkeyStateRecordSchema,
  selectionProvider: z.string(),
  watchers: z.array(z.strictObject({ folder: z.string(), ok: z.boolean(), error: z.string().exactOptional() })),
});

/** The files the shell read for the app to import (F§10.3), already in memory. */
export const DesktopImportRequestSchema = z.strictObject({
  files: z.array(z.strictObject({ name: z.string(), mime: z.string(), bytes: z.instanceof(Uint8Array) })),
  play: z.boolean(),
  folderName: z.string().exactOptional(),
});

/** The text the shell read for the app to play at once (F§10.3). */
export const DesktopReadRequestSchema = z.strictObject({ text: z.string(), title: z.string() });

/** What the main process may push to a renderer, by channel. A channel that is not here cannot be pushed
 * on, which is how an outbound message is validated by construction rather than by remembering to. */
export const OUTBOUND_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  [IPC_CHANNELS.playerSnapshot]: PlayerBusSnapshotPayloadSchema,
  [IPC_CHANNELS.playerCommand]: PlayerCommandSchema,
  [IPC_CHANNELS.importRequest]: DesktopImportRequestSchema,
  [IPC_CHANNELS.readText]: DesktopReadRequestSchema,
  [IPC_CHANNELS.settingsStatus]: DesktopStatusSchema,
};

/** What a payload is refused with: the channel, and what the schema objected to. */
export class IpcPayloadError extends Error {
  constructor(channel: string, detail: string) {
    super(`the payload for ${channel} was refused: ${detail}`);
    this.name = "IpcPayloadError";
  }
}

/** The `ipcMain` surface `handle` speaks through: Electron's own, or a stand-in in a test. */
export interface IpcHandlerHost {
  handle(channel: string, listener: (event: unknown, payload: unknown) => unknown): void;
}

/** The `WebContents` surface `send` speaks through. */
export interface IpcSender {
  send(channel: string, payload: unknown): void;
}

/** The first problem a failed parse reports, as one line. */
function firstProblem(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "it does not match the schema";
  const path = issue.path.join(".");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
}

/**
 * `handle(host, channel, schema, handler)` — answer an invoke on `channel` with the validated payload.
 *
 * A payload that does not parse rejects the renderer's call with an `IpcPayloadError` naming the channel and
 * the offending field, and the handler is never run: the shell answers a malformed request the way it
 * answers a request it cannot serve, rather than by acting on half of it.
 */
export function handle<T>(host: IpcHandlerHost, channel: IpcChannel, schema: z.ZodType<T>, handler: (payload: T) => unknown): void {
  host.handle(channel, (_event, payload: unknown) => {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw new IpcPayloadError(channel, firstProblem(parsed.error));
    return handler(parsed.data);
  });
}

/**
 * `send(sender, channel, schema, payload)` — push a validated payload to a renderer.
 *
 * The main process is the only side that pushes unprompted, so this is the direction the renderer cannot
 * check for itself; validating here is what makes the promise F§11 makes about the boundary — everything
 * that crosses it has the declared shape — hold in both directions.
 */
export function send<T>(sender: IpcSender, channel: IpcChannel, schema: z.ZodType<T>, payload: unknown): void {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new IpcPayloadError(channel, firstProblem(parsed.error));
  sender.send(channel, parsed.data);
}

/** The schema the main process pushes on `channel`, or a refusal naming the channel. */
export function outboundSchema(channel: IpcChannel): z.ZodType {
  const schema = OUTBOUND_SCHEMAS[channel];
  if (schema === undefined) throw new IpcPayloadError(channel, "the main process never pushes on this channel");
  return schema;
}

/** The types the bridge promises on each channel, as `@lectern/ui-web` declares them. */
export type { DesktopImportRequest, DesktopReadRequest, DesktopSettings, DesktopStatus, PlayerBusSnapshot, PlayerCommand };
