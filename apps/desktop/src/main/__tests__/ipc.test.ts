/**
 * The channel table (F§10.3, F§11).
 *
 * Each case drives one channel through the helpers the shell itself uses: the renderer's ask is answered by
 * `handle` and the main process's push goes out through `send`. Both are handed a stand-in rather than
 * Electron, which is what lets the whole table be checked without starting an application — and the point of
 * the table is that a payload which is not the shape the channel declared never reaches a handler and never
 * leaves one.
 */

import { PlayerCommandSchema } from "@lectern/core";
import { describe, expect, test } from "vitest";
import {
  DesktopImportRequestSchema,
  DesktopReadRequestSchema,
  DesktopSettingsPatchSchema,
  DesktopStatusSchema,
  handle,
  IPC_CHANNELS,
  type IpcChannel,
  type IpcHandlerHost,
  IpcPayloadError,
  type IpcSender,
  NO_PAYLOAD,
  outboundSchema,
  PlayerBusSnapshotPayloadSchema,
  send,
} from "../ipc";
import { pendingStatus } from "../settings-store";

/** A published snapshot: F§10.3's bus snapshot, as `@lectern/ui-web` builds one. */
const SNAPSHOT = {
  state: "playing",
  docId: "8f14e45fceea167a",
  sentenceIndex: 0,
  wordIndex: 1,
  rate: 1.25,
  voiceId: "mock:mock-a",
  sleepRemainingMs: null,
  error: null,
  title: "Harbour Light",
  active: { sentenceIndex: 0, wordIndex: 1 },
  progressFraction: 0.25,
  remainingMs: 12_400,
  baseWpm: 170,
};

/** One channel, with a payload it accepts and one it must refuse. */
interface ChannelCase<T> {
  channel: IpcChannel;
  schema: Parameters<typeof handle<T>>[2];
  valid: T;
  invalid: unknown;
}

/** Every channel the renderer asks the main process on. */
const INBOUND: ChannelCase<unknown>[] = [
  { channel: IPC_CHANNELS.settingsGet, schema: NO_PAYLOAD, valid: undefined, invalid: "settings" },
  { channel: IPC_CHANNELS.settingsSet, schema: DesktopSettingsPatchSchema, valid: { watchFolders: ["/x"] }, invalid: { watchFolders: 7 } },
  { channel: IPC_CHANNELS.settingsPickFolder, schema: NO_PAYLOAD, valid: undefined, invalid: 1 },
  { channel: IPC_CHANNELS.windowsToggleMini, schema: NO_PAYLOAD, valid: undefined, invalid: {} },
  { channel: IPC_CHANNELS.windowsShowMain, schema: NO_PAYLOAD, valid: undefined, invalid: true },
  { channel: IPC_CHANNELS.captureRegion, schema: NO_PAYLOAD, valid: undefined, invalid: "region" },
  { channel: IPC_CHANNELS.playerPublish, schema: PlayerBusSnapshotPayloadSchema, valid: SNAPSHOT, invalid: { state: "playing" } },
  { channel: IPC_CHANNELS.playerSend, schema: PlayerCommandSchema, valid: { type: "play" }, invalid: { type: "dance" } },
];

/** Every channel the main process pushes on. */
const OUTBOUND: { channel: IpcChannel; valid: unknown; invalid: unknown }[] = [
  { channel: IPC_CHANNELS.playerSnapshot, valid: SNAPSHOT, invalid: { ...SNAPSHOT, progressFraction: "half" } },
  { channel: IPC_CHANNELS.playerCommand, valid: { type: "seek", sentenceIndex: 3 }, invalid: { type: "seek" } },
  {
    channel: IPC_CHANNELS.importRequest,
    valid: { files: [{ name: "note.txt", mime: "text/plain", bytes: new Uint8Array([1, 2, 3]) }], play: true },
    invalid: { files: [{ name: "note.txt", mime: "text/plain", bytes: [1, 2, 3] }], play: true },
  },
  { channel: IPC_CHANNELS.readText, valid: { text: "read this", title: "Selection" }, invalid: { text: "read this" } },
  { channel: IPC_CHANNELS.settingsStatus, valid: pendingStatus(), invalid: { ...pendingStatus(), hotkeys: { togglePlay: "yes" } } },
];

/** A stand-in for `ipcMain`: it keeps what was registered so a case can call it. */
function recordingHost(): { host: IpcHandlerHost; call: (channel: IpcChannel, payload: unknown) => unknown } {
  const listeners = new Map<string, (event: unknown, payload: unknown) => unknown>();
  return {
    host: {
      handle(channel, listener) {
        listeners.set(channel, listener);
      },
    },
    call(channel, payload) {
      const listener = listeners.get(channel);
      if (listener === undefined) throw new Error(`nothing is registered on ${channel}`);
      return listener({}, payload);
    },
  };
}

/** A stand-in for a `WebContents`. */
function recordingSender(): { sender: IpcSender; sent: { channel: string; payload: unknown }[] } {
  const sent: { channel: string; payload: unknown }[] = [];
  return {
    sender: {
      send(channel, payload) {
        sent.push({ channel, payload });
      },
    },
    sent,
  };
}

describe("what the renderer asks", () => {
  test.each(INBOUND)("$channel takes its own payload and refuses anything else", (one) => {
    const { host, call } = recordingHost();
    const seen: unknown[] = [];
    // The registered handler answers with what it was given, so the payload really crossed the check.
    handle(host, one.channel, one.schema, (payload: unknown) => {
      seen.push(payload);
      return "answered";
    });

    expect(call(one.channel, one.valid)).toBe("answered");
    expect(seen).toEqual([one.valid]);

    expect(() => call(one.channel, one.invalid)).toThrow(IpcPayloadError);
    // A refused payload never reaches the handler: the renderer is answered with a refusal, not with half a
    // request acted on.
    expect(seen).toEqual([one.valid]);
  });

  test("a refusal names the channel that refused it", () => {
    const { host, call } = recordingHost();
    handle(host, IPC_CHANNELS.playerSend, PlayerCommandSchema, () => undefined);

    expect(() => call(IPC_CHANNELS.playerSend, { type: "dance" })).toThrow(/lectern:player-send/u);
  });
});

describe("what the main process pushes", () => {
  test.each(OUTBOUND)("$channel sends its own payload and withholds anything else", (one) => {
    const { sender, sent } = recordingSender();
    const schema = outboundSchema(one.channel);

    send(sender, one.channel, schema, one.valid);
    expect(sent).toEqual([{ channel: one.channel, payload: one.valid }]);

    expect(() => send(sender, one.channel, schema, one.invalid)).toThrow(IpcPayloadError);
    // Nothing was pushed the second time: a renderer is never handed a payload its own channel does not
    // promise.
    expect(sent).toHaveLength(1);
  });

  test("a channel the main process never pushes on cannot be pushed on", () => {
    expect(() => outboundSchema(IPC_CHANNELS.playerPublish)).toThrow(IpcPayloadError);
  });

  test("the outbound table covers exactly the channels the bridge pushes on", () => {
    const inbound = new Set(INBOUND.map((one) => one.channel));
    const covered = [...inbound, ...OUTBOUND.map((one) => one.channel)];
    expect([...covered].sort()).toEqual(Object.values(IPC_CHANNELS).sort());
  });
});

describe("the payload schemas themselves", () => {
  test("the settings channels and the record on disk are one shape", () => {
    expect(DesktopSettingsPatchSchema.safeParse({ miniBounds: null }).success).toBe(true);
    expect(DesktopSettingsPatchSchema.safeParse({ miniBounds: { x: "left", y: 0 } }).success).toBe(false);
  });

  test("an import request carries bytes, and only bytes", () => {
    expect(
      DesktopImportRequestSchema.safeParse({
        files: [{ name: "a.bin", mime: "application/octet-stream", bytes: new Uint8Array() }],
        play: false,
        folderName: "Inbox",
      }).success,
    ).toBe(true);
    expect(DesktopImportRequestSchema.safeParse({ files: [], play: false, folder: "Inbox" }).success).toBe(false);
  });

  test("a read request is text and a title, with nothing optional", () => {
    expect(DesktopReadRequestSchema.safeParse({ text: "x", title: "y" }).success).toBe(true);
    expect(DesktopReadRequestSchema.safeParse({ text: "x", title: "y", extra: true }).success).toBe(false);
  });

  test("a status names every action and the state of each", () => {
    expect(DesktopStatusSchema.safeParse(pendingStatus()).success).toBe(true);
    expect(DesktopStatusSchema.safeParse({ ...pendingStatus(), selectionProvider: 7 }).success).toBe(false);
  });
});
