/**
 * "Read this page" (F§10.2): the popup's button, the `read-page` shortcut and the one message that starts a
 * reading in the tab the reader is looking at.
 *
 * The work is a single relay, and it is a relay in the literal sense: the service worker cannot read a page, so
 * it asks the tab's content script to read itself. The content script extracts the article and sends
 * `ext/read-document` back, which is U-034's reading session's business; this module only has to name the right
 * tab and report what came back.
 *
 * Two platform facts shape it, both measured on this host (see `docs/evidence/U-035.md` §2). A message sent to a
 * tab with no content script — a `chrome://` page, Chrome's PDF viewer, an extension page — rejects, so a
 * refusal is the ordinary answer for a tab the extension cannot read rather than an exception; and
 * `chrome.commands.onCommand` hands the command name, which is the only thing that tells `read-page` apart from
 * the other three bindings U-032 declares.
 *
 * The registry entry is added at installation (`installReadActiveTab`) rather than declared in `handlers.ts`,
 * because U-032's frozen `messages.test.ts` asserts that the registry *as declared* refuses every type but
 * `ext/get-status`. The operator ratified that pattern in U-034 (`docs/evidence/U-034.md` §7).
 */

import { type ExtMessage, type ExtReply, failReply, messageOf, okReply, parseExtReply } from "../messages";
import { handlers } from "./handlers";
import type { Handler } from "./router";

/** The command U-032's manifest binds to this feature (`Alt+Shift+R`). */
export const READ_PAGE_COMMAND = "read-page";

/** The answer when there is no tab to read at all. */
export const NO_ACTIVE_TAB = "NO_ACTIVE_TAB";

/** The answer when the tab cannot be asked: no content script, or one that did not start. */
export const NO_CONTENT_SCRIPT = "NO_CONTENT_SCRIPT";

/** A message that is not this handler's own, which can only happen if the router misroutes it. */
const BAD_MESSAGE = "BAD_MESSAGE";

/** What this feature needs from the extension platform, injected so it can be driven without a browser. */
export interface ReadActiveTabPlatform {
  /** The tab the reader is looking at, when the caller does not name one. */
  activeTab(): Promise<number | null>;
  /** Send one message to a tab's content script. */
  toTab(tabId: number, message: ExtMessage): Promise<unknown>;
  /** Watch the extension's keyboard commands. */
  onCommand(listener: (command: string) => void): void;
}

/** The platform of a real extension: `chrome.tabs` and `chrome.commands`. */
export const chromeReadActiveTabPlatform: ReadActiveTabPlatform = {
  activeTab: async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id ?? null,
  toTab: async (tabId, message) => await chrome.tabs.sendMessage(tabId, message),
  onCommand: (listener) => {
    chrome.commands.onCommand.addListener((command) => listener(command));
  },
};

/**
 * Ask one tab's content script to read its page. A tab that answers nothing — because it carries no content
 * script, or because the extension may not script it — is refused with the reason the platform gave.
 */
export async function requestPageReading(
  tabId: number | null,
  platform: ReadActiveTabPlatform = chromeReadActiveTabPlatform,
): Promise<ExtReply> {
  let target: number | null = tabId;
  if (target === null) {
    try {
      target = await platform.activeTab();
    } catch (cause) {
      return failReply(NO_ACTIVE_TAB, messageOf(cause));
    }
  }
  if (target === null) return failReply(NO_ACTIVE_TAB, "there is no tab to read");
  try {
    return parseExtReply(await platform.toTab(target, { type: "ext/read-active-tab" }));
  } catch (cause) {
    return failReply(NO_CONTENT_SCRIPT, messageOf(cause));
  }
}

/**
 * Install the feature: register `ext/read-active-tab` in the router's registry, and bind the `read-page`
 * command to the same request. Run once when the service worker starts.
 *
 * A command's failure has no caller to report it to — nobody is waiting on a keyboard shortcut — so the answer
 * is dropped; the tab itself learns what happened when the player publishes its state.
 */
export function installReadActiveTab(platform: ReadActiveTabPlatform = chromeReadActiveTabPlatform): void {
  // The active tab, never the sender's: F§10.2's request is "read the page I am looking at", and the context
  // that asks for it is the popup — which is itself a tab, and which `sender.tab` would therefore name. The
  // reading is of the page the reader is on, which only the active tab can be.
  const answer: Handler = async (message) => {
    if (message.type !== "ext/read-active-tab") return failReply(BAD_MESSAGE, "not a request to read a page");
    return await requestPageReading(null, platform);
  };
  Object.assign(handlers, { "ext/read-active-tab": answer } satisfies Partial<Record<ExtMessage["type"], Handler>>);
  platform.onCommand((command) => {
    if (command !== READ_PAGE_COMMAND) return;
    void requestPageReading(null, platform).catch(() => okReply(null));
  });
}
