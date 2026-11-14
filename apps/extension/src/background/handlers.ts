/**
 * The message handlers (F§10.2).
 *
 * This file is the registry the router dispatches through: a handler is one entry keyed by the message type
 * it answers, and a later unit adds its entry here rather than editing the service worker's entry point.
 * This unit registers `ext/get-status`, which is what the popup asks for when it opens.
 */

import { type ExtMessage, type ExtStatus, okReply } from "../messages";
import { getSettings } from "../settings";
import type { Handler } from "./router";

/** Every handler the service worker answers with. */
export const handlers: Partial<Record<ExtMessage["type"], Handler>> = {
  "ext/get-status": async () => {
    const settings = await getSettings();
    const status: ExtStatus = {
      hubUrl: settings.hubUrl,
      connected: settings.hubUrl !== "" && settings.token !== "",
      voiceId: settings.voiceId,
      rate: settings.rate,
      autoShowWidget: settings.autoShowWidget,
      disabledSites: settings.disabledSites,
      skipFurniture: settings.skipFurniture,
    };
    return okReply(status);
  },
};
