/**
 * The player bus (F§10.1): one player, several views.
 *
 * The reader tab owns the `PlayerController` (F§5.7) and is the bus's **host**: it publishes a snapshot
 * every time the player changes and runs any command a remote sends it. A mini-player window or a second tab
 * is a **remote**: it sends commands and paints the snapshots it receives. Two transports carry the two
 * directions — a `BroadcastChannel` between tabs of one browser, and the desktop shell's bridge (F§10.3)
 * between the shell's windows — and a transport is only ever asked to post one message and to hand back
 * whatever arrives.
 *
 * Nothing here trusts the wire. Every message is parsed against the zod union below before it is applied, so
 * a stray message on the channel, a message from an older build, or anything else that happens to share the
 * name is dropped rather than handed to a controller. The role is enforced at this boundary too: a host
 * applies commands and ignores snapshots, a remote applies snapshots and ignores commands, which is what
 * keeps a host from acting on the echo of its own publish.
 */

import { type PlayerCommand, PlayerCommandSchema, PlayerSnapshotSchema } from "@lectern/core";
import { z } from "zod";
import type { BusSnapshot, LecternDesktopBridge } from "../desktop-bridge";

/** The channel name the reader and its remotes meet on (F§10.1). */
export const PLAYER_CHANNEL = "lectern-player";

/** The word being read, in the shape a view paints it (F§5.6(d)). */
export const ActiveWordSchema = z.strictObject({
  sentenceIndex: z.int().nonnegative(),
  wordIndex: z.int().nonnegative(),
});
export type ActiveWord = z.infer<typeof ActiveWordSchema>;

/**
 * What a host publishes: F§10.3's `BusSnapshot` — the player's state and the document's title — plus the word
 * being read and the three figures F§10.1's player bar renders. The extra fields exist because F§10.3's
 * snapshot carries no word counts, so a remote window could not work out a progress fraction or a remaining
 * time for its own bar; a wider object is assignable to `BusSnapshot`, so the desktop bridge stays exactly as
 * F§10.3 writes it.
 */
export interface PlayerBusSnapshot extends BusSnapshot {
  active: ActiveWord;
  progressFraction: number;
  remainingMs: number;
  baseWpm: number;
}

/**
 * The published snapshot, validated. Its shape is F§5.7's own snapshot schema spread in rather than retyped,
 * so a field added to the player's snapshot cannot arrive here without a decision.
 */
export const PlayerBusSnapshotSchema = z.strictObject({
  ...PlayerSnapshotSchema.shape,
  title: z.string(),
  active: ActiveWordSchema,
  progressFraction: z.number(),
  remainingMs: z.number(),
  baseWpm: z.number(),
});

/** Everything that may cross the bus, and nothing else (F§10.1). */
export const PlayerBusMessageSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("snapshot"), snapshot: PlayerBusSnapshotSchema }),
  z.strictObject({ kind: z.literal("command"), command: PlayerCommandSchema }),
]);
export type PlayerBusMessage = z.infer<typeof PlayerBusMessageSchema>;

/**
 * One way of carrying a message (F§10.1). `post` sends a validated message to every other context; `subscribe`
 * hands back *whatever arrived* — a JSON string on a browser channel, a structured object on the desktop
 * bridge — because parsing and validating it is the bus's business, not the transport's. The returned function
 * unsubscribes.
 */
export interface PlayerBusTransport {
  post(message: PlayerBusMessage): void;
  subscribe(handler: (raw: unknown) => void): () => void;
}

/** A message read off a transport: the parsed object for a string, the value itself for anything else. */
function decode(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * `createBroadcastChannelTransport(channelName)` — F§10.1's `BroadcastChannel`.
 *
 * The channel is opened when it is first needed and closed when its last subscriber goes away, so a page that
 * holds one opens exactly one channel and a page that finishes with it leaves none behind; a later `post`
 * opens it again. Messages are serialised, because a `BroadcastChannel` carries structured-cloned values and
 * a string is the one shape both a browser and a desktop bridge can carry unchanged.
 */
export function createBroadcastChannelTransport(channelName: string): PlayerBusTransport {
  const handlers = new Set<(raw: unknown) => void>();
  let channel: BroadcastChannel | null = null;
  let detach: (() => void) | null = null;

  function open(): BroadcastChannel {
    if (channel !== null) return channel;
    const opened = new BroadcastChannel(channelName);
    const onMessage = (event: MessageEvent<unknown>): void => {
      for (const handler of [...handlers]) handler(event.data);
    };
    opened.addEventListener("message", onMessage);
    detach = () => {
      opened.removeEventListener("message", onMessage);
      opened.close();
    };
    channel = opened;
    return opened;
  }

  function close(): void {
    detach?.();
    detach = null;
    channel = null;
  }

  return {
    post(message) {
      open().postMessage(JSON.stringify(message));
    },
    subscribe(handler) {
      open();
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) close();
      };
    },
  };
}

/**
 * `createDesktopBridgeTransport(bridge)` — F§10.3's bridge.
 *
 * The bridge has a channel in each direction, so the transport routes by the message's own kind: a snapshot
 * goes out through `publish` (host to remotes) and a command through `send` (remote to host), and both of the
 * bridge's subscriptions feed the one handler. Which of the two a bus actually uses is the bus's role, not
 * this module's.
 */
export function createDesktopBridgeTransport(bridge: LecternDesktopBridge): PlayerBusTransport {
  const handlers = new Set<(raw: unknown) => void>();
  let detach: (() => void) | null = null;

  function open(): void {
    if (detach !== null) return;
    const offSnapshot = bridge.player.onSnapshot((snapshot) => {
      for (const handler of [...handlers]) handler({ kind: "snapshot", snapshot });
    });
    const offCommand = bridge.player.onCommand((command) => {
      for (const handler of [...handlers]) handler({ kind: "command", command });
    });
    detach = () => {
      offSnapshot();
      offCommand();
    };
  }

  return {
    post(message) {
      if (message.kind === "snapshot") bridge.player.publish(message.snapshot);
      else bridge.player.send(message.command);
    },
    subscribe(handler) {
      open();
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) {
          detach?.();
          detach = null;
        }
      };
    },
  };
}

/** Which end of the bus a caller is (F§10.1): the reader that owns the player, or a window that mirrors it. */
export type PlayerBusRole = "host" | "remote";

/** What a bus offers. Only the members of the caller's own role do anything. */
export interface PlayerBus {
  /** Host: publish the player's state to every remote. */
  publish(snapshot: PlayerBusSnapshot): void;
  /** Remote: ask the host to run a command. */
  send(command: PlayerCommand): void;
  /** Remote: receive the snapshots the host publishes. */
  onSnapshot(handler: (snapshot: PlayerBusSnapshot) => void): () => void;
  /** Host: receive the commands remotes sent, which is what the host executes. */
  onCommand(handler: (command: PlayerCommand) => void): () => void;
  /** Stop listening. The transport is the caller's and is left as it was found. */
  dispose(): void;
}

/**
 * `createPlayerBus(transport, role)` — one end of F§10.1's bus.
 *
 * A message is applied only where it belongs: a remote applies a snapshot and a host applies a command, so a
 * host never acts on its own published state and a remote never runs the command it just sent. An outgoing
 * message is validated as well as an incoming one, so a view that hands over a malformed snapshot publishes
 * nothing instead of a message no remote could read.
 */
export function createPlayerBus(transport: PlayerBusTransport, role: PlayerBusRole): PlayerBus {
  const snapshotHandlers = new Set<(snapshot: PlayerBusSnapshot) => void>();
  const commandHandlers = new Set<(command: PlayerCommand) => void>();

  const stop = transport.subscribe((raw) => {
    const parsed = PlayerBusMessageSchema.safeParse(decode(raw));
    if (!parsed.success) return;
    if (parsed.data.kind === "snapshot") {
      if (role !== "remote") return;
      for (const handler of [...snapshotHandlers]) handler(parsed.data.snapshot);
      return;
    }
    if (role !== "host") return;
    for (const handler of [...commandHandlers]) handler(parsed.data.command);
  });

  return {
    publish(snapshot) {
      if (role !== "host") return;
      if (!PlayerBusSnapshotSchema.safeParse(snapshot).success) return;
      transport.post({ kind: "snapshot", snapshot });
    },

    send(command) {
      if (role !== "remote") return;
      if (!PlayerCommandSchema.safeParse(command).success) return;
      transport.post({ kind: "command", command });
    },

    onSnapshot(handler) {
      snapshotHandlers.add(handler);
      return () => {
        snapshotHandlers.delete(handler);
      };
    },

    onCommand(handler) {
      commandHandlers.add(handler);
      return () => {
        commandHandlers.delete(handler);
      };
    },

    dispose() {
      stop();
      snapshotHandlers.clear();
      commandHandlers.clear();
    },
  };
}
