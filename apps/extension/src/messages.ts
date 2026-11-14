/**
 * The message protocol between the extension's four contexts (F§10.2).
 *
 * A service worker, an offscreen document, a content script and a popup live in four separate JavaScript
 * realms; three of them talk to each other only through `chrome.runtime` messages. Every message is a
 * discriminated union on `type`, so a handler is a lookup by that key and no message can reach a handler it
 * was not written for, and every message is validated on arrival — the value is `unknown` until
 * `ExtMessageSchema` has accepted it.
 *
 * A reply is data, never an exception: `{ ok: true, data? }` when the work was done, `{ ok: false, code,
 * message }` when it was refused, so a failure survives the channel and the caller decides what to show. A
 * message nothing answered is a refusal too (`NO_RECEIVER`), because a promise that resolves to `undefined`
 * would otherwise read as success.
 */

import { DocumentModelSchema, PlayerCommandSchema, PlayerSnapshotSchema } from "@lectern/core";
import { z } from "zod";

/** Everything one context can ask another to do (F§10.2). */
export const ExtMessageSchema = z.discriminatedUnion("type", [
  /** Popup or command: read the page in the active tab. */
  z.strictObject({ type: z.literal("ext/read-active-tab") }),
  /** Background to offscreen: load this document and read it, optionally from a sentence. */
  z.strictObject({
    type: z.literal("ext/read-document"),
    document: DocumentModelSchema,
    startSentence: z.int().nonnegative().exactOptional(),
  }),
  /** Context menu: read the text the reader has selected. */
  z.strictObject({ type: z.literal("ext/read-selection") }),
  /** Any view to the offscreen document: F§5.7's command vocabulary, unchanged. */
  z.strictObject({ type: z.literal("ext/command"), command: PlayerCommandSchema }),
  /** Offscreen document to the background, the popup and the content script: the player right now. */
  z.strictObject({ type: z.literal("ext/snapshot"), snapshot: PlayerSnapshotSchema, title: z.string() }),
  /** Stop reading and let the offscreen document wind down. */
  z.strictObject({ type: z.literal("ext/stop") }),
  /** Popup: hand the active tab's PDF to the web app, which can read it (F§10.2). */
  z.strictObject({ type: z.literal("ext/open-pdf") }),
  /** Popup: what the extension is connected to and what it will read with. */
  z.strictObject({ type: z.literal("ext/get-status") }),
]);

/** One message, as the four realms exchange it. */
export type ExtMessage = z.infer<typeof ExtMessageSchema>;

/** Any message's `type`, which is the key a handler is registered under. */
export type ExtMessageType = ExtMessage["type"];

/** A successful reply, carrying the data the caller asked for when there is any. */
export interface ExtOk<T = unknown> {
  ok: true;
  data?: T;
}

/** A refusal: a stable code for the program, a sentence for the reader. */
export interface ExtFail {
  ok: false;
  code: string;
  message: string;
}

/** What a handler answers. */
export type ExtReply<T = unknown> = ExtOk<T> | ExtFail;

/** A reply as it crosses the channel, validated before a caller reads it. */
export const ExtReplySchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), data: z.unknown().exactOptional() }),
  z.strictObject({ ok: z.literal(false), code: z.string(), message: z.string() }),
]);

/** A reply that reports success. */
export function okReply<T>(data: T): ExtOk<T> {
  return { ok: true, data };
}

/** A reply that reports a refusal. */
export function failReply(code: string, message: string): ExtFail {
  return { ok: false, code, message };
}

/**
 * What `ext/get-status` answers with: the connection the extension holds and the reading preferences it will
 * read with. It is the protocol's own shape for that reply, so the popup validates what it is handed instead
 * of trusting the sender's memory of it.
 */
export const ExtStatusSchema = z.strictObject({
  hubUrl: z.string(),
  connected: z.boolean(),
  voiceId: z.string(),
  rate: z.number(),
  autoShowWidget: z.boolean(),
  disabledSites: z.array(z.string()),
  skipFurniture: z.boolean(),
});

/** The status a popup shows. */
export type ExtStatus = z.infer<typeof ExtStatusSchema>;

/** A failure's message, whatever was thrown. */
export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The three calls the protocol needs from the platform, injected so the message layer is testable without a
 * service worker: send to the extension, send to one tab, and receive.
 */
export interface ExtTransport {
  send(message: ExtMessage): Promise<unknown>;
  sendToTab(tabId: number, message: ExtMessage): Promise<unknown>;
  onMessage(handler: (raw: unknown, sender: chrome.runtime.MessageSender) => unknown): void;
}

/** The transport of a real extension: `chrome.runtime` and `chrome.tabs`. */
export const chromeTransport: ExtTransport = {
  send: async (message) => await chrome.runtime.sendMessage(message),
  sendToTab: async (tabId, message) => await chrome.tabs.sendMessage(tabId, message),
  onMessage: (handler) => {
    chrome.runtime.onMessage.addListener((raw: unknown, sender: chrome.runtime.MessageSender, sendResponse) => {
      const answer = handler(raw, sender);
      if (answer === undefined) return undefined;
      Promise.resolve(answer).then(sendResponse, (cause: unknown) => sendResponse(failReply("HANDLER_FAILED", messageOf(cause))));
      return true;
    });
  },
};

/** A message, or `null` when the value is not one this protocol defines. */
export function parseExtMessage(value: unknown): ExtMessage | null {
  const parsed = ExtMessageSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A reply as the caller should read it: one that never crossed the channel is `NO_RECEIVER`, not a success. */
export function parseExtReply(value: unknown): ExtReply {
  const parsed = ExtReplySchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return failReply("NO_RECEIVER", "no context answered the message");
}

/** Send a message to the extension's service worker. */
export async function sendMessage(message: ExtMessage, transport: ExtTransport = chromeTransport): Promise<ExtReply> {
  return parseExtReply(await transport.send(message));
}

/** Send a message to one tab's content script. */
export async function sendToTab(tabId: number, message: ExtMessage, transport: ExtTransport = chromeTransport): Promise<ExtReply> {
  return parseExtReply(await transport.sendToTab(tabId, message));
}

/**
 * Answer messages of this protocol. A value that is not an `ExtMessage` is left alone — another listener may
 * know it — while a message this protocol defines is handed to `handler` and its answer sent back. A handler
 * that throws answers with `HANDLER_FAILED` instead of rejecting into a channel nothing is listening on.
 */
export function onMessage(
  handler: (message: ExtMessage, sender: chrome.runtime.MessageSender) => ExtReply | Promise<ExtReply>,
  transport: ExtTransport = chromeTransport,
): void {
  transport.onMessage((raw, sender) => {
    const message = parseExtMessage(raw);
    if (message === null) return undefined;
    return Promise.resolve()
      .then(() => handler(message, sender))
      .catch((cause: unknown) => failReply("HANDLER_FAILED", messageOf(cause)));
  });
}
