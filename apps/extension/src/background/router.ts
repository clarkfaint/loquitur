/**
 * The message router (F§10.2).
 *
 * It is the only listener the service worker installs: every message arrives here, is validated, and is
 * handed to the handler registered under its `type`. A message nothing answers is refused with a code the
 * caller can read — `BAD_MESSAGE` for a value that is not one of this extension's messages, `NO_HANDLER` for
 * a type that has no handler yet — so a caller is never left with a resolution that means neither success
 * nor failure.
 */

import { type ExtMessage, type ExtReply, failReply, messageOf, onMessage, parseExtMessage } from "../messages";
import { handlers } from "./handlers";

/** What a registered handler is: one message in, one reply out. */
export type Handler = (message: ExtMessage, sender: chrome.runtime.MessageSender) => ExtReply | Promise<ExtReply>;

/** Answer one value that arrived on the channel. */
export async function handleMessage(raw: unknown, sender: chrome.runtime.MessageSender): Promise<ExtReply> {
  const message = parseExtMessage(raw);
  if (message === null) {
    return failReply("BAD_MESSAGE", "the message is not one this extension defines");
  }
  const handler = handlers[message.type];
  if (handler === undefined) {
    return failReply("NO_HANDLER", `no handler is registered for ${message.type}`);
  }
  try {
    return await handler(message, sender);
  } catch (cause) {
    return failReply("HANDLER_FAILED", messageOf(cause));
  }
}

/** Install the router: from here on, every message of this protocol is answered. */
export function installRouter(): void {
  onMessage((message, sender) => handleMessage(message, sender));
}
