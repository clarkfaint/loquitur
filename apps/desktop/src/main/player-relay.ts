/**
 * The player's relay (F§10.3, F§10.1): the one place in the shell where the player's state and its commands
 * cross between the window that owns the audio and everything that mirrors it.
 *
 * F§10.1's bus has two ends — a **host**, which is the reader whose page holds the audio, and a **remote**,
 * which paints what the host publishes and answers it with commands — and F§10.3 carries it across the shell
 * with one bridge channel per direction. The relay is the main-process middle of that bus:
 *
 * - a remote's **command** — the mini-player's buttons, the tray's Play or Pause and Next sentence, a global
 *   shortcut — becomes one `PlayerCommand` for the host (`commandForAction`) and reaches it on the command
 *   channel;
 * - the host's **published state** reaches the main window (its own echo, which is what a view inside the
 *   host's page subscribes to), the mini-player's window and the tray, whose first entry follows it.
 *
 * Both directions therefore pass through one module: the relay takes the shell's two player channels over
 * (`ipcMain` allows one handler per channel, so it removes the pair the context bound and answers them here),
 * and the last snapshot is kept, because F§10.1 defines no handshake — a mini-player that opens in the middle
 * of a reading is handed the state it missed the moment its page is ready.
 *
 * One join is worth naming, because it is the reason this module installs a script into the mini-player's
 * window. The mini-player's page is F§10.1's `BroadcastChannel` remote — the same page serves a browser tab,
 * where there is no bridge — while the reader inside the shell publishes over F§10.3's bridge, so the two ends
 * of the bus speak different transports. The relay is the only place that holds both, so it carries the bridge
 * into that page: the adapter below re-posts the bridge's snapshots onto the page's own channel and forwards
 * the commands the page sends back out over the bridge. Nothing else about the page changes, and the page still
 * holds no player of its own (F§10.3's rule that all audio stays in the main window).
 *
 * Nothing here imports Electron: the channels are handed in (`registerPlayerRelay(context, { channels })`),
 * which is also what lets the whole relay be exercised with a stand-in for `ipcMain`.
 */

import { clampRate, type PlayerCommand, PlayerCommandSchema } from "@lectern/core";
import type { PlayerBusSnapshot } from "@lectern/ui-web";
import {
  type DesktopAction,
  handle,
  IPC_CHANNELS,
  type IpcChannel,
  type IpcHandlerHost,
  type IpcSender,
  PlayerBusSnapshotPayloadSchema,
  send,
} from "./ipc";

/** One step of `faster` and `slower`, at a tenth of a rate (F§10.3). */
export const RATE_INCREMENT = 0.1;

/** The granularity one step lands on: a tenth of a rate. */
const TENTH = 10;

/** The rate `faster` and `slower` start from before the host has published anything (F§5.6(e)'s own default). */
const DEFAULT_RATE = 1;

/** The five of F§10.3's actions that are the player's; the other four belong to the windows and the reader. */
const MIRRORED_ACTIONS: readonly DesktopAction[] = ["togglePlay", "nextSentence", "previousSentence", "faster", "slower"];

/** The channel F§10.1's bus meets on: `@lectern/ui-web`'s `PLAYER_CHANNEL`, spelled out here because that
 * module is a barrel of React components and importing it into the main bundle would drag the renderer's
 * libraries in behind it. The adapter below is built from this one constant, so the two spellings cannot drift. */
const PLAYER_CHANNEL = "lectern-player";

/** What the adapter leaves behind in the page, so a reload replaces it rather than stacking a second one. */
const ADAPTER_FLAG = "__lecternMiniBridge";

/**
 * The page-side half of F§10.1's bus, run inside the mini-player's window (see `MiniPlayerTarget`).
 *
 * It is deliberately tiny, and it is deliberately not a player: it holds no state, makes no decisions, and
 * carries exactly the two message shapes the bus already defines. A snapshot arriving over the bridge is
 * posted onto the page's own channel, and a command the page posts is sent back over the bridge, which is the
 * direction F§10.1 gives a remote. It installs once per page (`ADAPTER_FLAG`) and does nothing at all in a
 * page that has no bridge.
 */
export const MINI_BRIDGE_SOURCE = `(() => {
  if (globalThis[${JSON.stringify(ADAPTER_FLAG)}] === true) return;
  const bridge = globalThis["lecternDesktop"];
  if (bridge === undefined || bridge === null) return;
  const channel = new BroadcastChannel(${JSON.stringify(PLAYER_CHANNEL)});
  channel.addEventListener("message", (event) => {
    let message = null;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message === null || message.kind !== "command") return;
    bridge.player.send(message.command);
  });
  bridge.player.onSnapshot((snapshot) => {
    channel.postMessage(JSON.stringify({ kind: "snapshot", snapshot }));
  });
  globalThis[${JSON.stringify(ADAPTER_FLAG)}] = true;
})()`;

/** The far end the relay pushes the player's state into: the mini-player's own window. */
export interface MiniPlayerTarget extends IpcSender {
  /** Run a script in that window's page, which is how the page-side bridge above is installed. */
  executeJavaScript(code: string): Promise<unknown>;
}

/** What the relay needs of the shell: F§10.3's action bus, and the shell's own push to the main window. */
export interface PlayerRelayContext {
  actions: { on(action: DesktopAction, handler: (action: DesktopAction) => void): () => void };
  sendToMain(channel: IpcChannel, payload: unknown): void;
}

/** The `ipcMain` surface the relay takes the player's channels over through: Electron's own, or a stand-in. */
export interface PlayerRelayChannels extends IpcHandlerHost {
  /** Drop the handler bound to `channel`, which is how one channel changes hands. */
  removeHandler(channel: string): void;
}

/** How the relay is registered. */
export interface PlayerRelayOptions {
  channels: PlayerRelayChannels;
}

/** What a registered relay offers the rest of the shell. */
export interface PlayerRelay {
  /** The last state the host published, or `null` before a document has been read. */
  last(): PlayerBusSnapshot | null;
  /** Run `handler` on every state the relay carries from now on. */
  onSnapshot(handler: (snapshot: PlayerBusSnapshot) => void): () => void;
  /** The command one of F§10.3's actions means, stepped against the state the host last published. */
  command(action: DesktopAction): PlayerCommand | null;
  /** Take `target` as the mini-player's far end, or hand the relay `null` when its window goes away. */
  attach(target: MiniPlayerTarget | null): Promise<void>;
}

/**
 * `stepRate(rate, delta)` — one step of F§10.3's ±0.1, kept on a tenth and inside F§5.6(e)'s 0.5–5.0.
 *
 * The rounding is not decoration: the step is asked for in decimal tenths, and a rate that has been through
 * one is what the reader's control, the settings record and the hub's chunk id are all compared against.
 */
export function stepRate(rate: number, delta: number): number {
  return clampRate(Math.round((rate + delta) * TENTH) / TENTH);
}

/**
 * `commandForAction(action, rate)` — the command one of F§10.3's actions means for the player, or `null` when
 * the action is not the player's.
 *
 * `faster` and `slower` are the two that need the state rather than only the action, which is why the rate is
 * asked for rather than kept here: the ends of the range belong to whatever the host last published, so a
 * shortcut pressed at 5× cannot walk the rate past it.
 */
export function commandForAction(action: DesktopAction, rate: number): PlayerCommand | null {
  switch (action) {
    case "togglePlay":
      return { type: "toggle" };
    case "nextSentence":
      return { type: "skip", sentences: 1 };
    case "previousSentence":
      return { type: "skip", sentences: -1 };
    case "faster":
      return { type: "setRate", rate: stepRate(rate, RATE_INCREMENT) };
    case "slower":
      return { type: "setRate", rate: stepRate(rate, -RATE_INCREMENT) };
    default:
      return null;
  }
}

/**
 * `registerPlayerRelay(context, options)` — bind the player's two channels and answer F§10.3's player actions.
 *
 * Called once, by the shell's own feature, after the app is ready. The relay lives as long as the shell does,
 * so nothing here is unwound — a feature that has registered has no reason to stop listening.
 */
export function registerPlayerRelay(context: PlayerRelayContext, options: PlayerRelayOptions): PlayerRelay {
  const channels = options.channels;
  const snapshotHandlers = new Set<(snapshot: PlayerBusSnapshot) => void>();
  let last: PlayerBusSnapshot | null = null;
  let target: MiniPlayerTarget | null = null;

  /** Carry one published state to wherever it has to go: the shell's echo, the mini-player, the tray. */
  function publish(snapshot: PlayerBusSnapshot): void {
    last = snapshot;
    for (const handler of [...snapshotHandlers]) handler(snapshot);
    if (target !== null) send(target, IPC_CHANNELS.playerSnapshot, PlayerBusSnapshotPayloadSchema, snapshot);
  }

  // The host's own state. The echo to the main window is the shell's, unchanged from the context's binding;
  // the fan-out to the mini-player and the tray is what the relay adds to it. A payload that is not the shape
  // the bridge promises never becomes a snapshot and never leaves here (`handle` refuses it by name).
  channels.removeHandler(IPC_CHANNELS.playerPublish);
  handle(channels, IPC_CHANNELS.playerPublish, PlayerBusSnapshotPayloadSchema, (snapshot) => {
    publish(snapshot);
    context.sendToMain(IPC_CHANNELS.playerSnapshot, snapshot);
  });

  // A remote's own command — the mini-player's buttons, which the page-side bridge sends over the bridge.
  channels.removeHandler(IPC_CHANNELS.playerSend);
  handle(channels, IPC_CHANNELS.playerSend, PlayerCommandSchema, (command) => {
    context.sendToMain(IPC_CHANNELS.playerCommand, command);
  });

  // The tray's entries and the global shortcuts raise actions (F§10.3), and the five that are the player's
  // become commands for the host — the same route the keyboard and the tray share, which is the point of the
  // one action bus.
  for (const action of MIRRORED_ACTIONS) {
    context.actions.on(action, (raised) => {
      const command = commandForAction(raised, last?.rate ?? DEFAULT_RATE);
      if (command !== null) context.sendToMain(IPC_CHANNELS.playerCommand, command);
    });
  }

  /** The command one action means right now: the relay's own mapping, against the state the host last sent. */
  function command(action: DesktopAction): PlayerCommand | null {
    return commandForAction(action, last?.rate ?? DEFAULT_RATE);
  }

  async function attach(next: MiniPlayerTarget | null): Promise<void> {
    target = next;
    if (next === null) return;
    // The page has to be running the adapter before the state is handed over, or the snapshot the window
    // missed would be posted onto a channel nothing is listening to yet.
    await next.executeJavaScript(MINI_BRIDGE_SOURCE).catch(() => undefined);
    const snapshot = last;
    if (snapshot !== null) send(next, IPC_CHANNELS.playerSnapshot, PlayerBusSnapshotPayloadSchema, snapshot);
  }

  return {
    last: () => last,
    onSnapshot(handler) {
      snapshotHandlers.add(handler);
      return () => {
        snapshotHandlers.delete(handler);
      };
    },
    command,
    attach,
  };
}
