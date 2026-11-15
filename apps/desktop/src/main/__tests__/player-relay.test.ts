/**
 * The player's relay (F§10.3, F§10.1).
 *
 * Every case drives the relay through the surfaces the shell hands it rather than through Electron: the
 * channels it takes over (a stand-in for `ipcMain`, which is a map of one handler per channel), the action bus
 * (a set of listeners registered for one action each), and the shell's own push to the main window. The
 * mini-player's window is a stand-in too, so what a case asserts is what the relay sends, where it sends it,
 * and in which order — including the adapter it installs into the page before handing the state over, which is
 * the one part of the relay that can only be seen from the outside.
 */

import { clampRate, RATE_MAX, RATE_MIN } from "@lectern/core";
import { describe, expect, test, vi } from "vitest";
import { type DesktopAction, DesktopActionSchema, IPC_CHANNELS, IpcPayloadError } from "../ipc";
import {
  commandForAction,
  MINI_BRIDGE_SOURCE,
  type MiniPlayerTarget,
  type PlayerRelayChannels,
  type PlayerRelayContext,
  RATE_INCREMENT,
  registerPlayerRelay,
  stepRate,
} from "../player-relay";

/** A published snapshot: F§10.3's bus snapshot, as `@lectern/ui-web` builds one. */
const SNAPSHOT = {
  state: "playing",
  docId: "8f14e45fceea167a",
  sentenceIndex: 0,
  wordIndex: 1,
  rate: 2,
  voiceId: "mock:mock-a",
  sleepRemainingMs: null,
  error: null,
  title: "Harbour Light",
  active: { sentenceIndex: 0, wordIndex: 1 },
  progressFraction: 0.25,
  remainingMs: 12_400,
  baseWpm: 170,
};

/** One payload the relay was handed, and the channel it went out on. */
interface Delivery {
  channel: string;
  payload: unknown;
}

/** A stand-in for `ipcMain`: one handler per channel, which is what `removeHandler` and `handle` maintain. */
interface FakeChannels extends PlayerRelayChannels {
  raise(channel: string, payload: unknown): Promise<unknown>;
}

function fakeChannels(): FakeChannels {
  const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
  return {
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
    async raise(channel, payload) {
      const bound = handlers.get(channel);
      if (bound === undefined) throw new Error(`nothing answers on ${channel}`);
      return await bound(null, payload);
    },
  };
}

/** A stand-in for the shell: the action bus, and the push to the main window the relay keeps as the echo. */
interface FakeShell extends PlayerRelayContext {
  sent: Delivery[];
  raiseAction(action: DesktopAction): void;
}

function fakeShell(): FakeShell {
  const listeners = new Set<{ action: DesktopAction; handler: (action: DesktopAction) => void }>();
  const sent: Delivery[] = [];
  return {
    actions: {
      on(action, handler) {
        const registered = { action, handler };
        listeners.add(registered);
        return () => {
          listeners.delete(registered);
        };
      },
    },
    sendToMain(channel, payload) {
      sent.push({ channel, payload });
    },
    sent,
    raiseAction(action) {
      for (const registered of [...listeners]) {
        if (registered.action === action) registered.handler(action);
      }
    },
  };
}

/** A stand-in for the mini-player's window: what it was sent, and the scripts it was asked to run. */
interface FakeMini extends MiniPlayerTarget {
  sent: Delivery[];
  scripts: string[];
}

function fakeMini(): FakeMini {
  const sent: Delivery[] = [];
  const scripts: string[] = [];
  return {
    sent,
    scripts,
    send(channel, payload) {
      sent.push({ channel, payload });
    },
    async executeJavaScript(code) {
      scripts.push(code);
      return undefined;
    },
  };
}

describe("one action, one command", () => {
  test("the five player actions map to the commands F§5.7 defines, and the other four map to nothing", () => {
    expect(commandForAction("togglePlay", 1)).toEqual({ type: "toggle" });
    expect(commandForAction("nextSentence", 1)).toEqual({ type: "skip", sentences: 1 });
    expect(commandForAction("previousSentence", 1)).toEqual({ type: "skip", sentences: -1 });
    expect(commandForAction("faster", 1)).toEqual({ type: "setRate", rate: 1.1 });
    expect(commandForAction("slower", 1)).toEqual({ type: "setRate", rate: 0.9 });

    // The five are exactly the player's: an action this unit has not thought about cannot silently become one.
    const mapped = DesktopActionSchema.options.filter((action) => commandForAction(action, 1) !== null);
    expect(mapped).toEqual(["togglePlay", "nextSentence", "previousSentence", "faster", "slower"]);
    for (const action of ["readSelection", "readRegion", "toggleMini", "showMain"] as const) {
      expect(commandForAction(action, 1)).toBeNull();
    }
  });

  test("a step is a tenth, and stops at the range's ends", () => {
    expect(RATE_INCREMENT).toBe(0.1);
    expect(stepRate(1, RATE_INCREMENT)).toBe(1.1);
    expect(stepRate(1.1, -RATE_INCREMENT)).toBe(1);
    // The step is asked for in tenths, so it lands on one however the rate arrived.
    expect(stepRate(2.35, RATE_INCREMENT)).toBe(2.5);
    expect(stepRate(0.95, RATE_INCREMENT)).toBe(1.1);
    expect(stepRate(1.05, -RATE_INCREMENT)).toBe(1);

    // F§5.6(e)'s range is where a step stops, in both directions and beyond both ends.
    expect(commandForAction("faster", RATE_MAX)).toEqual({ type: "setRate", rate: RATE_MAX });
    expect(commandForAction("slower", RATE_MIN)).toEqual({ type: "setRate", rate: RATE_MIN });
    expect(commandForAction("faster", 4.95)).toEqual({ type: "setRate", rate: RATE_MAX });
    expect(commandForAction("slower", 0.55)).toEqual({ type: "setRate", rate: RATE_MIN });
    expect(stepRate(RATE_MAX, RATE_INCREMENT)).toBe(clampRate(RATE_MAX + RATE_INCREMENT));
  });
});

describe("the relay", () => {
  test("takes the player's channels over, and carries the host's state to the main window and its own subscribers", async () => {
    const channels = fakeChannels();
    const shell = fakeShell();
    const stale: unknown[] = [];
    channels.handle(IPC_CHANNELS.playerPublish, (_event, payload) => {
      stale.push(payload);
      return undefined;
    });
    const relay = registerPlayerRelay(shell, { channels });
    const subscriber = vi.fn();
    relay.onSnapshot(subscriber);

    expect(relay.last()).toBeNull();
    await channels.raise(IPC_CHANNELS.playerPublish, SNAPSHOT);

    // The channel changed hands: the handler bound before the relay never saw the payload.
    expect(stale).toEqual([]);
    expect(relay.last()).toEqual(SNAPSHOT);
    expect(subscriber).toHaveBeenCalledWith(SNAPSHOT);
    // The echo the main window's own views subscribe to is still sent (U-038's case asserts it).
    expect(shell.sent).toEqual([{ channel: IPC_CHANNELS.playerSnapshot, payload: SNAPSHOT }]);
  });

  test("carries a remote's command to the host, and refuses a payload that is not one", async () => {
    const channels = fakeChannels();
    const shell = fakeShell();
    registerPlayerRelay(shell, { channels });

    await channels.raise(IPC_CHANNELS.playerSend, { type: "pause" });
    expect(shell.sent).toEqual([{ channel: IPC_CHANNELS.playerCommand, payload: { type: "pause" } }]);

    // A snapshot is not a command, and a command is not a snapshot: each is refused by the channel that took it.
    await expect(channels.raise(IPC_CHANNELS.playerSend, SNAPSHOT)).rejects.toBeInstanceOf(IpcPayloadError);
    await expect(channels.raise(IPC_CHANNELS.playerPublish, { type: "pause" })).rejects.toBeInstanceOf(IpcPayloadError);
    expect(shell.sent).toHaveLength(1);
  });

  test("keeps the last state and hands it to a mini-player that opens late", async () => {
    const channels = fakeChannels();
    const shell = fakeShell();
    const relay = registerPlayerRelay(shell, { channels });

    // A window that opens before anything has been read is joined to the bridge and handed nothing.
    const early = fakeMini();
    await relay.attach(early);
    expect(early.scripts).toEqual([MINI_BRIDGE_SOURCE]);
    expect(early.sent).toEqual([]);

    // ...and the state it is there for arrives as soon as there is one.
    await channels.raise(IPC_CHANNELS.playerPublish, SNAPSHOT);
    expect(early.sent).toEqual([{ channel: IPC_CHANNELS.playerSnapshot, payload: SNAPSHOT }]);

    // A window that opens in the middle of a reading is handed the state it missed, in that order.
    const late = fakeMini();
    await relay.attach(late);
    expect(late.scripts).toEqual([MINI_BRIDGE_SOURCE]);
    expect(late.sent).toEqual([{ channel: IPC_CHANNELS.playerSnapshot, payload: SNAPSHOT }]);

    // Handing the relay `null` stops the fan-out to that window.
    await relay.attach(null);
    await channels.raise(IPC_CHANNELS.playerPublish, { ...SNAPSHOT, sentenceIndex: 3 });
    expect(late.sent).toHaveLength(1);
    expect(relay.last()?.sentenceIndex).toBe(3);
  });

  test("turns F§10.3's player actions into commands, stepped from the state the host published", async () => {
    const channels = fakeChannels();
    const shell = fakeShell();
    const relay = registerPlayerRelay(shell, { channels });
    const commands = (): unknown[] =>
      shell.sent.filter((delivery) => delivery.channel === IPC_CHANNELS.playerCommand).map((delivery) => delivery.payload);

    // Before anything has been read there is no rate to step, so the step starts from F§5.6(e)'s default.
    shell.raiseAction("faster");
    expect(commands()).toEqual([{ type: "setRate", rate: 1.1 }]);

    await channels.raise(IPC_CHANNELS.playerPublish, SNAPSHOT);
    shell.raiseAction("togglePlay");
    shell.raiseAction("nextSentence");
    shell.raiseAction("previousSentence");
    shell.raiseAction("slower");
    expect(commands().slice(1)).toEqual([
      { type: "toggle" },
      { type: "skip", sentences: 1 },
      { type: "skip", sentences: -1 },
      // The rate comes from the published state (2), not from the 1.1 the first step happened to land on.
      { type: "setRate", rate: 1.9 },
    ]);
    expect(relay.command("faster")).toEqual({ type: "setRate", rate: 2.1 });
    expect(relay.command("readSelection")).toBeNull();
  });

  test("raises nothing for an action that is not the player's", async () => {
    const channels = fakeChannels();
    const shell = fakeShell();
    registerPlayerRelay(shell, { channels });

    for (const action of ["readSelection", "readRegion", "toggleMini", "showMain"] as const) shell.raiseAction(action);
    expect(shell.sent).toEqual([]);
  });
});
