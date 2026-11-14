/**
 * The message protocol's own tests (F§10.2).
 *
 * Three things are pinned here: every message type this unit defines is accepted, a value that is not one of
 * them is refused, and the router answers a type with no handler with `NO_HANDLER` rather than with silence.
 * The `chrome` calls the modules make are stubbed, because the protocol is data and needs no service worker
 * to be exercised.
 */

import { buildDocument } from "@lectern/core";
import { beforeEach, describe, expect, it } from "vitest";
import { handleMessage, installRouter } from "../background/router";
import { type ExtMessage, ExtMessageSchema, parseExtMessage } from "../messages";

/** One listener the extension installed on `chrome.runtime.onMessage`. */
type MessageListener = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (reply?: unknown) => void) => unknown;

/** Every listener installed so far, in install order. */
const listeners: MessageListener[] = [];

/** What `chrome.storage.local` holds in this test. */
let stored: Record<string, unknown> = {};

/** The sender a synthetic message arrives with: an extension page, not a tab. */
const SENDER = {} as chrome.runtime.MessageSender;

/** A two-sentence document, built by the core builder so its shape is the model's own. */
function probeDocument() {
  return buildDocument([{ kind: "paragraph", text: "Lectern reads a page. It keeps its place." }], {
    title: "Probe",
    source: { kind: "txt" },
  });
}

/** One valid example of every message type this protocol defines. */
const VALID_MESSAGES: ExtMessage[] = [
  { type: "ext/read-active-tab" },
  { type: "ext/read-document", document: probeDocument() },
  { type: "ext/read-document", document: probeDocument(), startSentence: 1 },
  { type: "ext/read-selection" },
  { type: "ext/command", command: { type: "play" } },
  { type: "ext/command", command: { type: "setRate", rate: 1.5 } },
  {
    type: "ext/snapshot",
    snapshot: {
      state: "playing",
      docId: "doc",
      sentenceIndex: 0,
      wordIndex: 1,
      rate: 1,
      voiceId: "mock:mock-a",
      sleepRemainingMs: null,
      error: null,
    },
    title: "Probe",
  },
  { type: "ext/stop" },
  { type: "ext/open-pdf" },
  { type: "ext/get-status" },
];

beforeEach(() => {
  listeners.length = 0;
  stored = {};
  globalThis.chrome = {
    runtime: {
      onMessage: {
        addListener: (listener: MessageListener) => {
          listeners.push(listener);
        },
      },
    },
    storage: {
      local: {
        get: async (key: string) => ({ ...(key in stored ? { [key]: stored[key] } : {}) }),
      },
    },
  } as unknown as typeof chrome;
});

describe("ExtMessageSchema", () => {
  it("accepts one example of every message type", () => {
    for (const message of VALID_MESSAGES) {
      const parsed = ExtMessageSchema.safeParse(message);
      expect(parsed.success, `${message.type} should be a valid message`).toBe(true);
    }
  });

  it("accepts every type at least once, and no other type", () => {
    const types = new Set(VALID_MESSAGES.map((message) => message.type));
    expect([...types].sort()).toEqual([
      "ext/command",
      "ext/get-status",
      "ext/open-pdf",
      "ext/read-active-tab",
      "ext/read-document",
      "ext/read-selection",
      "ext/snapshot",
      "ext/stop",
    ]);
  });

  it("rejects a value that is not a message at all", () => {
    expect(parseExtMessage(null)).toBeNull();
    expect(parseExtMessage("ext/stop")).toBeNull();
    expect(parseExtMessage({})).toBeNull();
    expect(parseExtMessage({ type: "ext/nothing" })).toBeNull();
  });

  it("rejects a message carrying a field the protocol does not define", () => {
    expect(parseExtMessage({ type: "ext/stop", force: true })).toBeNull();
  });

  it("rejects a message whose payload has the wrong shape", () => {
    expect(parseExtMessage({ type: "ext/command", command: { type: "seek" } })).toBeNull();
    expect(parseExtMessage({ type: "ext/command", command: { type: "setRate", rate: "fast" } })).toBeNull();
    expect(parseExtMessage({ type: "ext/read-document", document: { title: "Probe" } })).toBeNull();
    expect(parseExtMessage({ type: "ext/snapshot", snapshot: VALID_MESSAGES[6]?.type })).toBeNull();
  });

  it("rejects an optional field that is present but undefined", () => {
    const message = { type: "ext/read-document", document: probeDocument(), startSentence: undefined };
    expect(parseExtMessage(message)).toBeNull();
  });
});

describe("the router", () => {
  it("refuses a value that is not a message", async () => {
    const reply = await handleMessage({ type: "ext/nothing" }, SENDER);
    expect(reply).toEqual({ ok: false, code: "BAD_MESSAGE", message: expect.any(String) });
  });

  it("refuses a type with no registered handler", async () => {
    const unregistered = VALID_MESSAGES.filter((message) => message.type !== "ext/get-status");
    expect(new Set(unregistered.map((message) => message.type)).size).toBe(7);
    for (const message of unregistered) {
      const reply = await handleMessage(message, SENDER);
      expect(reply, `${message.type} has no handler in this unit`).toMatchObject({ ok: false, code: "NO_HANDLER" });
    }
  });

  it("answers the handler this unit registers", async () => {
    const reply = await handleMessage({ type: "ext/get-status" }, SENDER);
    expect(reply).toMatchObject({ ok: true, data: { hubUrl: "", connected: false, rate: 1, autoShowWidget: false } });
  });

  it("answers through the listener it installs", async () => {
    installRouter();
    expect(listeners).toHaveLength(1);

    const answered = new Promise<unknown>((resolve) => {
      expect(listeners[0]?.({ type: "ext/get-status" }, SENDER, resolve)).toBe(true);
    });
    await expect(answered).resolves.toMatchObject({ ok: true, data: { connected: false } });
  });

  it("leaves a message that is not its own to another listener", () => {
    installRouter();
    expect(listeners[0]?.({ hello: "world" }, SENDER, () => undefined)).toBeUndefined();
  });
});
