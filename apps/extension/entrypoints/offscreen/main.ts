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
 * - one `DocumentModel` lives in memory while it is being read and is written down only when the reader presses
 *   the widget's Save button (F§10.2's rule, Phase 5) — never because a page was opened;
 * - the library the save writes into is F§5.9's records in this document's own IndexedDB, over the same
 *   connection the audio cache uses, and F§8.2's engine is what carries them to the hub;
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

import {
  createCachingChunkSource,
  createHubClient,
  createSyncClient,
  createSyncEngine,
  type HubClient,
  type SyncEngine,
  type SyncGunzip,
  type SyncGzip,
} from "@lectern/api-client";
import {
  type ChunkSource,
  type Clock,
  createPlayerController,
  type DocumentModel,
  type DocumentProvider,
  type LibraryStore,
  type PlayerSettings,
  type PlayerSnapshot,
} from "@lectern/core";
import { createHtmlAudioQueueSink, createIdbBlobCache, createIdbLibraryStore, getDeviceId, openLecternDb } from "@lectern/ui-web";
import { OFFSCREEN_PORT, type OffscreenSettings, OffscreenSettingsMessageSchema } from "../../src/background/offscreen";
import { recordProgress, savePage } from "../../src/library/save-page";
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

/** The library build of the last settings change: F§5.9's store and F§8.2's engine, or nothing yet. */
let libraryReady: Promise<void> = Promise.resolve();

/** F§5.9's records for the pages this reader keeps (F§10.2's save). */
let library: LibraryStore | null = null;

/** F§8.2's round and F§8.3's feed, over the same hub the audio comes from. */
let sync: SyncEngine | null = null;

/** The document last seen in the library, so a published snapshot can say whether the page is saved. */
let savedDocId: string | null = null;

/** The last position a progress write was considered for, so a 50 ms sample does not read the store twenty times a second. */
let lastProgress: string | null = null;

/** The answer a save gets when no page is loaded. */
const NO_DOCUMENT = "NO_DOCUMENT";

/** The answer a save gets when the library could not be built — a hub that is not configured. */
const NO_LIBRARY = "NO_LIBRARY";

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

/** Whether the document being read is one the library holds, which is what the widget's Save button shows. */
function saved(): boolean {
  return reading !== null && savedDocId === reading.docId;
}

/**
 * Write the reader's place, at most once per position.
 *
 * The five-second throttle F§5.9's progress wants belongs to `recordProgress`, which reads the last write's own
 * timestamp out of the store; this guard is only what keeps a 50 ms sample from asking the store a question
 * twenty times a second for an answer that cannot have changed.
 */
function rememberProgress(snapshot: PlayerSnapshot): void {
  const key = `${snapshot.state}:${snapshot.docId ?? ""}:${snapshot.sentenceIndex}:${snapshot.wordIndex}`;
  if (key === lastProgress) return;
  lastProgress = key;
  const store = library;
  const engine = sync;
  if (store === null || engine === null) return;
  void recordProgress(store, engine, snapshot).catch(() => undefined);
}

/**
 * Publish the player's state. `force` is set for a change of state, which is what "on every state change" means
 * here; a sample taken by the loop is rate-limited to one per 50 ms, which is what "at most every 50 ms" means.
 */
function publish(force: boolean): void {
  const snapshot = controller.snapshot();
  const at = Date.now();
  if (!force && at - lastPublished < SNAPSHOT_INTERVAL_MS) return;
  lastPublished = at;
  void chrome.runtime.sendMessage({ type: "ext/snapshot", snapshot, title: title(), saved: saved() }).catch(() => undefined);
  rememberProgress(snapshot);
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

/** F§7.2's model body: the JSON text as a gzip container, over this document's own compressor. */
const gzipText: SyncGzip = async (text) => {
  const compressed = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
};

/** F§7.2's model body read back: the container as the JSON text it holds. */
const gunzipText: SyncGunzip = async (bytes) => {
  // A fresh, exactly-sized copy: a `Uint8Array` view of a shared buffer is not a `BlobPart` in this repo's
  // DOM types, and the container is what the blob is for.
  const decompressed = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(decompressed).text();
};

/**
 * Build F§5.9's records and F§8.2's engine for the connection the settings describe.
 *
 * The store is this document's own — the same IndexedDB connection the audio cache lives on, and the same
 * identity (`getDeviceId`), so a page saved here and a chunk cached here are the same installation's — while the
 * engine is U-058's, driven by the document's own clock and the browser's reachability signal. It is started,
 * which is what gives F§8.3's five-minute pull and its first round; a hub nobody can reach is a state the engine
 * reports rather than an exception this file has to handle.
 */
async function buildLibrary(settings: OffscreenSettings): Promise<void> {
  const db = await connection();
  const store = createIdbLibraryStore({
    db,
    deviceId: await getDeviceId(db),
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
  });
  library = store;
  const built = createSyncClient({
    baseUrl: settings.hubUrl,
    token: settings.token,
    fetch: (input, init) => globalThis.fetch(input, init),
    gzip: gzipText,
    gunzip: gunzipText,
  });
  const previous = sync;
  const engine = createSyncEngine({
    store,
    client: built,
    clock: CLOCK,
    isOnline: () => globalThis.navigator.onLine,
    gzip: gzipText,
    gunzip: gunzipText,
  });
  sync = engine;
  previous?.stop();
  await engine.start();
}

/**
 * Whether the library already holds a document, answered as the identifier the snapshot publishes.
 *
 * One store read, taken when a reading starts rather than on every published snapshot: whether the page is
 * saved cannot change while it is being read except by the Save button, which is what the caller does next.
 */
async function knownSaved(docId: string): Promise<string | null> {
  const store = library;
  if (store === null) return null;
  try {
    return (await store.getDocumentMeta(docId)) === null ? null : docId;
  } catch {
    return null;
  }
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
    // The builds are remembered rather than awaited, so a settings push stays synchronous and a message handler
    // is never blocked by it; `readDocument` and the Save button wait for the ones they need. They are two
    // promises because they fail apart: a library that could not be opened is no reason to stop playing, and a
    // hub nobody can reach is no reason to stop keeping pages in the local library.
    prepared = buildSource(next);
    prepared.catch(() => undefined);
    libraryReady = buildLibrary(next);
    libraryReady.catch(() => undefined);
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
  // The library is the local half of the same connection, so a save is offered only once it is there; whether
  // this page is already saved is asked once, here, rather than on every published snapshot.
  await libraryReady.catch(() => undefined);
  savedDocId = await knownSaved(document.docId);
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

/**
 * Keep the page being read in the library (F§10.2's Save button, Phase 5).
 *
 * A save with nothing loaded is refused by name, and so is one the library could not be built for — a hub the
 * reader has not configured — because those are different answers to the reader's press and the widget shows the
 * page as saved only when the offscreen document says it is. On success the state is published at once, so the
 * widget's own button changes without waiting for the next sample.
 */
async function saveCurrent(): Promise<ExtReply> {
  const document = reading;
  if (document === null) return failReply(NO_DOCUMENT, "no page is being read");
  await libraryReady.catch(() => undefined);
  const store = library;
  const engine = sync;
  if (store === null || engine === null) return failReply(NO_LIBRARY, "the hub is not configured yet");
  const result = await savePage({ store, engine, document, now: Date.now() });
  savedDocId = result.docId;
  publish(true);
  return okReply(result);
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
  if (message.type === "ext/save-page") return await saveCurrent();
  return failReply("NO_HANDLER", `the offscreen document does not handle ${message.type}`);
}

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  const message = parseExtMessage(raw);
  if (message === null) return undefined;
  // Only the background drives playback: a copy that carries a tab is a page's or a content script's own, and
  // the background is relaying the one that acts. The one exception is the widget's own Save request, which is
  // *sent* from the page it is on because the page cannot reach the library itself, and which is answered only
  // here — the worker has no handler for it, so its own refusal is not this document's answer to read.
  if (sender.tab !== undefined && message.type !== "ext/save-page") return undefined;
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
