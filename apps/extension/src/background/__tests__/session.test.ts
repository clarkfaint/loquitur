/**
 * The reading session's tests (F§10.2).
 *
 * The session is driven through its real platform — the one built from `chrome.runtime`, `chrome.tabs` and the
 * offscreen module — rather than through a hand-made stand-in, so what these cases exercise is the code the
 * service worker runs. The `chrome` double below is the smallest surface those calls touch: two message
 * senders, the two tab events, the context query, the offscreen document's two calls, and the storage read the
 * settings channel makes. It records what was sent, and the tab events are fired the way Chrome fires them, so
 * the session's own filter on `onUpdated` is under test too.
 */

import { buildDocument, type DocumentModel, type PlayerSnapshot } from "@lectern/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ExtMessage, okReply } from "../../messages";
import { handlers } from "../handlers";
import { installOffscreenBridge } from "../offscreen";
import {
  chromeSessionPlatform,
  createReadingSession,
  getReadingSession,
  installReadingSession,
  NO_SESSION,
  OFFSCREEN_UNAVAILABLE,
  type ReadingSession,
} from "../session";

/** The tab a document arrives from in these cases. */
const TAB = 7;

/** The tab the extension is looking at, when a caller names none. */
const ACTIVE_TAB = 11;

/** A three-sentence document, built by core's own builder so its shape cannot drift from the model's. */
const DOCUMENT: DocumentModel = buildDocument(
  [{ kind: "paragraph", text: "The harbour holds the light. Boats wait for the tide. Nothing here is in a hurry." }],
  {
    title: "Harbour Light",
    source: { kind: "txt" },
  },
);

/** One message the session sent. */
interface Sent {
  where: "extension" | "tab";
  tabId: number | null;
  message: ExtMessage;
}

/** The `chrome` double, with the two ways a test fires its events. */
interface ChromeDouble {
  sent: Sent[];
  closeTab(tabId: number): void;
  navigate(tabId: number, url: string): void;
  failSends(): void;
}

/** A state snapshot, as the offscreen document would post it. */
function snapshotOf(state: PlayerSnapshot["state"]): PlayerSnapshot {
  return { state, docId: DOCUMENT.docId, sentenceIndex: 0, wordIndex: 0, rate: 1, voiceId: null, sleepRemainingMs: null, error: null };
}

/** Install a `chrome` double, and answer the handles a case needs. */
function installChrome(): ChromeDouble {
  const sent: Sent[] = [];
  const removed: ((tabId: number) => void)[] = [];
  const updated: ((tabId: number, change: { url?: string | undefined; status?: string | undefined }) => void)[] = [];
  const connections: ((port: unknown) => void)[] = [];
  let open = false;
  let failing = false;

  /** What the offscreen document's own port would do, once one is connected. */
  function connectedPort(): void {
    const posted: unknown[] = [];
    const port = {
      name: "lectern-offscreen",
      postMessage: (message: unknown) => posted.push(message),
      disconnect: () => undefined,
      onDisconnect: { addListener: () => undefined },
    };
    for (const listener of connections) listener(port);
  }

  const send = async (where: Sent["where"], tabId: number | null, message: ExtMessage): Promise<unknown> => {
    if (failing) throw new Error("Could not establish connection. Receiving end does not exist.");
    sent.push({ where, tabId, message });
    return okReply(null);
  };

  const fake = {
    runtime: {
      sendMessage: async (message: ExtMessage) => await send("extension", null, message),
      onConnect: { addListener: (listener: (port: unknown) => void) => connections.push(listener) },
      getContexts: async () => (open ? [{ contextType: "OFFSCREEN_DOCUMENT", documentUrl: "chrome-extension://test/offscreen.html" }] : []),
    },
    tabs: {
      sendMessage: async (tabId: number, message: ExtMessage) => await send("tab", tabId, message),
      query: async () => [{ id: ACTIVE_TAB }],
      onRemoved: { addListener: (listener: (tabId: number) => void) => removed.push(listener) },
      onUpdated: {
        addListener: (listener: (tabId: number, change: { url?: string | undefined; status?: string | undefined }) => void) =>
          updated.push(listener),
      },
    },
    offscreen: {
      createDocument: async () => {
        open = true;
        // The document's script opens its port on its own first line, which is what `ensureOffscreen` waits for.
        connectedPort();
      },
      closeDocument: async () => {
        open = false;
      },
    },
    storage: {
      local: {
        get: async () => ({
          "lectern.extension.settings": { hubUrl: "http://127.0.0.1:8787", token: "t", voiceId: "mock:mock-a", rate: 1 },
        }),
        onChanged: { addListener: () => undefined, removeListener: () => undefined },
      },
    },
  };

  vi.stubGlobal("chrome", fake);
  // The service worker installs the settings channel when it starts, which is what gives the document's port a
  // listener to reach. Without it nothing ever connects, exactly as in a worker that forgot to.
  installOffscreenBridge();

  return {
    sent,
    closeTab: (tabId) => {
      for (const listener of removed) listener(tabId);
    },
    navigate: (tabId, url) => {
      for (const listener of updated) listener(tabId, { url, status: "loading" });
    },
    failSends: () => {
      failing = true;
    },
  };
}

/** A session over a freshly installed double, with the tab events wired the way the installer wires them. */
function sessionWithSetup(): { session: ReadingSession; double: ChromeDouble } {
  const double = installChrome();
  const session = createReadingSession();
  // `installReadingSession` is what watches these two events for the service worker's own session; a case that
  // makes its own session wires them itself, so the tests below exercise the same adapter.
  chromeSessionPlatform.onTabClosed((tabId) => {
    void session.tabClosed(tabId);
  });
  chromeSessionPlatform.onTabNavigated((tabId) => {
    void session.navigated(tabId);
  });
  return { session, double };
}

/** The messages the session sent to the extension's other contexts. */
function toExtension(sent: Sent[]): ExtMessage[] {
  return sent.filter((record) => record.where === "extension").map((record) => record.message);
}

/** The messages the session sent to one tab. */
function toTab(sent: Sent[], tabId: number): ExtMessage[] {
  return sent.filter((record) => record.where === "tab" && record.tabId === tabId).map((record) => record.message);
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("the reading session", () => {
  it("relays a document to the offscreen document and remembers the tab it came from", async () => {
    const { session, double } = sessionWithSetup();
    const answer = await session.readDocument({ type: "ext/read-document", document: DOCUMENT }, TAB);

    expect(answer.ok).toBe(true);
    expect(session.tabId).toBe(TAB);
    expect(toExtension(double.sent)).toContainEqual({ type: "ext/read-document", document: DOCUMENT });
  });

  it("relays a start sentence when the caller names one", async () => {
    const { session, double } = sessionWithSetup();
    await session.readDocument({ type: "ext/read-document", document: DOCUMENT, startSentence: 2 }, TAB);

    expect(toExtension(double.sent)).toContainEqual({ type: "ext/read-document", document: DOCUMENT, startSentence: 2 });
  });

  it("forwards the player's state to the tab being read and to the popup", async () => {
    const { session, double } = sessionWithSetup();
    await session.readDocument({ type: "ext/read-document", document: DOCUMENT }, TAB);
    const snapshot: ExtMessage = { type: "ext/snapshot", snapshot: snapshotOf("playing"), title: "Harbour Light" };

    const answer = await session.snapshot(snapshot);

    expect(answer.ok).toBe(true);
    expect(toTab(double.sent, TAB)).toContainEqual(snapshot);
    expect(toExtension(double.sent)).toContainEqual(snapshot);
  });

  it("refuses a command while nothing is being read", async () => {
    const { session } = sessionWithSetup();
    const answer = await session.command({ type: "ext/command", command: { type: "pause" } });

    expect(answer).toEqual({ ok: false, code: NO_SESSION, message: expect.any(String) });
  });

  it("relays a command once a document is being read", async () => {
    const { session, double } = sessionWithSetup();
    await session.readDocument({ type: "ext/read-document", document: DOCUMENT }, TAB);
    const answer = await session.command({ type: "ext/command", command: { type: "pause" } });

    expect(answer.ok).toBe(true);
    expect(toExtension(double.sent)).toContainEqual({ type: "ext/command", command: { type: "pause" } });
  });

  it("reports an offscreen document that cannot be reached", async () => {
    const { session, double } = sessionWithSetup();
    await session.readDocument({ type: "ext/read-document", document: DOCUMENT }, TAB);
    double.failSends();

    const answer = await session.command({ type: "ext/command", command: { type: "play" } });

    expect(answer.ok).toBe(false);
    expect(answer.ok ? "" : answer.code).toBe(OFFSCREEN_UNAVAILABLE);
  });

  it("stops when the tab it is reading closes", async () => {
    const { session, double } = sessionWithSetup();
    await session.readDocument({ type: "ext/read-document", document: DOCUMENT }, TAB);

    double.closeTab(TAB);
    await vi.waitFor(() => expect(session.tabId).toBeNull());

    expect(toExtension(double.sent)).toContainEqual({ type: "ext/stop" });
  });

  it("stops when the tab it is reading navigates", async () => {
    const { session, double } = sessionWithSetup();
    await session.readDocument({ type: "ext/read-document", document: DOCUMENT }, TAB);

    double.navigate(TAB, "https://example.test/next");
    await vi.waitFor(() => expect(session.tabId).toBeNull());

    expect(toExtension(double.sent)).toContainEqual({ type: "ext/stop" });
  });

  it("leaves the reading alone when another tab closes", async () => {
    const { session, double } = sessionWithSetup();
    await session.readDocument({ type: "ext/read-document", document: DOCUMENT }, TAB);

    double.closeTab(TAB + 1);
    await Promise.resolve();

    expect(session.tabId).toBe(TAB);
  });

  it("lets a second tab's reading take over from the first", async () => {
    const { session, double } = sessionWithSetup();
    await session.readDocument({ type: "ext/read-document", document: DOCUMENT }, TAB);

    const answer = await session.readDocument({ type: "ext/read-document", document: DOCUMENT }, TAB + 2);

    expect(answer.ok).toBe(true);
    expect(session.tabId).toBe(TAB + 2);
    expect(toExtension(double.sent)).toContainEqual({ type: "ext/stop" });
  });

  it("reads the active tab when a message arrives without one", async () => {
    const { session } = sessionWithSetup();
    await session.readDocument({ type: "ext/read-document", document: DOCUMENT }, null);

    expect(session.tabId).toBe(ACTIVE_TAB);
  });

  it("answers a stop with a session and without one", async () => {
    const { session, double } = sessionWithSetup();
    expect((await session.stop()).ok).toBe(true);
    expect(session.tabId).toBeNull();

    await session.readDocument({ type: "ext/read-document", document: DOCUMENT }, TAB);
    expect((await session.stop()).ok).toBe(true);
    expect(session.tabId).toBeNull();
    expect(toExtension(double.sent)).toContainEqual({ type: "ext/stop" });
  });

  it("registers the messages it answers when it is installed", async () => {
    installChrome();
    installReadingSession();

    expect(handlers["ext/read-document"]).toBeTypeOf("function");
    const reply = await handlers["ext/command"]?.({ type: "ext/command", command: { type: "play" } }, {} as chrome.runtime.MessageSender);
    expect(reply).toMatchObject({ ok: false, code: NO_SESSION });
  });

  it("watches the tab events for the service worker's own session when it is installed", async () => {
    const double = installChrome();
    installReadingSession();
    const session = getReadingSession();
    await session.readDocument({ type: "ext/read-document", document: DOCUMENT }, TAB);

    double.navigate(TAB, "https://example.test/next");

    await vi.waitFor(() => expect(session.tabId).toBeNull());
  });
});
