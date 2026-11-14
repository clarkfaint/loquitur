/**
 * The player bus over an in-memory transport (U-029).
 *
 * An ordinary object stands in for the channel, so the bus's own rules are what these cases exercise: which
 * role applies which message, that a command a remote sends reaches the host and stops there, and that
 * anything the bus did not send — a stray string, a half-built message, a command with a field F§5.7 does not
 * define — is dropped instead of handed to a controller.
 *
 * The transport hands its subscribers the *serialised* message, because that is what a real channel carries;
 * `deliver` is the test's own way in, for the values a channel could carry but the bus never posted.
 */

import type { PlayerCommand } from "@lectern/core";
import { expect, test } from "vitest";
import { createPlayerBus, type PlayerBusMessage, type PlayerBusSnapshot, type PlayerBusTransport } from "../player-bus";

/** The document title every published snapshot carries. */
const TITLE = "A probe document";

/** A transport that carries messages through a string, exactly as a browser channel does. */
interface MemoryTransport {
  transport: PlayerBusTransport;
  /** Hand a raw value to every subscriber, as a channel with something unexpected on it would. */
  deliver(raw: unknown): void;
  /** Everything posted, in the order it was posted. */
  posted: PlayerBusMessage[];
}

function createMemoryTransport(): MemoryTransport {
  const handlers = new Set<(raw: unknown) => void>();
  const posted: PlayerBusMessage[] = [];
  return {
    posted,
    transport: {
      post(message) {
        posted.push(message);
        const wire = JSON.stringify(message);
        for (const handler of [...handlers]) handler(wire);
      },
      subscribe(handler) {
        handlers.add(handler);
        return () => {
          handlers.delete(handler);
        };
      },
    },
    deliver(raw) {
      for (const handler of [...handlers]) handler(raw);
    },
  };
}

/** A snapshot a host would publish, with the word being read at the sentence it is given. */
function snapshotAt(sentenceIndex: number): PlayerBusSnapshot {
  return {
    state: "playing",
    docId: "doc-harbour",
    sentenceIndex,
    wordIndex: 1,
    rate: 1.5,
    voiceId: "mock:mock-a",
    sleepRemainingMs: null,
    error: null,
    title: TITLE,
    active: { sentenceIndex, wordIndex: 1 },
    progressFraction: 0.25,
    remainingMs: 60_000,
    baseWpm: 170,
  };
}

test("a remote receives every snapshot the host publishes", () => {
  const { transport } = createMemoryTransport();
  const host = createPlayerBus(transport, "host");
  const remote = createPlayerBus(transport, "remote");
  const seen: PlayerBusSnapshot[] = [];
  remote.onSnapshot((snapshot) => seen.push(snapshot));

  host.publish(snapshotAt(0));
  host.publish(snapshotAt(2));

  expect(seen.map((snapshot) => snapshot.sentenceIndex)).toEqual([0, 2]);
  expect(seen[1]?.title).toBe(TITLE);
  expect(seen[1]?.active).toEqual({ sentenceIndex: 2, wordIndex: 1 });
  host.dispose();
  remote.dispose();
});

test("a command a remote sends reaches the host, and is not run by the remote itself", () => {
  const { transport } = createMemoryTransport();
  const host = createPlayerBus(transport, "host");
  const remote = createPlayerBus(transport, "remote");
  const executed: PlayerCommand[] = [];
  const echoed: PlayerCommand[] = [];
  host.onCommand((command) => executed.push(command));
  remote.onCommand((command) => echoed.push(command));

  remote.send({ type: "skip", sentences: 1 });
  remote.send({ type: "setRate", rate: 4.5 });

  expect(executed).toEqual([
    { type: "skip", sentences: 1 },
    { type: "setRate", rate: 4.5 },
  ]);
  expect(echoed).toEqual([]);
  host.dispose();
  remote.dispose();
});

test("malformed messages are dropped, and the channel keeps working", () => {
  const { transport, deliver } = createMemoryTransport();
  const host = createPlayerBus(transport, "host");
  const remote = createPlayerBus(transport, "remote");
  const commands: PlayerCommand[] = [];
  const snapshots: PlayerBusSnapshot[] = [];
  host.onCommand((command) => commands.push(command));
  remote.onSnapshot((snapshot) => snapshots.push(snapshot));

  deliver("not json at all");
  deliver(JSON.stringify({ kind: "snapshot" }));
  deliver(JSON.stringify({ kind: "command", command: { type: "explode" } }));
  deliver(JSON.stringify({ kind: "command", command: { type: "skip", sentences: 1, surprise: true } }));
  deliver(JSON.stringify({ kind: "something-else", command: { type: "play" } }));
  deliver(JSON.stringify({ kind: "snapshot", snapshot: { ...snapshotAt(0), rate: "fast" } }));
  deliver(null);
  deliver(42);

  expect(commands).toEqual([]);
  expect(snapshots).toEqual([]);

  deliver(JSON.stringify({ kind: "command", command: { type: "play" } }));
  expect(commands).toEqual([{ type: "play" }]);
  host.dispose();
  remote.dispose();
});

test("two remotes work together: both hear the host, and both can drive it", () => {
  const { transport } = createMemoryTransport();
  const host = createPlayerBus(transport, "host");
  const first = createPlayerBus(transport, "remote");
  const second = createPlayerBus(transport, "remote");
  const firstSeen: number[] = [];
  const secondSeen: number[] = [];
  first.onSnapshot((snapshot) => firstSeen.push(snapshot.sentenceIndex));
  second.onSnapshot((snapshot) => secondSeen.push(snapshot.sentenceIndex));
  const executed: PlayerCommand[] = [];
  host.onCommand((command) => executed.push(command));

  host.publish(snapshotAt(3));
  first.send({ type: "pause" });
  second.send({ type: "play" });

  expect(firstSeen).toEqual([3]);
  expect(secondSeen).toEqual([3]);
  expect(executed).toEqual([{ type: "pause" }, { type: "play" }]);
  host.dispose();
  first.dispose();
  second.dispose();
});

test("each end is deaf to the traffic that is not its own", () => {
  const { transport } = createMemoryTransport();
  const host = createPlayerBus(transport, "host");
  const remote = createPlayerBus(transport, "remote");
  const commands: PlayerCommand[] = [];
  const snapshots: PlayerBusSnapshot[] = [];
  host.onCommand((command) => commands.push(command));
  remote.onSnapshot((snapshot) => snapshots.push(snapshot));

  remote.publish(snapshotAt(1));
  host.send({ type: "play" });

  expect(commands).toEqual([]);
  expect(snapshots).toEqual([]);
  host.dispose();
  remote.dispose();
});

test("a bus refuses to post a message its own schema rejects", () => {
  const memory = createMemoryTransport();
  const host = createPlayerBus(memory.transport, "host");
  const remote = createPlayerBus(memory.transport, "remote");

  host.publish({ ...snapshotAt(0), title: 42 as unknown as string });
  remote.send({ type: "setRate", rate: Number.NaN });

  expect(memory.posted).toEqual([]);
  host.dispose();
  remote.dispose();
});

test("unsubscribing stops the delivery, and disposing stops the transport's listener", () => {
  const { transport, posted } = createMemoryTransport();
  const host = createPlayerBus(transport, "host");
  const remote = createPlayerBus(transport, "remote");
  const seen: PlayerBusSnapshot[] = [];
  const stop = remote.onSnapshot((snapshot) => seen.push(snapshot));

  host.publish(snapshotAt(0));
  stop();
  host.publish(snapshotAt(1));

  expect(seen).toHaveLength(1);
  expect(posted).toHaveLength(2);
  host.dispose();
  remote.dispose();
});
