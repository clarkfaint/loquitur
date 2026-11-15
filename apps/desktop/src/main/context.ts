/**
 * The shell's context (F§10.3): the one object every feature, every window and every channel handler is
 * given, so nothing in the shell has to reach for a global to find the settings, the action bus or a window.
 *
 * It is built in one place, before the app is ready, because the channels must be answerable from the first
 * moment a renderer can ask — the settings screen is the only way into the app, and it asks for the settings
 * before any window has been shown. The main window is the one member that arrives later: `index.ts` creates it
 * after `ready`, and `windows.main` is `null` until then.
 *
 * The settings surface is F§10.3's own: read the record, change it, subscribe to a change, subscribe to the
 * shell's status, and ask the operator for a folder. What this unit owes is the record and the channel that
 * hands it over; the things a later feature does with it — registering F§10.3's global shortcuts (U-039),
 * watching the folders for new files — act on the same record without this module changing.
 *
 * This is the only module that talks to `ipcMain`, and it does so through `./ipc`'s two helpers, so every
 * payload that reaches a handler has already been validated and every payload that leaves one is validated
 * before it goes.
 */

import { PlayerCommandSchema } from "@lectern/core";
import { type BrowserWindow, type Dialog, dialog, ipcMain, type OpenDialogOptions } from "electron";
import { type DesktopAction, emitAction, onAction } from "./actions";
import {
  handle as bindChannel,
  DesktopSettingsPatchSchema,
  DesktopSettingsSchema,
  IPC_CHANNELS,
  type IpcChannel,
  type IpcHandlerHost,
  NO_PAYLOAD,
  outboundSchema,
  PlayerBusSnapshotPayloadSchema,
  send,
} from "./ipc";
import { createSettingsStore, type DesktopSettingsStore, type DesktopStatus } from "./settings-store";

/** The main window, as the rest of the shell names it. */
export interface DesktopWindows {
  /** The window that carries the app, or `null` before `index.ts` has created it. */
  main: BrowserWindow | null;
  /** Bring the main window forward: one action on the bus, answered by the window itself. */
  showMain(): void;
  /** Show or hide the mini-player: one action on the bus, answered by the mini-player feature (U-039). */
  toggleMini(): void;
}

/** The settings surface F§10.3's bridge promises, plus the store underneath it. */
export interface DesktopSettingsService extends DesktopSettingsStore {
  /** Ask the operator for a folder — a native picker, with the main window as its parent when there is one. */
  pickFolder(): Promise<string | null>;
}

/**
 * Everything the shell's parts share.
 *
 * `status` is a live view of the store's own status rather than a copy, so a feature that publishes one is
 * seen by whichever feature asks next without a second bookkeeping step.
 */
export interface MainContext {
  settings: DesktopSettingsService;
  actions: {
    emit(action: DesktopAction): void;
    on(action: DesktopAction, handler: (action: DesktopAction) => void): () => void;
  };
  windows: DesktopWindows;
  readonly status: DesktopStatus;
  /** Push a validated payload to the renderer (see `./ipc` for which channels may carry one). */
  sendToMain(channel: IpcChannel, payload: unknown): void;
}

/** How the context is built: where the record lives, and the picker's own surface. */
export interface MainContextOptions {
  /** The directory the settings record is kept in, as `settingsDirectory` decides. */
  settingsDir: string;
  /** Electron's `dialog`, or a stand-in. */
  picker?: Pick<Dialog, "showOpenDialog">;
  /** Electron's `ipcMain`, or a stand-in. */
  host?: IpcHandlerHost;
}

/**
 * `createMainContext(options)` — the context, with every channel the renderer can ask on already answered.
 *
 * Each handler validates its payload before it does anything (`./ipc`), and each answers what the preload
 * promised: the settings, the changed settings, a folder's path or `null`, and nothing at all for the members
 * that only raise an action.
 */
export function createMainContext(options: MainContextOptions): MainContext {
  const settings = createSettingsStore({ dir: options.settingsDir });
  const picker = options.picker ?? dialog;
  const host = options.host ?? { handle: ipcMain.handle.bind(ipcMain) };

  const windows: DesktopWindows = {
    main: null,
    showMain: () => {
      emitAction("showMain");
    },
    toggleMini: () => {
      emitAction("toggleMini");
    },
  };

  async function pickFolder(): Promise<string | null> {
    const properties: NonNullable<OpenDialogOptions["properties"]> = ["openDirectory"];
    const parent = windows.main;
    const answer = parent === null ? await picker.showOpenDialog({ properties }) : await picker.showOpenDialog(parent, { properties });
    const chosen = answer.filePaths[0];
    return answer.canceled || chosen === undefined ? null : chosen;
  }

  const ctx: MainContext = {
    settings: { ...settings, pickFolder },
    actions: { emit: emitAction, on: onAction },
    windows,
    get status(): DesktopStatus {
      return settings.status();
    },
    sendToMain(channel, payload) {
      const window = windows.main;
      // A payload with nowhere to go is dropped: the window is created after the context (F§10.3) and a
      // renderer that is not there yet has asked for nothing.
      if (window === null) return;
      send(window.webContents, channel, outboundSchema(channel), payload);
    },
  };

  bindChannel(host, IPC_CHANNELS.settingsGet, NO_PAYLOAD, async () => DesktopSettingsSchema.parse(await settings.get()));
  bindChannel(host, IPC_CHANNELS.settingsSet, DesktopSettingsPatchSchema, async (patch) => settings.set(patch));
  bindChannel(host, IPC_CHANNELS.settingsPickFolder, NO_PAYLOAD, async () => pickFolder());
  bindChannel(host, IPC_CHANNELS.windowsToggleMini, NO_PAYLOAD, () => ctx.windows.toggleMini());
  bindChannel(host, IPC_CHANNELS.windowsShowMain, NO_PAYLOAD, () => ctx.windows.showMain());
  // The region reader raises its action and answers as soon as the request is on the bus: the text it gathers
  // arrives on the `read-text` channel, which is how a selection and a screen region both reach the app
  // (F§10.3). F§10.3 does not say what this promise waits for; the reading is proposed in the evidence.
  bindChannel(host, IPC_CHANNELS.captureRegion, NO_PAYLOAD, () => {
    emitAction("readRegion");
  });
  bindChannel(host, IPC_CHANNELS.playerPublish, PlayerBusSnapshotPayloadSchema, (snapshot) => {
    ctx.sendToMain(IPC_CHANNELS.playerSnapshot, snapshot);
  });
  bindChannel(host, IPC_CHANNELS.playerSend, PlayerCommandSchema, (command) => {
    ctx.sendToMain(IPC_CHANNELS.playerCommand, command);
  });

  return ctx;
}
