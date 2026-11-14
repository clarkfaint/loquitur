/**
 * The reading session (F§10.2): the one tab being read, and the relay between a tab and the offscreen document.
 *
 * Playback belongs to the offscreen document and extraction belongs to the content script; neither of them knows
 * about the other. The service worker is what joins them, and this is the whole of that job:
 *
 * - a document extracted in a tab arrives as `ext/read-document`, the session makes sure the offscreen document
 *   exists and hands the document over;
 * - a command from a view arrives as `ext/command` and is relayed, or refused with `NO_SESSION` when nothing is
 *   being read, so a control that has nothing to control says so instead of looking broken;
 * - the player's state comes back as `ext/snapshot` and is forwarded to the tab that is being read and to the
 *   popup, which are the two places a reader sees it;
 * - and the session ends when its tab closes or navigates, or when another tab starts a reading — F§10.2's own
 *   rule that one tab is being read at a time.
 *
 * The whole chrome surface is injected. The service worker passes the real one; the unit test passes a fake, so
 * the relay, the two tab events and the refusal are all exercised without a browser. Nothing here reads the
 * clock, the DOM or the network: it moves messages and remembers one tab id.
 */

import type { ExtMessage, ExtReply } from "../messages";
import { failReply, messageOf, okReply } from "../messages";
import { handlers } from "./handlers";
import { closeOffscreenLater, ensureOffscreen } from "./offscreen";

/** A message, and the sender Chrome reports for it. */
type Handler = (message: ExtMessage, sender: chrome.runtime.MessageSender) => ExtReply | Promise<ExtReply>;

/** The one answer a command gets when nothing is being read. */
export const NO_SESSION = "NO_SESSION";

/** The answer a relay gets when the offscreen document is not there to receive it. */
export const OFFSCREEN_UNAVAILABLE = "OFFSCREEN_UNAVAILABLE";

/** A message that is not the one a method was called for — a handler is reached only by its own `type`. */
const BAD_MESSAGE = "BAD_MESSAGE";

/** What the session needs from the extension platform, injected so it can be driven without a browser. */
export interface SessionPlatform {
  /** Open the offscreen document if there is none, and answer whether it is ready to receive. */
  openOffscreenDocument(): Promise<boolean>;
  /** Have the offscreen document closed a moment after the reading ends. */
  closeOffscreenLater(): void;
  /** Send one message to the offscreen document. */
  toOffscreen(message: ExtMessage): Promise<unknown>;
  /** Send one message to a tab's content script. */
  toTab(tabId: number, message: ExtMessage): Promise<unknown>;
  /** Send one message to the extension's other views — the popup. */
  toExtension(message: ExtMessage): Promise<unknown>;
  /** The tab the reader is looking at, when the caller does not name one. */
  activeTab(): Promise<number | null>;
  /** Watch tabs closing. */
  onTabClosed(listener: (tabId: number) => void): void;
  /** Watch tabs navigating. */
  onTabNavigated(listener: (tabId: number) => void): void;
}

/** The platform of a real extension: `chrome.runtime`, `chrome.tabs` and the offscreen document's own module. */
export const chromeSessionPlatform: SessionPlatform = {
  openOffscreenDocument: ensureOffscreen,
  closeOffscreenLater,
  toOffscreen: async (message) => await chrome.runtime.sendMessage(message),
  toTab: async (tabId, message) => await chrome.tabs.sendMessage(tabId, message),
  toExtension: async (message) => await chrome.runtime.sendMessage(message),
  activeTab: async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id ?? null,
  onTabClosed: (listener) => {
    chrome.tabs.onRemoved.addListener((tabId) => listener(tabId));
  },
  onTabNavigated: (listener) => {
    chrome.tabs.onUpdated.addListener((tabId, change) => {
      if (change.url !== undefined || change.status === "loading") listener(tabId);
    });
  },
};

/** The extension's reading session, as the service worker's handlers and features use it. */
export interface ReadingSession {
  /** The tab being read, or `null` while nothing is. */
  readonly tabId: number | null;
  /** Answer `ext/read-document`. */
  readDocument(message: ExtMessage, tabId: number | null): Promise<ExtReply>;
  /** Answer `ext/command`. */
  command(message: ExtMessage): Promise<ExtReply>;
  /** Answer `ext/stop`. */
  stop(): Promise<ExtReply>;
  /** Answer `ext/snapshot`: forward the player's state to the tab and the popup. */
  snapshot(message: ExtMessage): Promise<ExtReply>;
  /** The tab being read closed. */
  tabClosed(tabId: number): Promise<void>;
  /** The tab being read navigated, so what was extracted from it is gone. */
  navigated(tabId: number): Promise<void>;
}

/**
 * `createReadingSession(platform)` — the session over one injected platform.
 *
 * Every method answers with the protocol's own reply type rather than throwing, so a caller — a handler, a tab
 * event — always has something to report. The one piece of state is the tab id: `null` means nothing is being
 * read, which is what makes `NO_SESSION` a truthful answer rather than a guess.
 */
export function createReadingSession(platform: SessionPlatform = chromeSessionPlatform): ReadingSession {
  let active: number | null = null;

  /** Hand one message to the offscreen document, and report a document that is not there. */
  async function relay(message: ExtMessage): Promise<ExtReply> {
    try {
      await platform.toOffscreen(message);
      return okReply(null);
    } catch (cause) {
      return failReply(OFFSCREEN_UNAVAILABLE, messageOf(cause));
    }
  }

  /** End the reading: tell the player to stop, forget the tab, and let the document wind down. */
  async function endSession(): Promise<ExtReply> {
    const answer = active === null ? okReply(null) : await relay({ type: "ext/stop" });
    active = null;
    platform.closeOffscreenLater();
    return answer;
  }

  return {
    get tabId() {
      return active;
    },

    readDocument: async (message, tabId) => {
      if (message.type !== "ext/read-document") return failReply(BAD_MESSAGE, "not a document to read");
      const target = tabId ?? (await platform.activeTab());
      if (active !== null && active !== target) {
        // Another tab's reading is over the moment this one starts (F§10.2). The player is told to stop; the
        // document itself is reused, because the next line is about to hand it a document anyway.
        await platform.toOffscreen({ type: "ext/stop" }).catch(() => undefined);
        active = null;
      }
      let ready: boolean;
      try {
        ready = await platform.openOffscreenDocument();
      } catch (cause) {
        return failReply(OFFSCREEN_UNAVAILABLE, messageOf(cause));
      }
      if (!ready) return failReply(OFFSCREEN_UNAVAILABLE, "the offscreen document did not come up");
      const reading: ExtMessage =
        message.startSentence === undefined
          ? { type: "ext/read-document", document: message.document }
          : { type: "ext/read-document", document: message.document, startSentence: message.startSentence };
      const answer = await relay(reading);
      if (answer.ok) active = target;
      return answer;
    },

    command: async (message) => {
      if (message.type !== "ext/command") return failReply(BAD_MESSAGE, "not a player command");
      if (active === null) return failReply(NO_SESSION, "nothing is being read");
      return await relay(message);
    },

    stop: endSession,

    snapshot: async (message) => {
      if (message.type !== "ext/snapshot") return failReply(BAD_MESSAGE, "not a player snapshot");
      if (active !== null) {
        // A tab with no content script yet answers nothing, which is not a failure: the popup still gets it.
        await platform.toTab(active, message).catch(() => undefined);
      }
      await platform.toExtension(message).catch(() => undefined);
      if (message.snapshot.state === "ended") platform.closeOffscreenLater();
      return okReply(null);
    },

    tabClosed: async (tabId) => {
      if (active === tabId) await endSession();
    },

    navigated: async (tabId) => {
      if (active === tabId) await endSession();
    },
  };
}

/** The session the service worker uses, built once per worker life. */
let session: ReadingSession | null = null;

/** The extension's reading session, built on first use. */
export function getReadingSession(): ReadingSession {
  session ??= createReadingSession();
  return session;
}

/**
 * Install the session: register the four messages it answers in the service worker's handler registry, and
 * watch the two tab events it stops on. Run once when the service worker starts.
 *
 * The entries are added here, at installation, rather than by name in `handlers.ts`. That file is U-032's, and
 * its own frozen test asserts that the registry *as declared* refuses every type but `ext/get-status` with
 * `NO_HANDLER` — a statement that stays true of the module, and of a worker whose features have not run. What
 * the running worker answers is this function's business, and `background.ts` runs every feature before any
 * message can arrive: the router reads the registry when a message comes in, not when it was installed.
 */
export function installReadingSession(): void {
  const live = getReadingSession();
  const registered: Partial<Record<ExtMessage["type"], Handler>> = {
    "ext/read-document": (message, sender) => live.readDocument(message, sender.tab?.id ?? null),
    "ext/command": (message) => live.command(message),
    "ext/stop": () => live.stop(),
    "ext/snapshot": (message) => live.snapshot(message),
  };
  Object.assign(handlers, registered);
  chromeSessionPlatform.onTabClosed((tabId) => {
    void live.tabClosed(tabId);
  });
  chromeSessionPlatform.onTabNavigated((tabId) => {
    void live.navigated(tabId);
  });
}
