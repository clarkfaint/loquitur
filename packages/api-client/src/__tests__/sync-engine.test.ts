/**
 * U-058's contract (F§8.2, F§8.3): the sync client against a real hub app, and the engine that drives it —
 * two devices converging through the hub, a document's model uploaded before the op that names it, the lazy
 * download of a model whose record arrived without one, an outbox that survives a hub nobody can reach, a
 * replay after a lost answer that duplicates nothing, the feed's backoff ladder, the one follow-up round a
 * burst of requests is coalesced into, and the two things `stop()` cancels.
 *
 * The hub is the real one: U-055's repository over a real SQLite file under a temporary data directory,
 * reached through U-021's `fetchFromFastify`, so no socket is opened for it and every request is recorded.
 * The feed is an in-memory pair of F§8.3's frames rather than a WebSocket on a port: the socket is injected
 * (the contract's own `openSocket`), and a pair lets a case close the feed under the engine's feet and count
 * its reconnects without a listener.
 *
 * Reading and writing gzip needs `node:zlib`, so this file stays outside the package's type-check program
 * (its test directories are excluded): vitest erases types instead of checking them and runs it as written.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as tick } from "node:timers/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { MAX_PUSH_OPS, type WsServerMessage } from "@lectern/api-contract";
import {
  buildDocument,
  type Clock,
  createMemoryLibraryStore,
  type DocumentMeta,
  type DocumentModel,
  type LibraryStore,
  type Op,
} from "@lectern/core";
import { FakeClock } from "@lectern/core/testing";
import { buildApp, loadConfig } from "@lectern/server";
import { expect, test } from "vitest";
import { HubClientError } from "../errors";
import { createSyncClient, type SyncClient, type SyncGunzip, type SyncGzip } from "../sync-client";
import { createSyncEngine, type SyncEngine, type SyncFeedSocket, type SyncStatus } from "../sync-engine";
import { fetchFromFastify, type InjectAnswer, type InjectingApp, type InjectRequest } from "../testing/fastify-fetch";

/** F§7.1's token floor is 32 characters; this one clears it and appears nowhere else. */
const TOKEN = "lectern-sync-engine-token-0123456789";

/** The address the client is pointed at. The adapter routes on the path, so the host is only a name. */
const BASE_URL = "http://127.0.0.1:8787";

/** A valid document id no document in this file is built from, for the two not-found cases. */
const OTHER_DOC_ID = "0123456789abcdef0123456789abcdef";

/** F§7.2's codec pair, as a host that has `node:zlib` supplies it: the model's JSON in, the container out. */
const gzip: SyncGzip = async (text) => new Uint8Array(gzipSync(new TextEncoder().encode(text)));
const gunzip: SyncGunzip = async (bytes) => new TextDecoder().decode(gunzipSync(bytes));

/** A clock a case moves by hand, recording every delay anything asked it for. */
interface TestClock {
  clock: Clock;
  /** The delays requested, in order: the reconnect ladder is read from this list. */
  delays: number[];
  /** Move the timeline forward, firing whatever comes due (the store's stamps move with it). */
  advance(ms: number): void;
  /** Move the timeline to an instant, which is how a case stamps the writes it will compare. */
  at(instant: number): void;
}

function testClock(): TestClock {
  const inner = new FakeClock();
  const delays: number[] = [];
  return {
    delays,
    advance: (ms) => inner.advance(ms),
    at: (instant) => inner.advance(Math.max(0, instant - inner.now())),
    clock: {
      now: () => inner.now(),
      setTimeout: (callback, delayMs) => {
        delays.push(delayMs);
        return inner.setTimeout(callback, delayMs);
      },
      clearTimeout: (handle) => inner.clearTimeout(handle),
    },
  };
}

/** The delays that are the feed's reconnect ladder, without F§8.3's own five-minute pull clock. */
function reconnectDelays(delays: readonly number[]): number[] {
  return delays.filter((delay) => delay !== 300_000);
}

/** Let everything the engine has in flight settle: a few macrotask turns, which is plenty for `inject`. */
async function settle(turns = 6): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await tick(0);
}

/**
 * The hub as U-021's adapter sees it.
 *
 * `fetchFromFastify` builds a `Response` for every injected answer, and the `Response` constructor refuses a
 * body with a null-body status — which both of F§7.2's document-file `PUT`s answer with. An answer that
 * carries no body is therefore read as an empty `200`; a client acts on `ok` and never on the two codes'
 * difference, and the client under test here is no exception.
 */
function readableApp(app: InjectingApp): InjectingApp {
  return {
    inject: async (options: InjectRequest): Promise<InjectAnswer> => {
      const answer = await app.inject(options);
      if (answer.statusCode !== 204) return answer;
      return { statusCode: 200, headers: answer.headers, rawPayload: new Uint8Array() };
    },
  };
}

/** A hub app over a temporary data directory, and the transport a client is built over. */
interface Hub {
  /** Every request the client made, in order, as `METHOD /path`. */
  calls: string[];
  /** The transport: the hub's own `inject`, with each request recorded. */
  fetch: typeof fetch;
}

async function withHub(run: (hub: Hub) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "lectern-sync-engine-"));
  const config = loadConfig({ LECTERN_TOKEN: TOKEN, LECTERN_DATA_DIR: dataDir });
  const app = await buildApp(config);
  const calls: string[] = [];
  const adapter = fetchFromFastify(readableApp(app));
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof URL ? input.href : String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    return await adapter(input, init);
  };
  try {
    await run({ calls, fetch: transport });
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** A client over one hub's transport, or over a case's own wrapper around it. */
function clientFor(hub: Hub, transport?: typeof fetch): SyncClient {
  return createSyncClient({ baseUrl: BASE_URL, token: TOKEN, fetch: transport ?? hub.fetch, gzip, gunzip });
}

/** The failure a call raised, or a failure of this test when the call raised none. */
async function failureOf(call: () => Promise<unknown>): Promise<HubClientError> {
  try {
    await call();
  } catch (cause) {
    if (cause instanceof HubClientError) return cause;
    throw cause;
  }
  throw new Error("the call was expected to fail");
}

/** A memory store whose stamps come from the same fake clock the engine's timers run on. */
function makeStore(deviceId: string, time: TestClock): LibraryStore {
  let serial = 0;
  return createMemoryLibraryStore({
    deviceId,
    now: () => time.clock.now(),
    newId: () => {
      serial += 1;
      return `${deviceId}-op-${serial}`;
    },
  });
}

/** A device with an engine on it: its store, its own clock, and a round it can be asked to run. */
interface Device {
  store: LibraryStore;
  time: TestClock;
  engine: SyncEngine;
}

function makeDevice(deviceId: string, hub: Hub): Device {
  const time = testClock();
  const store = makeStore(deviceId, time);
  return { store, time, engine: createSyncEngine({ store, client: clientFor(hub), clock: time.clock }) };
}

/** One side of an in-memory feed pair: F§8.3's frames, delivered on the tick they are sent. */
interface Feed {
  socket: SyncFeedSocket;
  /** Every frame the engine sent. */
  sent: string[];
  /** Whether the engine closed its side. */
  closed(): boolean;
  /** One frame of raw text from the hub, however malformed. */
  frame(text: string): void;
  /** One well-formed message from the hub. */
  deliver(message: WsServerMessage): void;
  /** Drop the connection, as a hub that goes away does. */
  drop(): void;
}

function createFeed(): Feed {
  const sent: string[] = [];
  let receiveHandler: ((text: string) => void) | null = null;
  let closeHandler: (() => void) | null = null;
  let closed = false;
  const socket: SyncFeedSocket = {
    send: (text) => {
      sent.push(text);
    },
    close: () => {
      closed = true;
    },
    onMessage: (handler) => {
      receiveHandler = handler;
    },
    onClose: (handler) => {
      closeHandler = handler;
    },
  };
  return {
    socket,
    sent,
    closed: () => closed,
    frame: (text) => receiveHandler?.(text),
    deliver: (message) => receiveHandler?.(JSON.stringify(message)),
    drop: () => closeHandler?.(),
  };
}

/** A document built the way F§5.1–F§5.4 build one, so its own `docId` is the one F§5.2 computes. */
function builtDocument(text: string): DocumentModel {
  return buildDocument([{ kind: "paragraph", text }], { source: { kind: "txt" } });
}

/** F§5.9's metadata for one document, as the case's own clock will stamp it. */
function metaFor(model: DocumentModel, title: string): DocumentMeta {
  return {
    docId: model.docId,
    title,
    sourceKind: model.source.kind,
    folderId: null,
    addedAt: 0,
    wordCount: model.wordCount,
    sentenceCount: model.sentenceCount,
    updatedAt: 0,
    deleted: false,
  };
}

/** F§5.9's document metadata for one id — the record an op carries, without its model. */
function documentRecord(docId: string, ts: number): DocumentMeta {
  return {
    docId,
    title: "A stored document",
    sourceKind: "txt",
    folderId: null,
    addedAt: ts,
    wordCount: 5,
    sentenceCount: 1,
    updatedAt: ts,
    deleted: false,
  };
}

/** One op of the `setting` entity, stamped by the device that made it (F§5.9). */
function settingOp(opId: string, deviceId: string, key: string, value: unknown, ts: number): Op {
  return { opId, deviceId, entity: "setting", entityId: key, kind: "put", ts, record: { key, value, updatedAt: ts, deleted: false } };
}

/** One op that writes a document's metadata, and never its body (F§5.9, F§8.2). */
function documentOp(opId: string, deviceId: string, docId: string, ts: number): Op {
  return { opId, deviceId, entity: "document", entityId: docId, kind: "put", ts, record: documentRecord(docId, ts) };
}

/** The pulls among the recorded requests. */
function pulls(hub: Hub): number {
  return hub.calls.filter((call) => call === "GET /v1/sync/pull").length;
}

/** Documents in an order that cannot depend on how a `Map` was filled. */
function byDocId(metas: readonly DocumentMeta[]): DocumentMeta[] {
  return [...metas].sort((left, right) => left.docId.localeCompare(right.docId));
}

test("the sync routes round-trip through the client: a push, a pull, a model and an original", async () => {
  await withHub(async (hub) => {
    const client = clientFor(hub);
    const model = builtDocument("The lamp burned driftwood on the shore.");
    const ops = [settingOp("op-1", "device-a", "theme", "sepia", 100), documentOp("op-2", "device-a", model.docId, 200)];

    expect(await client.push("device-a", ops)).toEqual({ accepted: ["op-1", "op-2"], rev: 2 });

    const page = await client.pull(0);
    expect(page.changes.map((change) => change.entityId)).toEqual(["theme", model.docId]);
    expect(page.nextRev).toBe(2);
    expect(page.more).toBe(false);
    expect((await client.pull(page.nextRev)).changes).toEqual([]);

    // A model travels gzipped and comes back as F§5.1's document; one the hub was never sent is null.
    await client.putModel(model.docId, model);
    expect(await client.getModel(model.docId)).toEqual(model);
    expect(await client.getModel(OTHER_DOC_ID)).toBeNull();

    const original = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    await client.putOriginal(model.docId, original, "application/pdf");
    const served = await client.getOriginal(model.docId);
    expect(served?.mime).toContain("application/pdf");
    expect([...(served?.bytes ?? [])]).toEqual([...original]);
    expect(await client.getOriginal(OTHER_DOC_ID)).toBeNull();
  });
});

test("the client refuses an oversized push before it leaves, and reports an exchange that failed", async () => {
  await withHub(async (hub) => {
    const client = clientFor(hub);
    const many = Array.from({ length: MAX_PUSH_OPS + 1 }, (_, index) =>
      settingOp(`op-${index}`, "device-a", `key-${index}`, index, 100 + index),
    );
    const refused = await failureOf(async () => await client.push("device-a", many));
    expect(refused.code).toBe("BAD_REQUEST");
    expect(refused.status).toBe(0);
    expect(refused.offline).toBe(false);
    expect(hub.calls).toEqual([]);

    const down = clientFor(hub, async () => {
      throw new TypeError("the hub is unreachable");
    });
    const unreachable = await failureOf(async () => await down.pull(0));
    expect(unreachable.code).toBe("ENGINE_UNAVAILABLE");
    expect(unreachable.offline).toBe(true);
    expect(unreachable.status).toBe(0);

    const junk = clientFor(hub, async () => new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }));
    const drifted = await failureOf(async () => await junk.pull(0));
    expect(drifted.code).toBe("INTERNAL");
    expect(drifted.status).toBe(200);
    expect(drifted.offline).toBe(false);
  });
});

test("a document's model is uploaded before the op that names it is pushed", async () => {
  await withHub(async (hub) => {
    const device = makeDevice("device-a", hub);
    const model = builtDocument("A kettle sang on the iron stove.");
    device.time.at(100);
    await device.store.putDocument(metaFor(model, "A's page"), model);

    await device.engine.syncNow();

    const upload = `PUT /v1/library/documents/${model.docId}/model`;
    expect(hub.calls.filter((call) => call.startsWith("PUT /v1/library/"))).toEqual([upload]);
    expect(hub.calls.indexOf(upload)).toBeLessThan(hub.calls.indexOf("POST /v1/sync/push"));
    // The hub really holds the body, and the outbox really let it go.
    expect(await clientFor(hub).getModel(model.docId)).toEqual(model);
    expect(await device.store.pendingOps(MAX_PUSH_OPS)).toEqual([]);
    expect(await device.store.getCursor()).toBe(1);
  });
});

test("two devices exchanging rounds converge on identical records", async () => {
  await withHub(async (hub) => {
    const a = makeDevice("device-a", hub);
    const b = makeDevice("device-b", hub);
    const first = builtDocument("The lamp burned driftwood on the shore.");
    const second = builtDocument("A kettle sang on the iron stove.");

    // Non-conflicting: each device writes something the other has never seen.
    a.time.at(100);
    await a.store.putDocument(metaFor(first, "A's first page"), first);
    await a.store.putFolder({ id: "folder-1", name: "Reading", parentId: null, updatedAt: 0, deleted: false });
    b.time.at(150);
    await b.store.putDocument(metaFor(second, "B's second page"), second);
    await b.store.setProgress({ docId: second.docId, sentenceIndex: 2, wordIndex: 0, updatedAt: 0 });

    // Conflicting: one folder renamed at two instants, and one setting written by both at the same instant —
    // which F§5.9 sends to the greater device id.
    a.time.at(200);
    await a.store.putFolder({ id: "folder-1", name: "A's shelf", parentId: null, updatedAt: 0, deleted: false });
    b.time.at(220);
    await b.store.putFolder({ id: "folder-1", name: "B's shelf", parentId: null, updatedAt: 0, deleted: false });
    a.time.at(300);
    await a.store.setSetting("theme", "A's theme");
    b.time.at(300);
    await b.store.setSetting("theme", "B's theme");

    for (let round = 0; round < 4; round += 1) {
      await a.engine.syncNow();
      await b.engine.syncNow();
    }

    // Neither device has anything left to send.
    expect(await a.store.pendingOps(MAX_PUSH_OPS)).toEqual([]);
    expect(await b.store.pendingOps(MAX_PUSH_OPS)).toEqual([]);

    // Each rule of F§5.9 decided the way the contract says, on both sides.
    for (const device of [a, b]) {
      expect((await device.store.listDocuments()).map((meta) => meta.title).sort()).toEqual(["A's first page", "B's second page"]);
      expect((await device.store.listFolders()).map((folder) => folder.name)).toEqual(["B's shelf"]);
      expect((await device.store.getProgress(second.docId))?.sentenceIndex).toBe(2);
      expect(await device.store.getSetting("theme")).toBe("B's theme");
    }

    // And the two libraries are the same library.
    expect(byDocId(await b.store.listDocuments())).toEqual(byDocId(await a.store.listDocuments()));
    expect(await b.store.listFolders()).toEqual(await a.store.listFolders());
    expect(await b.store.getProgress(second.docId)).toEqual(await a.store.getProgress(second.docId));

    // F§8.2 keeps bodies off the feed: neither device holds the other's model until one is asked for.
    expect(await a.store.getDocumentModel(second.docId)).toBeNull();
    expect(await b.store.getDocumentModel(first.docId)).toBeNull();
  });
});

test("a document whose record arrives without its model is fetched by ensureModel", async () => {
  await withHub(async (hub) => {
    const a = makeDevice("device-a", hub);
    const b = makeDevice("device-b", hub);
    const model = builtDocument("The map stayed folded in the drawer.");
    a.time.at(100);
    await a.store.putDocument(metaFor(model, "A's page"), model);
    await a.engine.syncNow();

    await b.engine.syncNow();
    expect((await b.store.getDocumentMeta(model.docId))?.title).toBe("A's page");
    // F§8.2 keeps a body off the feed: the record arrived, the bytes did not.
    expect(await b.store.getDocumentModel(model.docId)).toBeNull();

    expect(await b.engine.ensureModel(model.docId)).toEqual(model);
    expect(await b.store.getDocumentModel(model.docId)).toEqual(model);
    expect(await b.engine.ensureModel(OTHER_DOC_ID)).toBeNull();
  });
});

test("a hub nobody can reach leaves the outbox intact and the state offline, and the ops flush when it answers", async () => {
  await withHub(async (hub) => {
    const time = testClock();
    const store = makeStore("device-a", time);
    let reachable = false;
    const transport: typeof fetch = async (input, init) => {
      if (!reachable) throw new TypeError("the hub is unreachable");
      return await hub.fetch(input, init);
    };
    const engine = createSyncEngine({ store, client: clientFor(hub, transport), clock: time.clock });
    await store.setSetting("theme", "sepia");

    await engine.syncNow();
    expect(await engine.status()).toEqual({ state: "offline", lastSyncedAt: null, pending: 1 });
    expect(await store.pendingOps(MAX_PUSH_OPS)).toHaveLength(1);
    // Nothing was acknowledged and nothing was applied, so the cursor never moved.
    expect(await store.getCursor()).toBe(0);

    reachable = true;
    await engine.syncNow();
    expect(await engine.status()).toEqual({ state: "idle", lastSyncedAt: time.clock.now(), pending: 0 });
    expect(await store.pendingOps(MAX_PUSH_OPS)).toEqual([]);
    expect((await clientFor(hub).pull(0)).changes.map((change) => change.entityId)).toEqual(["theme"]);
  });
});

test("a device that reports itself offline makes no request at all", async () => {
  await withHub(async (hub) => {
    const time = testClock();
    const store = makeStore("device-a", time);
    let online = false;
    const engine = createSyncEngine({ store, client: clientFor(hub), clock: time.clock, isOnline: () => online });
    await store.setSetting("theme", "sepia");

    await engine.syncNow();
    expect(hub.calls).toEqual([]);
    expect((await engine.status()).state).toBe("offline");
    expect(await store.pendingOps(MAX_PUSH_OPS)).toHaveLength(1);

    online = true;
    await engine.syncNow();
    expect((await engine.status()).state).toBe("idle");
    expect(hub.calls.filter((call) => call === "POST /v1/sync/push")).toHaveLength(1);
  });
});

test("a replay after a lost push answer duplicates nothing", async () => {
  await withHub(async (hub) => {
    const time = testClock();
    const store = makeStore("device-a", time);
    let loseNextAnswer = true;
    const transport: typeof fetch = async (input, init) => {
      const answer = await hub.fetch(input, init);
      if (loseNextAnswer) {
        loseNextAnswer = false;
        throw new TypeError("the answer never arrived");
      }
      return answer;
    };
    const engine = createSyncEngine({ store, client: clientFor(hub, transport), clock: time.clock });
    await store.setSetting("theme", "sepia");

    await engine.syncNow();
    // The hub committed the op and the client never saw the answer.
    expect((await clientFor(hub).pull(0)).nextRev).toBe(1);
    expect(await store.pendingOps(MAX_PUSH_OPS)).toHaveLength(1);
    expect((await engine.status()).state).toBe("offline");

    await engine.syncNow();
    expect(await store.pendingOps(MAX_PUSH_OPS)).toEqual([]);
    // F§8.2's op ledger makes the replay a no-op: one change, at the rev the first push left the log at.
    const page = await clientFor(hub).pull(0);
    expect(page.changes.map((change) => change.entityId)).toEqual(["theme"]);
    expect(page.nextRev).toBe(1);
    expect(await store.getSetting("theme")).toBe("sepia");
  });
});

test("the feed reconnects with exponential backoff from 1 s to 60 s", async () => {
  await withHub(async (hub) => {
    const time = testClock();
    const store = makeStore("device-a", time);
    let attempts = 0;
    const engine = createSyncEngine({
      store,
      client: clientFor(hub),
      clock: time.clock,
      openSocket: () => {
        attempts += 1;
        throw new Error("the feed is not reachable");
      },
    });

    await engine.start();
    // Each step moves the timeline by the wait the ladder just asked for, so exactly one attempt lands per
    // step and the recorded ladder is read rung by rung rather than inferred from one long jump.
    for (const wait of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000]) {
      time.advance(wait);
      await settle();
    }

    expect(attempts).toBe(8);
    expect(reconnectDelays(time.delays)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
    engine.stop();
  });
});

test("a burst of requests while a round is running becomes exactly one follow-up round", async () => {
  await withHub(async (hub) => {
    const time = testClock();
    const store = makeStore("device-a", time);
    let open = false;
    const held: Array<() => void> = [];
    const transport: typeof fetch = async (input, init) => {
      if (!open) await new Promise<void>((resolve) => held.push(resolve));
      return await hub.fetch(input, init);
    };
    const engine = createSyncEngine({ store, client: clientFor(hub, transport), clock: time.clock });
    await store.setSetting("theme", "sepia");

    const first = engine.syncNow();
    await settle();
    // A second local record, written after the round's push went out, and two more requests for a round.
    await store.setSetting("fontSize", 18);
    const second = engine.syncNow();
    const third = engine.syncNow();
    open = true;
    for (const resolve of held) resolve();
    await Promise.all([first, second, third]);
    await settle();

    // Two rounds, and no third: the requests that arrived mid-round are the one follow-up it ran.
    expect(hub.calls.filter((call) => call === "POST /v1/sync/push")).toHaveLength(2);
    expect(pulls(hub)).toBe(2);
    expect(await store.pendingOps(MAX_PUSH_OPS)).toEqual([]);
  });
});

test("the feed pulls on changed, answers ping, ignores a frame that is not F§8.3's, and stop() ends it", async () => {
  await withHub(async (hub) => {
    const time = testClock();
    const store = makeStore("device-a", time);
    const feed = createFeed();
    const engine = createSyncEngine({ store, client: clientFor(hub), clock: time.clock, openSocket: () => feed.socket });

    await engine.start();
    expect(pulls(hub)).toBe(1);

    feed.deliver({ type: "ping" });
    expect(feed.sent).toEqual([JSON.stringify({ type: "pong" })]);
    feed.frame("not json at all");
    feed.frame(JSON.stringify({ type: "nonsense" }));
    feed.deliver({ type: "ready", rev: 0 });
    feed.deliver({ type: "changed", rev: 1 });
    await settle();
    expect(pulls(hub)).toBe(2);

    engine.notifyLocalChange();
    const before = hub.calls.length;
    engine.stop();
    expect(feed.closed()).toBe(true);
    time.advance(600_000);
    await settle();
    expect(hub.calls.length).toBe(before);
    // A stopped engine runs no round even when it is asked for one.
    await engine.syncNow();
    expect(hub.calls.length).toBe(before);
  });
});

test("a feed that answers ready starts the reconnect ladder over", async () => {
  await withHub(async (hub) => {
    const time = testClock();
    const store = makeStore("device-a", time);
    const feeds: Feed[] = [];
    let attempt = 0;
    const engine = createSyncEngine({
      store,
      client: clientFor(hub),
      clock: time.clock,
      openSocket: () => {
        attempt += 1;
        if (attempt === 1) throw new Error("the feed is not answering yet");
        const feed = createFeed();
        feeds.push(feed);
        return feed.socket;
      },
    });

    await engine.start();
    expect(reconnectDelays(time.delays)).toEqual([1_000]);
    time.advance(1_000);
    await settle();
    expect(feeds).toHaveLength(1);

    const feed = feeds[0];
    feed?.deliver({ type: "ready", rev: 0 });
    feed?.drop();
    // The ladder's first rung again, not its second: the authenticated feed reset the count.
    expect(reconnectDelays(time.delays)).toEqual([1_000, 1_000]);
    engine.stop();
  });
});

test("a local change rounds after two seconds, and the engine pulls on its own every five minutes", async () => {
  await withHub(async (hub) => {
    const time = testClock();
    const store = makeStore("device-a", time);
    const engine = createSyncEngine({ store, client: clientFor(hub), clock: time.clock });

    // A round on `start`, with an empty outbox: nothing to push, and the pull still runs.
    await engine.start();
    expect(pulls(hub)).toBe(1);
    expect(hub.calls).not.toContain("POST /v1/sync/push");

    engine.notifyLocalChange();
    engine.notifyLocalChange();
    time.advance(1_999);
    await settle();
    expect(pulls(hub)).toBe(1);
    time.advance(1);
    await settle();
    expect(pulls(hub)).toBe(2);

    time.advance(300_000);
    await settle();
    expect(pulls(hub)).toBe(3);
    expect(await engine.status()).toEqual({ state: "idle", lastSyncedAt: time.clock.now(), pending: 0 });
    engine.stop();
  });
});

test("the status listener is told every state the engine passes through", async () => {
  await withHub(async (hub) => {
    const time = testClock();
    const store = makeStore("device-a", time);
    const seen: SyncStatus[] = [];
    const engine = createSyncEngine({
      store,
      client: clientFor(hub),
      clock: time.clock,
      onStatus: (status) => {
        seen.push(status);
      },
    });
    await store.setSetting("theme", "sepia");

    await engine.syncNow();
    await settle();

    expect(seen.map((status) => status.state)).toEqual(["syncing", "idle"]);
    expect(seen[1]).toEqual({ state: "idle", lastSyncedAt: time.clock.now(), pending: 0 });
  });
});
