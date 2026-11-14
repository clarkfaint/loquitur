/**
 * The offscreen document (F§10.2): the extension's audio host, and the only context that plays audio or calls
 * the hub.
 *
 * It is built from what the service worker pushes over its port — the hub address and token, the voice, the
 * speed, the furniture rule — because this realm has no `chrome.storage` to read them from: measured on this
 * host, `Object.keys(chrome)` here is `["loadTimes", "csi", "runtime"]`. Everything else is the browser's own:
 * an `Audio` element to play through, IndexedDB to keep synthesized chunks in, `fetch` to reach the hub.
 *
 * The player it hosts is U-013's frozen controller over U-024's sink and U-021's caching chunk source. This file
 * is the wiring and nothing else:
 *
 * - one `DocumentModel` lives in memory while it is being read and is never written down (the contract's rule);
 * - a settings change rebuilds the hub client and the chunk source, behind a `ChunkSource` the controller already
 *   holds, so a reading in progress is not torn down to change where the next chunk comes from;
 * - the player's state is published on every change and, while it is playing, sampled and published at most
 *   once every 50 ms, so a view sees the sentence advance without the player having to announce it.
 *
 * Instructions arrive from the background and only from the background. A `chrome.runtime` message is a
 * broadcast to every context (measured), so a page's own copy of an `ext/command` reaches this document too —
 * and executing it twice would make a `toggle` cancel itself. The background's relay is the one without a tab,
 * which is what the listener below acts on.
 */

import { createCachingChunkSource, createHubClient, type HubClient } from "@lectern/api-client";
import {
  type ChunkSource,
  type Clock,
  createPlayerController,
  type DocumentModel,
  type DocumentProvider,
  type PlayerSettings,
  type PlayerSnapshot,
} from "@lectern/core";
import { createHtmlAudioQueueSink, createIdbBlobCache, openLecternDb } from "@lectern/ui-web";
import { OFFSCREEN_PORT, type OffscreenSettings, OffscreenSettingsMessageSchema } from "../../src/background/offscreen";
import { type ExtMessage, type ExtReply, failReply, messageOf, okReply, parseExtMessage } from "../../src/messages";

/** How often the player is sampled while it is playing: the contract's own ceiling. */
const SNAPSHOT_INTERVAL_MS = 50;

/** F§10.1's defaults for the two preferences the extension's settings record does not carry. */
const SKIP_CITATIONS = true;
const LOOKAHEAD_MS = 0;

/** The document's own clock — this is a page, so its timers are the ones a browser hands back. */
const CLOCK: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (handle) => window.clearTimeout(handle),
};

/** The document being read, in memory for this session only. */
let reading: DocumentModel | null = null;

/** The settings the worker last pushed. */
let hub: OffscreenSettings | null = null;

/** The hub client the settings built, while it is usable. */
let client: HubClient | null = null;

/** The source the controller asks for audio: rebuilt when the settings change. */
let engine: ChunkSource | null = null;

/** The build the last settings change started, so a read can wait for the source it is about to need. */
let prepared: Promise<void> = Promise.resolve();

/** The three preferences the controller reads while it works, mutated in place so a change needs no rebuild. */
const preferences: PlayerSettings = {
  skipFurniture: true,
  skipCitations: SKIP_CITATIONS,
  lookaheadMs: LOOKAHEAD_MS,
};

/** The one open connection to the library database, opened on first use and kept. */
let opened: ReturnType<typeof openLecternDb> | null = null;

/** The library database, opened once. */
function connection(): ReturnType<typeof openLecternDb> {
  opened ??= openLecternDb();
  return opened;
}

/** The document the player resolves a `docId` through: the one in memory, and nothing else. */
const documents: DocumentProvider = {
  get: async (docId) => (reading !== null && reading.docId === docId ? reading : null),
};

/**
 * The `ChunkSource` the controller holds for its whole life. It delegates to whatever client the settings last
 * built, so a settings change replaces the client without replacing the player.
 */
const chunks: ChunkSource = {
  get: async (request) => {
    const source = engine;
    if (source === null) throw new Error("the hub is not configured yet");
    return await source.get(request);
  },
};

const controller = createPlayerController({
  sink: createHtmlAudioQueueSink(),
  chunks,
  documents,
  clock: CLOCK,
  settings: preferences,
});

/** What a snapshot is published with: the document's title, or nothing while none is loaded. */
function title(): string {
  return reading?.title ?? "";
}

/** When the last snapshot was published, for the rate limit below. */
let lastPublished = 0;

/** The state the last published snapshot carried. */
let lastState: PlayerSnapshot["state"] | null = null;

/** The sampling loop's handle, while it runs. */
let beat: number | null = null;

/**
 * Publish the player's state. `force` is set for a change of state, which is what "on every state change" means
 * here; a sample taken by the loop is rate-limited to one per 50 ms, which is what "at most every 50 ms" means.
 */
function publish(force: boolean): void {
  const snapshot = controller.snapshot();
  const at = Date.now();
  if (!force && at - lastPublished < SNAPSHOT_INTERVAL_MS) return;
  lastPublished = at;
  void chrome.runtime.sendMessage({ type: "ext/snapshot", snapshot, title: title() }).catch(() => undefined);
}

/** Run the sampling loop exactly while the player is playing. */
function syncBeat(state: PlayerSnapshot["state"]): void {
  if (state === "playing" && beat === null) {
    beat = window.setInterval(() => publish(false), SNAPSHOT_INTERVAL_MS);
  }
  if (state !== "playing" && beat !== null) {
    window.clearInterval(beat);
    beat = null;
  }
}

controller.subscribe((snapshot) => {
  const changed = snapshot.state !== lastState;
  lastState = snapshot.state;
  publish(changed);
  syncBeat(snapshot.state);
});

/** Build the hub client and the chunk source the settings describe. */
async function buildSource(settings: OffscreenSettings): Promise<void> {
  const cache = createIdbBlobCache({ db: await connection(), now: () => Date.now() });
  // The page's own `fetch`, called as a function of its own: passing it unbound makes `this` the client's
  // options object and Chrome refuses the call ("Illegal invocation") — the same wrapper the web app uses.
  const built = createHubClient({ baseUrl: settings.hubUrl, token: settings.token, fetch: (input, init) => globalThis.fetch(input, init) });
  client = built;
  engine = createCachingChunkSource({ client: built, cache });
}

/**
 * Take the settings the worker pushed: remember them, mirror the furniture rule into the player's preferences,
 * and — only when the hub itself moved — rebuild the client. Voice and speed are handed to the player as
 * commands, which is how every other view changes them (F§5.7), so a change reaches a reading in progress.
 */
function applySettings(next: OffscreenSettings): void {
  const previous = hub;
  hub = next;
  preferences.skipFurniture = next.skipFurniture;
  if (previous === null || previous.hubUrl !== next.hubUrl || previous.token !== next.token) {
    // The build is remembered rather than awaited, so a settings push stays synchronous and a message handler
    // is never blocked by it; `readDocument` waits for it before it asks the hub for anything.
    prepared = buildSource(next);
    prepared.catch(() => undefined);
  }
  if (previous === null) return;
  if (previous.rate !== next.rate) void controller.dispatch({ type: "setRate", rate: next.rate });
  if (previous.voiceId !== next.voiceId && next.voiceId !== "") {
    void controller.dispatch({ type: "setVoice", voiceId: next.voiceId });
  }
}

/** The voice a document is read with: the reader's own, or the hub's first. */
async function voiceFor(settings: OffscreenSettings): Promise<string> {
  if (settings.voiceId !== "") return settings.voiceId;
  const live = client;
  if (live === null) return "";
  try {
    return (await live.voices())[0]?.id ?? "";
  } catch {
    // A hub that cannot list its voices cannot be asked for audio either; the player reports that itself.
    return "";
  }
}

/** Load a document and start reading it, from `startSentence` when the caller names one. */
async function readDocument(document: DocumentModel, startSentence: number | undefined): Promise<ExtReply> {
  const settings = hub;
  if (settings === null) return failReply("OFFSCREEN_UNAVAILABLE", "the extension's settings have not arrived");
  // The chunk source is built from those settings, and the first sentence is asked for as soon as the player is
  // told to play: waiting for the build here is what keeps the first chunk from being asked of nothing.
  await prepared.catch(() => undefined);
  if (engine === null) return failReply("OFFSCREEN_UNAVAILABLE", "the hub could not be configured");
  reading = document;
  const voiceId = await voiceFor(settings);
  if (voiceId !== "") await controller.dispatch({ type: "setVoice", voiceId });
  await controller.dispatch({ type: "setRate", rate: settings.rate });
  await controller.dispatch({
    type: "load",
    docId: document.docId,
    position: { docId: document.docId, sentenceIndex: startSentence ?? 0, wordIndex: 0 },
  });
  await controller.dispatch({ type: "play" });
  return okReply(null);
}

/** Do what one instruction asks. */
async function handle(message: ExtMessage): Promise<ExtReply> {
  if (message.type === "ext/read-document") return await readDocument(message.document, message.startSentence);
  if (message.type === "ext/command") {
    await controller.dispatch(message.command);
    return okReply(null);
  }
  if (message.type === "ext/stop") {
    reading = null;
    await controller.dispatch({ type: "stop" });
    return okReply(null);
  }
  return failReply("NO_HANDLER", `the offscreen document does not handle ${message.type}`);
}

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  const message = parseExtMessage(raw);
  if (message === null) return undefined;
  // Only the background drives playback: a copy that carries a tab is a page's or a content script's own, and
  // the background is relaying the one that acts.
  if (sender.tab !== undefined) return undefined;
  void handle(message).then(sendResponse, (cause: unknown) => sendResponse(failReply("HANDLER_FAILED", messageOf(cause))));
  return true;
});

// The port to the service worker: the settings arrive on it, and opening it is also how this document tells the
// worker it is awake and can be sent a document.
const port = chrome.runtime.connect({ name: OFFSCREEN_PORT });
port.onMessage.addListener((raw) => {
  const message = OffscreenSettingsMessageSchema.safeParse(raw);
  if (!message.success) return;
  applySettings(message.data.settings);
});
