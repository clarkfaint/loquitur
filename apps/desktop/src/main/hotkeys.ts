/**
 * F§10.3's global hotkeys (F§10.1's action bus, the OS's own shortcut surface).
 *
 * One feature, registered in `features.ts` after the window exists: it reads the accelerators the operator has
 * configured, hands each of them to Electron's `globalShortcut`, and makes the chord raise the action it is
 * bound to on the shell's one bus — so a hotkey, a tray entry and the mini-player's own buttons are the same
 * trigger, and nothing here has to know what any of them does. It then keeps the shell's own account of what it
 * holds (`F§10.3`'s `DesktopStatus.hotkeys`) up to date, and gives every chord up when the shell quits.
 *
 * Three decisions are worth naming.
 *
 * **A change is a diff.** The settings record is the operator's; each change is compared with the map in force
 * (`diffHotkeys`) and only what changed is given up and asked for, in that order. Re-registering everything
 * would fail on every chord this shell already holds — a second `register` of a held accelerator answers
 * `false` — and would misreport a working shortcut as failed.
 *
 * **The state of each action is the shell's report, not a hope.** A validated accelerator is handed over, and
 * the answer to that call is the state — except on a surface that reports the desktop's asynchronous
 * resolution (F§10.3's Wayland portal sentence), where a chord that has been asked for is `pending` until the
 * desktop says what it decided. When it does, the answer is read from the accelerators themselves
 * (`isRegistered`), never from the event's payload, so no shape of that payload is invented here. AGENTS.md §3
 * supplies installed types as the truth, and the installed `electron@45.3.1` declares no such event at all: the
 * branch below is therefore reached only by a surface that offers one, which is what the unit test drives.
 *
 * **The settings channel answers with the status.** F§10.3's `onStatus` is a one-way push, so a page that
 * subscribes after the last publish cannot ask for the state it missed — and the settings screen is exactly
 * that page, since the shell publishes its first status before any renderer exists. The renderer's own read of
 * the settings (`settings.get()`) is therefore where the shell announces itself again: this feature answers
 * that one channel, as U-039's relay answers the player's, publishing the current status as part of the answer
 * and leaving U-038's behaviour on it — the validated record — exactly as it was.
 */

import { app, globalShortcut, ipcMain } from "electron";
import type { DesktopAction } from "./actions";
import type { MainContext } from "./context";
import { diffHotkeys, type HotkeyMap, validateAccelerator } from "./hotkey-model";
import { handle as bindChannel, DesktopSettingsSchema, IPC_CHANNELS, type IpcHandlerHost, NO_PAYLOAD } from "./ipc";
import { type DesktopStatus, pendingStatus } from "./settings-store";

/** The registration state of one action, as F§10.3's status carries it. */
export type HotkeyState = DesktopStatus["hotkeys"][DesktopAction];

/**
 * The part of Electron's `globalShortcut` this feature uses, so the feature can be driven without an
 * application. `on` and `off` are present only on a surface that reports the desktop's asynchronous
 * resolution of a registration (F§10.3's portal sentence): Electron's own `globalShortcut` declares neither.
 */
export interface GlobalShortcutSurface {
  register(accelerator: string, callback: () => void): boolean;
  isRegistered(accelerator: string): boolean;
  unregister(accelerator: string): void;
  unregisterAll(): void;
  on?(event: string, listener: (details: unknown) => void): void;
  off?(event: string, listener: (details: unknown) => void): void;
}

/** The event a portal-mediated registration resolves on (F§10.3). */
export const PORTAL_RESOLUTION_EVENT = "registration-resolved";

/**
 * The application surface the quit handler is registered on.
 *
 * Electron's own `App` declares an overload per built-in event, and those overloads shadow the generic ones, so
 * the application object is named here as the one member this feature needs (the same reason `./actions` names
 * its own pair).
 */
export interface LifecycleSurface {
  on(event: "will-quit", listener: () => void): void;
}

/** The `ipcMain` surface: a handler host that can also give a channel up, which is how a binding changes hands. */
export interface HotkeyChannelHost extends IpcHandlerHost {
  removeHandler(channel: string): void;
}

/** What the feature offers back: the state it holds, and the way to let go of everything. */
export interface GlobalHotkeys {
  /** One state per action, as published in `DesktopStatus`. */
  status(): DesktopStatus["hotkeys"];
  /** Give up every chord, stop watching the settings, and stop answering the settings channel. */
  stop(): void;
}

/** How the feature is given its surfaces. Every one of them defaults to Electron's own. */
export interface GlobalHotkeyOptions {
  /** Electron's `globalShortcut`, or a stand-in. */
  shortcut?: GlobalShortcutSurface;
  /** Electron's `app`, or a stand-in. */
  lifecycle?: LifecycleSurface;
  /** Electron's `ipcMain`, or a stand-in. */
  channels?: HotkeyChannelHost;
}

/** What a trigger that could not do what it was asked is reported as: a shortcut has nowhere to show an error. */
function report(cause: unknown): void {
  console.error(`a global shortcut is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
}

/**
 * `registerGlobalHotkeys(ctx, options)` — bind the configured accelerators, keep their state, and let them go.
 *
 * The settings are read once to begin with, and every later change is compared with the map in force. Each
 * accelerator that is handed over carries the callback that raises its own action, so the callback a chord
 * fires and the action the tray raises are the same event on the same bus (F§10.3).
 */
export function registerGlobalHotkeys(ctx: MainContext, options: GlobalHotkeyOptions = {}): GlobalHotkeys {
  const shortcut: GlobalShortcutSurface = options.shortcut ?? globalShortcut;
  const lifecycle = options.lifecycle ?? (app as unknown as LifecycleSurface);
  const host: HotkeyChannelHost = options.channels ?? {
    handle: ipcMain.handle.bind(ipcMain),
    removeHandler: ipcMain.removeHandler.bind(ipcMain),
  };
  // A surface reports its registrations asynchronously only by offering an event to report them on.
  const portal: GlobalShortcutSurface | null = typeof shortcut.on === "function" ? shortcut : null;

  /** The accelerators the OS has been told about, as last applied. */
  let applied: HotkeyMap = {};
  /** What the shell says about each action. Nothing has been resolved to begin with (F§10.3's own starting point). */
  let states: DesktopStatus["hotkeys"] = { ...pendingStatus().hotkeys };
  /** The actions whose accelerators the desktop has not answered for yet. */
  const awaiting = new Set<DesktopAction>();

  /** Tell the store, and the renderer, what the shell holds. Both, because they are two different readers. */
  function publish(): void {
    const status: DesktopStatus = { ...ctx.settings.status(), hotkeys: { ...states } };
    ctx.settings.publishStatus(status);
    ctx.sendToMain(IPC_CHANNELS.settingsStatus, status);
  }

  /**
   * Hand one accelerator over, and answer what state it is in.
   *
   * An action with nothing bound is never handed over; a string that is not an accelerator is refused before the
   * OS sees it, which is the one way a `failed` state can be reached without the OS being asked at all.
   */
  function bind(action: DesktopAction, accelerator: string): HotkeyState {
    if (accelerator === "") return "pending";
    if (validateAccelerator(accelerator) !== null) return "failed";
    if (portal !== null) {
      portal.register(accelerator, () => {
        ctx.actions.emit(action);
      });
      awaiting.add(action);
      return "pending";
    }
    try {
      return shortcut.register(accelerator, () => {
        ctx.actions.emit(action);
      })
        ? "registered"
        : "failed";
    } catch (cause) {
      report(cause);
      return "failed";
    }
  }

  /** Bring the OS surface in line with `next`, and publish what that leaves the shell holding. */
  function apply(next: Readonly<Record<DesktopAction, string>>): void {
    const changes = diffHotkeys(applied, next);
    // Everything leaving first: two actions may swap accelerators, and a chord cannot be asked for while the
    // other action still holds it.
    for (const accelerator of changes.unregister) shortcut.unregister(accelerator);
    const nextStates = { ...states };
    for (const action of changes.register) nextStates[action] = bind(action, next[action]);
    applied = { ...next };
    states = nextStates;
    publish();
  }

  /** The desktop has decided: ask the accelerators it was asked about whether they are held. */
  function resolve(): void {
    if (awaiting.size === 0) return;
    const nextStates = { ...states };
    for (const action of awaiting) nextStates[action] = shortcut.isRegistered(applied[action] ?? "") ? "registered" : "failed";
    awaiting.clear();
    states = nextStates;
    publish();
  }

  // The first registration is a promise the settings channel waits on: a renderer that asks for the settings
  // must be answered with a status that reflects a shell which has really tried to bind its shortcuts.
  const ready = ctx.settings.get().then((settings) => {
    apply(settings.hotkeys);
  });
  ready.catch(report);

  if (portal !== null) portal.on?.(PORTAL_RESOLUTION_EVENT, resolve);

  const stopWatching = ctx.settings.onChange((settings) => {
    apply(settings.hotkeys);
  });

  const stop = (): void => {
    stopWatching();
    if (portal !== null) portal.off?.(PORTAL_RESOLUTION_EVENT, resolve);
    shortcut.unregisterAll();
  };

  // A shell that is quitting must not leave a chord held by a process that is gone (F§10.3).
  lifecycle.on("will-quit", stop);

  // U-039's pattern: `ipcMain` keeps one handler per channel, so the binding changes hands explicitly rather
  // than being added beside the old one. What this answers is what `./context` answered — the validated record
  // — with the shell's current status published as part of the answer.
  host.removeHandler(IPC_CHANNELS.settingsGet);
  bindChannel(host, IPC_CHANNELS.settingsGet, NO_PAYLOAD, async () => {
    await ready;
    const settings = await ctx.settings.get();
    publish();
    return DesktopSettingsSchema.parse(settings);
  });

  return {
    status: () => ({ ...states }),
    stop,
  };
}
