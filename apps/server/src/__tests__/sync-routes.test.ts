/**
 * Phase 5's library and sync routes (U-056) end to end through `inject`: a document's gzipped model and its
 * original, the refusals both route modules name, and the property the sync routes exist for — that two
 * databases which exchange their ops through the hub hold the same records afterwards.
 *
 * The hub is the real one: U-055's record repository over a real SQLite file and its document files under a
 * temporary data directory. The convergence case is the one that matters, so it is written as the client
 * would behave: two `MemoryLibraryStore`s with different device identities make conflicting and
 * non-conflicting edits, run push-then-pull rounds through the routes until neither has anything left to
 * send, and are then compared record kind by record kind. Every stamp is supplied by the case's own clock,
 * so the expected winner is arithmetic rather than a wall-clock race.
 *
 * Reading and writing gzip needs `node:zlib`, so this file stays outside the package's type-check program
 * (its test directories are excluded): vitest erases types instead of checking them and runs it as written.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  ErrorBodySchema,
  MAX_PULL_LIMIT,
  MAX_PUSH_OPS,
  type PullResponse,
  PullResponseSchema,
  type PushResponse,
  PushResponseSchema,
  SyncErrorSchema,
} from "@lectern/api-contract";
import {
  buildDocument,
  createMemoryLibraryStore,
  type DocumentMeta,
  type DocumentModel,
  DocumentModelSchema,
  type LibraryStore,
  type Op,
} from "@lectern/core";
import type { FastifyInstance, InjectOptions } from "fastify";
import { expect, test } from "vitest";
import { z } from "zod";
import { buildApp } from "../app";
import { loadConfig } from "../config";

/** F§7.1's token floor is 32 characters; this one clears it and appears nowhere else. */
const TOKEN = "lectern-hub-test-token-0123456789";

const AUTHORIZATION = { authorization: `Bearer ${TOKEN}` };
const JSON_HEADERS = { ...AUTHORIZATION, "content-type": "application/json" };

/** A valid document id that no model in this file is built from, for the mismatch and not-found cases. */
const OTHER_DOC_ID = "0123456789abcdef0123456789abcdef";

/** F§7.2's error envelope with U-054's sync code set allowed beside the shared one. */
const ErrorEnvelopeSchema = z.strictObject({ error: z.union([ErrorBodySchema.shape.error, SyncErrorSchema]) });

interface Hub {
  app: FastifyInstance;
  dataDir: string;
}

/**
 * Build the hub over a temporary data directory, then close it and remove the directory.
 *
 * F§7.1's upload limit is one megabyte so the size case is exercised with a small body; the library routes
 * read under the smaller of that limit and U-054's ceiling, so a body past it is refused while it streams.
 */
async function withHub(run: (hub: Hub) => Promise<void>, env: Readonly<Record<string, string>> = {}): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "lectern-sync-"));
  const config = loadConfig({ LECTERN_TOKEN: TOKEN, LECTERN_DATA_DIR: dataDir, LECTERN_MAX_UPLOAD_MB: "1", ...env });
  const app = await buildApp(config);
  try {
    await run({ app, dataDir });
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** A document built the way F§5.1–F§5.4 build one, so its own `docId` is the one F§5.2 computes. */
function builtDocument(text: string): DocumentModel {
  return buildDocument([{ kind: "paragraph", text }], { source: { kind: "txt" } });
}

/** A model as F§7.2's upload carries it: the `DocumentModel` JSON, gzipped. */
function gzipped(model: DocumentModel): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(model)));
}

/** The status and code of a refusal, read through F§7.2's envelope. */
async function refusal(app: FastifyInstance, request: InjectOptions): Promise<{ status: number; code: string; message: string }> {
  const response = await app.inject(request);
  const body = ErrorEnvelopeSchema.parse(response.json() as unknown);
  return { status: response.statusCode, code: body.error.code, message: body.error.message };
}

const putModel = (docId: string, payload: Uint8Array) => ({
  method: "PUT" as const,
  url: `/v1/library/documents/${docId}/model`,
  headers: { ...AUTHORIZATION, "content-type": "application/gzip" },
  payload,
});

const getModel = (docId: string) => ({ method: "GET" as const, url: `/v1/library/documents/${docId}/model`, headers: AUTHORIZATION });

const putOriginal = (docId: string, payload: Uint8Array, mime: string) => ({
  method: "PUT" as const,
  url: `/v1/library/documents/${docId}/original`,
  headers: { ...AUTHORIZATION, "content-type": mime },
  payload,
});

const getOriginal = (docId: string) => ({ method: "GET" as const, url: `/v1/library/documents/${docId}/original`, headers: AUTHORIZATION });

/** F§5.9's document metadata for one id — the record an op carries, without its model. */
function documentRecord(docId: string, ts: number, deleted = false): DocumentMeta {
  return {
    docId,
    title: "A stored document",
    sourceKind: "txt",
    folderId: null,
    addedAt: ts,
    wordCount: 5,
    sentenceCount: 1,
    updatedAt: ts,
    deleted,
  };
}

/** One op of the `setting` entity, stamped by the device that made it (F§5.9). */
function settingPut(opId: string, deviceId: string, key: string, value: unknown, ts: number): Op {
  return { opId, deviceId, entity: "setting", entityId: key, kind: "put", ts, record: { key, value, updatedAt: ts, deleted: false } };
}

/** One op that writes a document's metadata (F§5.9). */
function documentPut(opId: string, deviceId: string, docId: string, ts: number): Op {
  return { opId, deviceId, entity: "document", entityId: docId, kind: "put", ts, record: documentRecord(docId, ts) };
}

/** One op that leaves a document's tombstone, which is what deletes a document's files (F§8.2). */
function documentDelete(opId: string, deviceId: string, docId: string, ts: number): Op {
  return {
    opId,
    deviceId,
    entity: "document",
    entityId: docId,
    kind: "delete",
    ts,
    record: { ...documentRecord(docId, ts), deleted: true },
  };
}

/** One push, through the route, with its answer validated by the contract's own schema. */
async function pushOps(app: FastifyInstance, deviceId: string, ops: readonly Op[]): Promise<PushResponse> {
  const response = await app.inject({ method: "POST", url: "/v1/sync/push", headers: JSON_HEADERS, payload: { deviceId, ops } });
  expect(response.statusCode).toBe(200);
  return PushResponseSchema.parse(response.json() as unknown);
}

/** One pull, through the route, with its answer validated by the contract's own schema. */
async function pullPage(app: FastifyInstance, since: number, limit?: number): Promise<PullResponse> {
  const url = limit === undefined ? `/v1/sync/pull?since=${since}` : `/v1/sync/pull?since=${since}&limit=${limit}`;
  const response = await app.inject({ method: "GET", url, headers: AUTHORIZATION });
  expect(response.statusCode).toBe(200);
  return PullResponseSchema.parse(response.json() as unknown);
}

test("a model and an original round-trip byte for byte, and anything the hub was never sent is NOT_FOUND", async () => {
  await withHub(async ({ app }) => {
    const model = builtDocument("The lamp burned driftwood on the shore.");
    const body = gzipped(model);

    const stored = await app.inject(putModel(model.docId, body));
    expect(stored.statusCode).toBe(204);

    const fetched = await app.inject(getModel(model.docId));
    expect(fetched.statusCode).toBe(200);
    expect(fetched.headers["content-type"]).toContain("application/gzip");
    // The bytes are the ones that were uploaded: the hub stores a model, it never re-encodes one.
    expect(Buffer.compare(fetched.rawPayload, body)).toBe(0);
    expect(DocumentModelSchema.parse(JSON.parse(gunzipSync(fetched.rawPayload).toString("utf8")) as unknown)).toEqual(model);

    const original = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    expect((await app.inject(putOriginal(model.docId, original, "application/pdf"))).statusCode).toBe(204);
    const served = await app.inject(getOriginal(model.docId));
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toContain("application/pdf");
    expect(Buffer.compare(served.rawPayload, original)).toBe(0);

    const noModel = await refusal(app, getModel(OTHER_DOC_ID));
    expect(noModel.status).toBe(404);
    expect(noModel.code).toBe("NOT_FOUND");
    expect((await refusal(app, getOriginal(OTHER_DOC_ID))).status).toBe(404);
  });
});

test("a model that describes another document is refused with 400 and filed nowhere", async () => {
  await withHub(async ({ app }) => {
    const model = builtDocument("The map stayed folded in the drawer.");
    expect(model.docId).not.toBe(OTHER_DOC_ID);

    const refused = await refusal(app, putModel(OTHER_DOC_ID, gzipped(model)));
    expect(refused.status).toBe(400);
    expect(refused.code).toBe("BAD_REQUEST");
    expect(refused.message).toContain(model.docId);

    // Nothing was written on the way: the path the body was sent to holds no model.
    expect((await refusal(app, getModel(OTHER_DOC_ID))).status).toBe(404);
  });
});

test("a body that is not gzip, and a path that is not a document id, are each refused with 400", async () => {
  await withHub(async ({ app }) => {
    const model = builtDocument("A kettle sang on the iron stove.");
    const plain = await refusal(app, putModel(model.docId, Buffer.from(JSON.stringify(model))));
    expect(plain.status).toBe(400);
    expect(plain.code).toBe("BAD_REQUEST");

    for (const bad of ["not-a-document-id", OTHER_DOC_ID.toUpperCase(), OTHER_DOC_ID.slice(1)]) {
      const refused = await refusal(app, getModel(bad));
      expect(refused.status).toBe(400);
      expect(refused.code).toBe("BAD_REQUEST");
    }
  });
});

test("an upload past the hub's ceiling is refused with 413 while it streams", async () => {
  await withHub(async ({ app }) => {
    const model = builtDocument("The map stayed folded in the drawer.");
    const refused = await refusal(app, putModel(model.docId, Buffer.alloc(1_200_000)));
    expect(refused.status).toBe(413);
    expect(refused.code).toBe("PAYLOAD_TOO_LARGE");
  });
});

test("a push answers with what it accepted, and a pull from that rev is empty", async () => {
  await withHub(async ({ app }) => {
    const op = settingPut("op-1", "device-a", "theme", "sepia", 100);
    expect(await pushOps(app, "device-a", [op])).toEqual({ accepted: ["op-1"], rev: 1 });

    const first = await pullPage(app, 0);
    expect(first.changes.map((change) => change.entityId)).toEqual(["theme"]);
    expect(first.changes[0]?.record).toEqual({ key: "theme", value: "sepia", updatedAt: 100, deleted: false });
    expect(first.nextRev).toBe(1);
    expect(first.more).toBe(false);

    expect(await pullPage(app, first.nextRev)).toEqual({ changes: [], nextRev: 1, more: false });
  });
});

test("a pull pages with more until the change log is exhausted", async () => {
  await withHub(async ({ app }) => {
    const ops = ["alpha", "beta", "gamma", "delta"].map((key, index) => settingPut(`op-${index}`, "device-a", key, index, 100 + index));
    expect((await pushOps(app, "device-a", ops)).rev).toBe(4);

    const first = await pullPage(app, 0, 2);
    expect(first.changes.map((change) => change.entityId)).toEqual(["alpha", "beta"]);
    expect(first.nextRev).toBe(2);
    expect(first.more).toBe(true);

    const second = await pullPage(app, first.nextRev, 2);
    expect(second.changes.map((change) => change.entityId)).toEqual(["gamma", "delta"]);
    expect(second.nextRev).toBe(4);
    expect(second.more).toBe(false);

    // The default page size is F§8.2's 500, and the last page is still the whole remainder.
    expect((await pullPage(app, first.nextRev, MAX_PULL_LIMIT)).changes.length).toBe(2);
  });
});

test("a push over the op ceiling is refused TOO_MANY_OPS and stores nothing", async () => {
  await withHub(async ({ app }) => {
    const ops = Array.from({ length: MAX_PUSH_OPS + 1 }, (_, index) =>
      settingPut(`op-${index}`, "device-a", `key-${index}`, index, 100 + index),
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/sync/push",
      headers: JSON_HEADERS,
      payload: { deviceId: "device-a", ops },
    });
    expect(response.statusCode).toBe(400);
    expect(ErrorEnvelopeSchema.parse(response.json() as unknown).error.code).toBe("TOO_MANY_OPS");
    expect(await pullPage(app, 0)).toEqual({ changes: [], nextRev: 0, more: false });

    // Exactly the ceiling is accepted, and its answer names every op.
    const atMost = ops.slice(0, MAX_PUSH_OPS);
    const accepted = await pushOps(app, "device-a", atMost);
    expect(accepted.accepted).toEqual(atMost.map((op) => op.opId));
    expect(accepted.rev).toBe(MAX_PUSH_OPS);
  });
});

test("a document record whose model was never uploaded is stored, and the model may arrive later", async () => {
  await withHub(async ({ app }) => {
    const model = builtDocument("A kettle sang on the iron stove.");
    expect(await pushOps(app, "device-b", [documentPut("op-1", "device-b", model.docId, 150)])).toEqual({ accepted: ["op-1"], rev: 1 });

    const page = await pullPage(app, 0);
    expect(page.changes.map((change) => [change.entity, change.entityId])).toEqual([["document", model.docId]]);
    expect((page.changes[0]?.record as DocumentMeta | undefined)?.title).toBe("A stored document");

    // The body travels on its own route (F§8.2), so the record stands while the model is absent.
    expect((await refusal(app, getModel(model.docId))).status).toBe(404);
    expect((await app.inject(putModel(model.docId, gzipped(model)))).statusCode).toBe(204);
    expect((await app.inject(getModel(model.docId))).statusCode).toBe(200);
  });
});

test("a document's files are removed only when its delete wins the LWW rule", async () => {
  await withHub(async ({ app }) => {
    const model = builtDocument("The lamp burned driftwood on the shore.");
    const docId = model.docId;
    const original = Buffer.from([0x25, 0x50, 0x44, 0x46]);
    expect((await app.inject(putModel(docId, gzipped(model)))).statusCode).toBe(204);
    expect((await app.inject(putOriginal(docId, original, "application/pdf"))).statusCode).toBe(204);

    // A record the hub holds, then a delete older than it: accepted, committed nowhere, files intact.
    expect(await pushOps(app, "device-a", [documentPut("op-put", "device-a", docId, 200)])).toEqual({ accepted: ["op-put"], rev: 1 });
    expect(await pushOps(app, "device-a", [documentDelete("op-old", "device-a", docId, 100)])).toEqual({ accepted: ["op-old"], rev: 1 });
    expect((await app.inject(getModel(docId))).statusCode).toBe(200);
    expect((await app.inject(getOriginal(docId))).statusCode).toBe(200);

    // A delete newer than the record wins, and the document's files go with it.
    expect(await pushOps(app, "device-a", [documentDelete("op-new", "device-a", docId, 300)])).toEqual({ accepted: ["op-new"], rev: 2 });
    expect((await refusal(app, getModel(docId))).status).toBe(404);
    expect((await refusal(app, getOriginal(docId))).status).toBe(404);
  });
});

/** A device: a store, its identity, and a clock the case moves by hand so every stamp is arithmetic. */
interface Device {
  deviceId: string;
  store: LibraryStore;
  clock: { set: (value: number) => void };
}

function makeDevice(deviceId: string): Device {
  let now = 0;
  let serial = 0;
  const nextId = (): string => {
    serial += 1;
    return `${deviceId}-op-${serial}`;
  };
  return {
    deviceId,
    store: createMemoryLibraryStore({ deviceId, now: () => now, newId: nextId }),
    clock: {
      set: (value: number) => {
        now = value;
      },
    },
  };
}

/** Push everything a device's outbox holds, acknowledging what the hub accepted (F§8.2). */
async function pushOutbox(app: FastifyInstance, device: Device): Promise<boolean> {
  let moved = false;
  for (;;) {
    const ops = await device.store.pendingOps(MAX_PUSH_OPS);
    if (ops.length === 0) return moved;
    const answer = await pushOps(app, device.deviceId, ops);
    await device.store.ackOps(answer.accepted);
    moved = true;
  }
}

/** Pull every page a device is behind by, applying each and storing its cursor (F§8.2). */
async function pullBehind(app: FastifyInstance, device: Device): Promise<boolean> {
  let moved = false;
  let since = await device.store.getCursor();
  for (;;) {
    const page = await pullPage(app, since);
    if (page.changes.length > 0) moved = true;
    await device.store.applyRemote(page.changes);
    await device.store.setCursor(page.nextRev);
    since = page.nextRev;
    if (!page.more) return moved;
  }
}

/** One push-then-pull round for each device; answers whether anything travelled. */
async function exchange(app: FastifyInstance, devices: readonly Device[]): Promise<boolean> {
  let moved = false;
  for (const device of devices) {
    if (await pushOutbox(app, device)) moved = true;
    if (await pullBehind(app, device)) moved = true;
  }
  return moved;
}

/** Rounds until no device has anything left to send or receive. */
async function settle(app: FastifyInstance, devices: readonly Device[]): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    if (!(await exchange(app, devices))) return;
  }
  throw new Error("the two devices never stopped exchanging changes");
}

/** F§5.9's metadata for one document, as the case's own clock will stamp it. */
function metaFor(model: DocumentModel, title: string, ts: number, deleted = false): DocumentMeta {
  return {
    docId: model.docId,
    title,
    sourceKind: model.source.kind,
    folderId: null,
    addedAt: ts,
    wordCount: model.wordCount,
    sentenceCount: model.sentenceCount,
    updatedAt: ts,
    deleted,
  };
}

/** Everything the two stores must agree on, in an order that cannot depend on how a `Map` was filled. */
async function recordsOf(store: LibraryStore, docIds: readonly string[], bookmarkDocId: string, settingKeys: readonly string[]) {
  const byId = (left: { id: string }, right: { id: string }): number => left.id.localeCompare(right.id);
  return {
    documents: (await store.listDocuments()).map((meta) => ({ ...meta })).sort((left, right) => left.docId.localeCompare(right.docId)),
    folders: (await store.listFolders()).map((folder) => ({ ...folder })).sort(byId),
    bookmarks: (await store.listBookmarks(bookmarkDocId)).map((bookmark) => ({ ...bookmark })).sort(byId),
    progress: await Promise.all(docIds.map(async (docId) => await store.getProgress(docId))),
    settings: await Promise.all(settingKeys.map(async (key) => await store.getSetting(key))),
  };
}

test("two devices making conflicting and non-conflicting edits converge on identical records", async () => {
  await withHub(async ({ app }) => {
    const deviceA = makeDevice("device-a");
    const deviceB = makeDevice("device-b");
    const devices = [deviceA, deviceB];
    const first = builtDocument("The lamp burned driftwood on the shore.");
    const second = builtDocument("A kettle sang on the iron stove.");

    // Non-conflicting: each device writes things the other has never seen.
    deviceA.clock.set(100);
    await deviceA.store.putDocument(metaFor(first, "A's first page", 100), first);
    await deviceA.store.putFolder({ id: "folder-1", name: "Reading", parentId: null, updatedAt: 0, deleted: false });
    await deviceA.store.setProgress({ docId: first.docId, sentenceIndex: 1, wordIndex: 0, updatedAt: 0 });

    deviceB.clock.set(150);
    await deviceB.store.putDocument(metaFor(second, "B's second page", 150), second);
    await deviceB.store.putBookmark({
      id: "bookmark-1",
      docId: second.docId,
      sentenceIndex: 0,
      wordIndex: 0,
      note: "B's note",
      createdAt: 0,
      updatedAt: 0,
      deleted: false,
    });
    await deviceB.store.setSetting("theme", "dark");

    await settle(app, devices);

    // Conflicting: the same entities, written from both sides at stamps the case chooses.
    // The same document at the same instant — the greater device id wins (F§5.9).
    deviceA.clock.set(200);
    await deviceA.store.putDocument(metaFor(first, "A's later title", 200), first);
    deviceB.clock.set(200);
    await deviceB.store.putDocument(metaFor(first, "B's later title", 200), first);

    // A folder renamed at two times — the later stamp wins, whichever order the hub saw them in.
    deviceA.clock.set(250);
    await deviceA.store.putFolder({ id: "folder-1", name: "A's shelf", parentId: null, updatedAt: 0, deleted: false });
    deviceB.clock.set(300);
    await deviceB.store.putFolder({ id: "folder-1", name: "B's shelf", parentId: null, updatedAt: 0, deleted: false });

    // A deletion that loses to a later rewrite: A ends B's bookmark, B rewrites it afterwards.
    deviceA.clock.set(320);
    await deviceA.store.deleteBookmark("bookmark-1");
    deviceB.clock.set(360);
    await deviceB.store.putBookmark({
      id: "bookmark-1",
      docId: second.docId,
      sentenceIndex: 0,
      wordIndex: 0,
      note: "B's later note",
      createdAt: 0,
      updatedAt: 0,
      deleted: false,
    });

    // Progress on one document at the same instant — the tie again falls to the greater device id.
    deviceA.clock.set(380);
    await deviceA.store.setProgress({ docId: first.docId, sentenceIndex: 4, wordIndex: 0, updatedAt: 0 });
    deviceB.clock.set(380);
    await deviceB.store.setProgress({ docId: first.docId, sentenceIndex: 7, wordIndex: 0, updatedAt: 0 });

    // A setting written at two times, and the later one is the smaller device's.
    deviceA.clock.set(420);
    await deviceA.store.setSetting("theme", "light");
    deviceB.clock.set(400);
    await deviceB.store.setSetting("theme", "sepia");

    // A deletion that wins: A ends the second page after B's own edit of it.
    deviceB.clock.set(480);
    await deviceB.store.putDocument(metaFor(second, "B's edited second page", 480), second);
    deviceA.clock.set(500);
    await deviceA.store.deleteDocument(second.docId);

    await settle(app, devices);

    // Neither device has anything left to send.
    expect(await deviceA.store.pendingOps(MAX_PUSH_OPS)).toEqual([]);
    expect(await deviceB.store.pendingOps(MAX_PUSH_OPS)).toEqual([]);

    // The outcome F§5.9's rule names, measured on both sides.
    for (const device of devices) {
      const live = await device.store.listDocuments();
      expect(live.map((meta) => meta.docId)).toEqual([first.docId]);
      expect((await device.store.getDocumentMeta(first.docId))?.title).toBe("B's later title");
      expect(await device.store.getDocumentMeta(second.docId)).toBeNull();
      expect((await device.store.listFolders()).map((folder) => folder.name)).toEqual(["B's shelf"]);
      expect((await device.store.listBookmarks(second.docId)).map((bookmark) => bookmark.note)).toEqual(["B's later note"]);
      expect((await device.store.getProgress(first.docId))?.sentenceIndex).toBe(7);
      expect(await device.store.getSetting("theme")).toBe("light");
    }

    // And the two record sets are identical, kind by kind.
    const docIds = [first.docId, second.docId];
    expect(await recordsOf(deviceA.store, docIds, second.docId, ["theme"])).toEqual(
      await recordsOf(deviceB.store, docIds, second.docId, ["theme"]),
    );
  });
});
