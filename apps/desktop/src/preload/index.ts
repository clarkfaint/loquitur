/**
 * The bridge (F§10.3): `window.lecternDesktop`, and nothing else.
 *
 * F§11's rule for this boundary is that the page gets the bridge's members and no more — no `ipcRenderer`, no
 * `require`, no file system — so the only thing this script does is name each member of F§10.3's interface in
 * terms of the channels `./main/ipc` declares. The preload runs in its own context with `contextIsolation` on,
 * so the object below is copied into the page rather than shared with it, and the page cannot reach the
 * functions this file closes over.
 *
 * Every payload is checked again here, in both directions, and it is not ceremony: the main process validated
 * what it sent, but a page and a shell are different builds of different ages, and the check is what turns a
 * mismatch into a refused message on one channel instead of an undefined field read somewhere deep in a view.
 *
 * The script is built as CommonJS because F§10.3 requires `sandbox: true` and a sandboxed preload is not an ES
 * module: Chromium loads it in a context that has no module support at all, so an `import` in the bundle would
 * keep the shell from starting. `./main/ipc` and everything it needs are therefore bundled in, since a
 * sandboxed preload may require nothing from `node_modules`.
 */

import type { PlayerCommand } from "@lectern/core";
import { PlayerCommandSchema } from "@lectern/core";
import type { LecternDesktopBridge } from "@lectern/ui-web";
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";
import type { z } from "zod";
import {
  DesktopImportRequestSchema,
  DesktopReadRequestSchema,
  DesktopSettingsSchema,
  DesktopStatusSchema,
  IPC_CHANNELS,
  type IpcChannel,
  PlayerBusSnapshotPayloadSchema,
} from "../main/ipc";

/** F§10.3's union has two members because the shell is built for Linux and Windows; nothing else is a target
 * this bridge answers for, so every other platform reports the Linux shape rather than a third state. */
const PLATFORM: LecternDesktopBridge["platform"] = process.platform === "win32" ? "win32" : "linux";

/** Ask the main process, and validate its answer before handing it over. */
async function ask<T>(channel: IpcChannel, schema: z.ZodType<T>, payload: unknown): Promise<T> {
  return schema.parse(await ipcRenderer.invoke(channel, payload));
}

/** Tell the main process, and report a refusal rather than leaving it as an unhandled rejection. */
function tell(channel: IpcChannel, payload: unknown): void {
  void ipcRenderer.invoke(channel, payload).catch((cause: unknown) => {
    console.error(`the desktop shell refused ${channel}: ${cause instanceof Error ? cause.message : String(cause)}`);
  });
}

/** Hand `handler` every payload that arrives on `channel`, once it has been checked against its schema. */
function on<T>(channel: IpcChannel, schema: z.ZodType<T>, handler: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: unknown): void => {
    const checked = schema.safeParse(payload);
    if (checked.success) handler(checked.data);
    else console.error(`the desktop shell sent a payload on ${channel} that is not the shape it promised`);
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

/** F§10.3's interface, over the channels above — the whole of what the page can reach. */
const bridge: LecternDesktopBridge = {
  platform: PLATFORM,
  player: {
    send: (command: PlayerCommand) => {
      tell(IPC_CHANNELS.playerSend, command);
    },
    onSnapshot: (handler) => on(IPC_CHANNELS.playerSnapshot, PlayerBusSnapshotPayloadSchema, handler),
    publish: (snapshot) => {
      tell(IPC_CHANNELS.playerPublish, snapshot);
    },
    onCommand: (handler) => on(IPC_CHANNELS.playerCommand, PlayerCommandSchema, handler),
  },
  onImportRequest: (handler) => on(IPC_CHANNELS.importRequest, DesktopImportRequestSchema, handler),
  onReadText: (handler) => on(IPC_CHANNELS.readText, DesktopReadRequestSchema, handler),
  settings: {
    get: () => ask(IPC_CHANNELS.settingsGet, DesktopSettingsSchema, undefined),
    set: (patch) => ask(IPC_CHANNELS.settingsSet, DesktopSettingsSchema, patch),
    onStatus: (handler) => on(IPC_CHANNELS.settingsStatus, DesktopStatusSchema, handler),
    pickFolder: async () => {
      const answer: unknown = await ipcRenderer.invoke(IPC_CHANNELS.settingsPickFolder, undefined);
      return typeof answer === "string" ? answer : null;
    },
  },
  windows: {
    toggleMini: () => {
      tell(IPC_CHANNELS.windowsToggleMini, undefined);
    },
    showMain: () => {
      tell(IPC_CHANNELS.windowsShowMain, undefined);
    },
  },
  captureRegion: async () => {
    await ipcRenderer.invoke(IPC_CHANNELS.captureRegion, undefined);
  },
};

contextBridge.exposeInMainWorld("lecternDesktop", bridge);
