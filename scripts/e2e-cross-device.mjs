#!/usr/bin/env node

// Lectern cross-device end-to-end verification (U-067, F§8, F§9, F§5.8).
//
//   node scripts/e2e-cross-device.mjs
//
// One hub, two simulated devices, and every promise that has to hold *between* them: a text parsed on device A
// and read aloud there through real chunks fetched from the hub, a bookmark and a reading position written
// locally, a sync round that carries all three to device B, B fetching the document body lazily and resuming at
// the position A left off, a summary B asks for and both devices then read the same answer from, and a backup
// of the hub's own data downloaded and listed. Every check prints one line; the first failure exits 1.
//
// The hub is the repository's own `@lectern/server` with F§7.1's mock engine enabled and U-062's mock LLM
// endpoint as F§9's provider, over a temporary data directory, so the run touches no disk outside it and needs
// no service, no device and no network beyond the loopback socket the mock endpoint listens on.
//
// This file is a Node module and the workspace's packages are TypeScript sources whose relative imports carry no
// extension, which Node's own module resolution refuses; the resolver registered below appends the `.ts` each
// specifier names, and Node's built-in type stripping does the rest. That keeps this script a zero-dependency
// `node` program — R10 admits no dependency for the repository root — while it drives the real packages.

import { mkdtemp, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

/** The repository root: this file lives in `<root>/scripts`. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The resolver Node is registered with: a relative specifier without an extension — or one naming the `.js` a
 * TypeScript source maps to — is answered as the `.ts` file beside it. Everything else is left to the default
 * resolver, so a bare package specifier still resolves through `node_modules` exactly as it always did.
 */
const TS_RESOLVER = `
export async function resolve(specifier, context, next) {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    if (!/\\.[a-z0-9]+$/i.test(specifier)) {
      try { return await next(specifier + ".ts", context); } catch {}
      try { return await next(specifier + "/index.ts", context); } catch {}
    } else if (specifier.endsWith(".js")) {
      try { return await next(specifier.slice(0, -3) + ".ts", context); } catch {}
    }
  }
  return next(specifier, context);
}
`;

register(`data:text/javascript,${encodeURIComponent(TS_RESOLVER)}`);

/** One module of the workspace, by its path from the repository root. */
const load = async (relative) => await import(pathToFileURL(join(REPO_ROOT, relative)).href);

const { createMemoryBlobCache, createMemoryLibraryStore, createPlayerController } = await load("packages/core/src/index.ts");
const { FakeClock, FakeSink } = await load("packages/core/src/testing/index.ts");
const { createAiClient, createCachingChunkSource, createHubClient, createSyncClient, createSyncEngine } =
  await load("packages/api-client/src/index.ts");
const { fetchFromFastify } = await load("packages/api-client/src/testing/index.ts");
const { buildApp, loadConfig } = await load("apps/server/src/index.ts");
const { startMockLlm } = await load("apps/server/src/testing/index.ts");

/** F§7.1's token floor is 32 characters; this one is this run's own and appears nowhere else. */
const TOKEN = "lectern-cross-device-token-0123456789";

/** The model name the hub hands F§9's provider. The mock endpoint answers it like any other name. */
const MODEL = "lectern-cross-device-model";

/** The hub's origin. Nothing listens on it: the transport is the app's own `inject`. */
const BASE_URL = "http://127.0.0.1:8787";

/** The sentences device A reads. Original text, written for this check (AGENTS.md §4.6). */
const PROBE_SENTENCES = [
  "Lectern reads a document aloud.",
  "The player asks the hub for one chunk per sentence.",
  "Each chunk carries its words and the times they fall at.",
  "A second device pulls the record and resumes where the first one stopped.",
  "A bookmark travels with it, and so does the reading position.",
  "The summary is written by the model the hub was configured with.",
];
const PROBE_TEXT = PROBE_SENTENCES.join(" ");

/** How many of the document's sentences device A reads before it stops. */
const SENTENCES_PLAYED = 3;

/** Where device A leaves its bookmark and its reading position: the fourth sentence, at its second word. */
const PARKED_SENTENCE = 3;
const PARKED_WORD = 1;

/** How long one step's promise of asynchronous work is given to settle, in event-loop turns. */
const SETTLE_TURNS = 8;

/** One line of progress, so a run says what it proved rather than only whether it finished. */
let stepNumber = 0;

/** Print one completed step. */
function step(name, detail) {
  stepNumber += 1;
  process.stdout.write(`OK    ${String(stepNumber).padStart(2, "0")}. ${name} — ${detail}\n`);
}

/** The first failure ends the run: what was asked, and why it did not hold. */
function fail(name, reason) {
  process.stdout.write(`FAIL  ${String(stepNumber + 1).padStart(2, "0")}. ${name} — ${reason}\n`);
  process.exit(1);
}

/** Assert something the run depends on, with the step it belongs to named in the failure. */
function check(name, condition, reason) {
  if (!condition) fail(name, reason);
}

/** A real clock in F§5.7's shape: whole-number handles, so a caller can clear what it scheduled. */
function createClock() {
  const handles = new Map();
  let next = 1;
  return {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => {
      const handle = next;
      next += 1;
      handles.set(
        handle,
        setTimeout(() => {
          handles.delete(handle);
          callback();
        }, delayMs),
      );
      return handle;
    },
    clearTimeout: (handle) => {
      const scheduled = handles.get(handle);
      if (scheduled === undefined) return;
      clearTimeout(scheduled);
      handles.delete(handle);
    },
    /** Drop every timer this clock still holds, so a finished run leaves no handle behind. */
    clear: () => {
      for (const scheduled of handles.values()) clearTimeout(scheduled);
      handles.clear();
    },
  };
}

/** Let the event loop turn enough times for the promises a dispatch started to settle. */
async function settle() {
  for (let turn = 0; turn < SETTLE_TURNS; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** F§7.2's model container: the `DocumentModel` JSON, gzipped, as the client's own codec pair sends it. */
const gzip = async (text) => new Uint8Array(gzipSync(Buffer.from(text)));

/** The container as the text it holds. */
const gunzip = async (bytes) => gunzipSync(Buffer.from(bytes)).toString("utf8");

/** F§5.9's document metadata for a parsed document, exactly as the import services build it. */
function metaFor(document, addedAt) {
  const meta = {
    docId: document.docId,
    title: document.title,
    sourceKind: document.source.kind,
    folderId: null,
    addedAt,
    wordCount: document.wordCount,
    sentenceCount: document.sentenceCount,
    updatedAt: addedAt,
    deleted: false,
  };
  return document.source.uri === undefined ? meta : { ...meta, sourceUri: document.source.uri };
}

/** A `tar` archive's members: each name as it is written, and the bytes it holds. */
function tarEntries(bytes) {
  const entries = new Map();
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    const field = (start, length) => {
      const slice = header.subarray(start, start + length);
      let end = 0;
      while (end < slice.length && slice[end] !== 0) end += 1;
      return decoder.decode(slice.subarray(0, end));
    };
    const name = field(0, 100).replace(/^\.\//, "");
    if (name === "") break;
    const size = Number.parseInt(field(124, 12).trim(), 8);
    const body = Number.isFinite(size) ? size : 0;
    entries.set(name, bytes.subarray(offset + 512, offset + 512 + body));
    offset += 512 + Math.ceil(body / 512) * 512;
  }
  return entries;
}

/**
 * The app's `inject` behind the transport the clients take, with a `204` read as a `200`.
 *
 * `fetchFromFastify` builds a `Response` from every answer it gets, and the `Response` constructor refuses a
 * body on a null-body status — so the hub's `PUT …/model`, which answers `204`, would surface as a transport
 * failure ("the hub could not be reached") rather than as the success it was. U-058's own suite wraps the app
 * the same way for the same reason; nothing here can change that frozen adapter (R6).
 */
function readableApp(app) {
  return {
    inject: async (options) => {
      const answer = await app.inject(options);
      if (answer.statusCode !== 204) return answer;
      return { statusCode: 200, headers: answer.headers, rawPayload: new Uint8Array() };
    },
  };
}

/** A hub over a temporary data directory, with the mock endpoint as F§9's provider. */
async function startHub() {
  const mock = await startMockLlm();
  const dataDir = await mkdtemp(join(tmpdir(), "lectern-cross-device-"));
  const config = loadConfig({
    LECTERN_TOKEN: TOKEN,
    LECTERN_DATA_DIR: dataDir,
    LECTERN_ENABLE_MOCK: "1",
    LLM_BASE_URL: mock.baseUrl,
    LLM_MODEL: MODEL,
  });
  const app = await buildApp(config);
  return { app, dataDir, mock, fetch: fetchFromFastify(readableApp(app)) };
}

/** One device: its record store, its blob cache, its clock, its engines and its transport to the hub. */
function createDevice(deviceId, hub) {
  const clock = createClock();
  let serial = 0;
  const store = createMemoryLibraryStore({
    deviceId,
    now: () => clock.now(),
    newId: () => {
      serial += 1;
      return `${deviceId}-op-${serial}`;
    },
  });
  const cache = createMemoryBlobCache();
  const calls = [];
  const transport = async (input, init) => {
    const url = new URL(input instanceof URL ? input.href : String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    return await hub.fetch(input, init);
  };
  const hubClient = createHubClient({ baseUrl: BASE_URL, token: TOKEN, fetch: transport });
  const syncClient = createSyncClient({ baseUrl: BASE_URL, token: TOKEN, fetch: transport, gzip, gunzip });
  const aiClient = createAiClient({ baseUrl: BASE_URL, token: TOKEN, fetch: transport });
  const chunks = createCachingChunkSource({ client: hubClient, cache });
  const engine = createSyncEngine({ store, client: syncClient, clock });
  return { deviceId, clock, store, cache, calls, transport, hubClient, aiClient, chunks, engine };
}

/** A player on one device, over that device's own store and its own hub-backed chunk cache. */
function createPlayer(device) {
  // The player's own clock is the manual one the sink and the prefetch window move on: a run advances it by
  // hand, so "three sentences of audio" costs no wall time and the round trips to the hub are the only real
  // waiting done (F§5.7's injected clock).
  const clock = new FakeClock();
  const sink = new FakeSink({ clock });
  const events = { starts: [], ends: [] };
  sink.on("chunk-start", (event) => events.starts.push(event.chunkId));
  sink.on("chunk-end", (event) => events.ends.push(event.chunkId));
  const controller = createPlayerController({
    sink,
    chunks: device.chunks,
    documents: { get: async (docId) => await device.store.getDocumentModel(docId) },
    clock,
    settings: { skipFurniture: true, skipCitations: true, lookaheadMs: 80 },
  });
  return { sink, controller, events, clock };
}

/** Play until `count` sentences have finished, on a sink that only moves when the clock is advanced. */
async function playUntil(player, count) {
  for (let attempt = 0; attempt < 400 && player.events.ends.length < count; attempt += 1) {
    await settle();
    player.clock.advance(100);
  }
  await settle();
}

/** The summary's own shape, as F§9 defines it: a paragraph and the takeaways that go with it. */
function summarise(name, status) {
  check(name, status.status === "done", `the summary job is ${status.status}, not done`);
  const result = status.result;
  check(name, result !== undefined, "the finished job carries no result (F§9)");
  check(name, typeof result.summary === "string" && result.summary.length > 0, "the result carries no summary paragraph");
  check(
    name,
    Array.isArray(result.keyTakeaways) && result.keyTakeaways.length >= 3,
    `the result carries ${result.keyTakeaways?.length ?? 0} takeaways, fewer than 3`,
  );
  return result;
}

const hub = await startHub();
const cleanup = [];
try {
  const { app, mock } = hub;
  const deviceA = createDevice("device-a", hub);
  const deviceB = createDevice("device-b", hub);
  cleanup.push(
    () => deviceA.engine.stop(),
    () => deviceB.engine.stop(),
    () => app.close(),
    () => mock.close(),
  );

  // 1 — the hub answers at all, and F§6's voice list carries the mock engine's voices.
  const health = await deviceA.hubClient.health();
  check("hub", health.ok === true, `/healthz answered ok=${JSON.stringify(health.ok)}`);
  const voices = await deviceA.hubClient.voices();
  const voice = voices[0];
  check("hub", voice !== undefined, "the hub lists no voice although the mock engine is enabled (F§6)");
  step(
    "hub",
    `mock-engine hub up in a temporary directory with the mock LLM endpoint; ${voices.length} voice(s), reading with ${voice.id}`,
  );

  // 2 — device A parses a text through the hub's own parse route.
  const parsed = await deviceA.hubClient.parseText(PROBE_TEXT, "Cross-device probe");
  const document = parsed.document;
  const docId = document.docId;
  check(
    "parse",
    document.sentenceCount === PROBE_SENTENCES.length,
    `the hub built ${document.sentenceCount} sentences from ${PROBE_SENTENCES.length}`,
  );
  await deviceA.store.putDocument(metaFor(document, deviceA.clock.now()), document);
  step(
    "parse",
    `device A parsed the probe through POST /v1/parse — docId ${docId}, ${document.sentenceCount} sentences, ${document.wordCount} words`,
  );

  // 3 — device A reads three of the document's sentences through a fake sink that asks the hub for real chunks.
  const playerA = createPlayer(deviceA);
  await playerA.controller.dispatch({ type: "load", docId });
  await playerA.controller.dispatch({ type: "setVoice", voiceId: voice.id });
  await playerA.controller.dispatch({ type: "play" });
  await playUntil(playerA, SENTENCES_PLAYED);
  await playerA.controller.dispatch({ type: "pause" });
  const afterPlay = playerA.controller.snapshot();
  const ttsCalls = deviceA.calls.filter((call) => call === "POST /v1/tts").length;
  const audioCalls = deviceA.calls.filter((call) => call.startsWith("GET /v1/tts/audio/")).length;
  check(
    "play",
    playerA.events.ends.length >= SENTENCES_PLAYED,
    `the sink finished ${playerA.events.ends.length} chunk(s), fewer than ${SENTENCES_PLAYED}`,
  );
  check("play", ttsCalls >= SENTENCES_PLAYED, `the hub was asked to synthesize ${ttsCalls} chunk(s), fewer than ${SENTENCES_PLAYED}`);
  check("play", audioCalls >= SENTENCES_PLAYED, `the hub served ${audioCalls} chunk body/bodies, fewer than ${SENTENCES_PLAYED}`);
  check(
    "play",
    afterPlay.sentenceIndex > PARKED_SENTENCE - 1,
    `the reader is at sentence ${afterPlay.sentenceIndex} after ${SENTENCES_PLAYED} sentences`,
  );
  const playedChunk = playerA.events.ends[0];
  const playedBytes = await deviceA.cache.get(playedChunk);
  check("play", (await deviceA.cache.has(playedChunk)) === true, `chunk ${playedChunk} is not in the device's blob cache`);
  check("play", (playedBytes?.length ?? 0) > 0, `the cached chunk ${playedChunk} holds no bytes`);
  step(
    "play",
    `device A read ${playerA.events.ends.length} sentences through the fake sink — ${ttsCalls} POST /v1/tts and ${audioCalls} chunk downloads, ${playedBytes.length} bytes cached for ${playedChunk}`,
  );

  // 4 — device A writes a bookmark and a reading position, and syncs: the round uploads the model and pushes.
  await deviceA.store.putBookmark({
    id: "bookmark-a-1",
    docId,
    sentenceIndex: PARKED_SENTENCE,
    wordIndex: PARKED_WORD,
    note: "the second device should see this",
    createdAt: deviceA.clock.now(),
    updatedAt: deviceA.clock.now(),
    deleted: false,
  });
  const parkedAt = { docId, sentenceIndex: PARKED_SENTENCE, wordIndex: PARKED_WORD, updatedAt: deviceA.clock.now() };
  await deviceA.store.setProgress(parkedAt);
  await deviceA.engine.syncNow();
  const statusA = await deviceA.engine.status();
  check("sync A", statusA.pending === 0, `device A still holds ${statusA.pending} unsent op(s) after a round`);
  check("sync A", statusA.state === "idle", `device A's engine is ${statusA.state} after a successful round, not idle`);
  check("sync A", statusA.lastSyncedAt !== null, "device A's engine reports no completed round");
  step(
    "sync A",
    `device A pushed its outbox (${deviceA.calls.filter((call) => call === "POST /v1/sync/push").length} push, ${statusA.pending} pending left) and the hub holds the document's model`,
  );

  // 5 — device B syncs, sees the document, the position and the bookmark, and fetches the body lazily.
  const modelBeforeSync = await deviceB.store.getDocumentModel(docId);
  check("sync B", modelBeforeSync === null, "device B holds the document's body before it has synced anything");
  await deviceB.engine.syncNow();
  const libraryB = await deviceB.store.listDocuments();
  check(
    "sync B",
    libraryB.some((meta) => meta.docId === docId),
    `device B's library holds ${libraryB.length} document(s) and not ${docId}`,
  );
  const progressB = await deviceB.store.getProgress(docId);
  check(
    "sync B",
    progressB?.sentenceIndex === PARKED_SENTENCE && progressB?.wordIndex === PARKED_WORD,
    `device B reads the position as ${JSON.stringify(progressB)}`,
  );
  const bookmarksB = await deviceB.store.listBookmarks(docId);
  check(
    "sync B",
    bookmarksB.length === 1 && bookmarksB[0]?.id === "bookmark-a-1",
    `device B holds ${bookmarksB.length} bookmark(s) for the document`,
  );
  const bodyAfterSync = await deviceB.store.getDocumentModel(docId);
  check("sync B", bodyAfterSync === null, "device B's record round brought the document's body with it (F§8.2 keeps it lazy)");
  const fetched = await deviceB.engine.ensureModel(docId);
  check("sync B", fetched !== null && fetched.docId === docId, "device B could not fetch the document's body from the hub");
  check("sync B", (await deviceB.store.getDocumentModel(docId)) !== null, "the fetched body was not kept in device B's store");
  step(
    "sync B",
    `device B pulled the record, the position (sentence ${progressB.sentenceIndex}, word ${progressB.wordIndex}) and ${bookmarksB.length} bookmark, then fetched the ${fetched.sentenceCount}-sentence body lazily`,
  );

  // 6 — device B resumes at the position it pulled, and its own sink starts on a chunk the hub served.
  const playerB = createPlayer(deviceB);
  await playerB.controller.dispatch({ type: "load", docId, position: { docId, sentenceIndex: PARKED_SENTENCE, wordIndex: PARKED_WORD } });
  await playerB.controller.dispatch({ type: "setVoice", voiceId: voice.id });
  const loadedB = playerB.controller.snapshot();
  check(
    "resume",
    loadedB.sentenceIndex === PARKED_SENTENCE && loadedB.wordIndex === PARKED_WORD,
    `device B's reader opened at ${JSON.stringify({ sentenceIndex: loadedB.sentenceIndex, wordIndex: loadedB.wordIndex })}`,
  );
  await playerB.controller.dispatch({ type: "play" });
  await playUntil(playerB, 1);
  await playerB.controller.dispatch({ type: "pause" });
  check("resume", playerB.events.starts.length >= 1, "device B's sink started no chunk after it resumed");
  step(
    "resume",
    `device B resumed at sentence ${loadedB.sentenceIndex}, word ${loadedB.wordIndex} and played ${playerB.events.ends.length} sentence(s) from the hub's own chunks`,
  );

  // 7 — device B asks for a summary, and both devices then read the same finished result.
  const asked = await deviceB.aiClient.requestSummary(docId, "brief", document);
  const finished = await deviceB.aiClient.waitForSummary(docId, "brief", { clock: deviceB.clock });
  const resultB = summarise("summary", finished);
  const statusA2 = await deviceA.aiClient.getSummary(docId, "brief");
  const resultA = summarise("summary", statusA2);
  check(
    "summary",
    JSON.stringify(resultA) === JSON.stringify(resultB),
    "the two devices read different summaries for one document and mode",
  );
  check("summary", mock.requests.length >= 1, "the hub asked the configured model endpoint nothing (F§9)");
  step(
    "summary",
    `device B asked for a brief summary (${asked.status} on request, done after ${finished.result.keyTakeaways.length} takeaways) and device A read the identical result — ${mock.requests.length} model call(s)`,
  );

  // 8 — the hub's backup downloads, and the archive names the payload its manifest describes.
  const backup = await deviceA.transport(new URL("/v1/admin/backup", BASE_URL), {
    method: "GET",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  check("backup", backup.ok, `/v1/admin/backup answered HTTP ${backup.status}`);
  check(
    "backup",
    backup.headers.get("content-type") === "application/gzip",
    `/v1/admin/backup answered ${backup.headers.get("content-type")} (F§7.2)`,
  );
  const archive = new Uint8Array(await backup.arrayBuffer());
  const plain = gunzipSync(Buffer.from(archive));
  const entries = tarEntries(plain);
  const members = [...entries.keys()];
  check("backup", archive.length > 0, "the backup archive is empty");
  check("backup", entries.has("manifest.json"), `the archive's members are ${members.join(", ")} and carry no manifest`);
  check("backup", entries.has("lectern.db"), `the archive carries no database snapshot (members: ${members.join(", ")})`);
  const manifest = JSON.parse(new TextDecoder().decode(entries.get("manifest.json")));
  const missing = manifest.files.filter((file) => !entries.has(file));
  check("backup", missing.length === 0, `the manifest names ${missing.join(", ")} and the archive does not hold it`);
  step(
    "backup",
    `the backup downloaded as one ${archive.length}-byte tar.gz holding ${members.length} member(s) — ${members.join(", ")} — and its manifest names ${manifest.files.length} payload file(s) at schema ${manifest.schemaVersion}`,
  );
} catch (error) {
  fail("run", error instanceof Error ? `${error.message}` : String(error));
} finally {
  for (const stop of cleanup.reverse()) {
    try {
      await stop();
    } catch {
      // A teardown that fails must not change what the run reported.
    }
  }
  await rm(hub.dataDir, { recursive: true, force: true }).catch(() => undefined);
}

process.stdout.write(`OK    cross-device verification complete — ${stepNumber} steps passed\n`);
