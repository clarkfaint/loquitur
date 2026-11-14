/**
 * The conformance suite every `LibraryStore` implementation must pass (F§5.9). It is runner-agnostic: it
 * builds its documents with the real `buildDocument`, drives the store only through the interface, and
 * returns one result per case so an implementation's own tests can assert all of them or report which
 * failed.
 *
 * The factory supplies the store's identity and its clock, so a suite run is deterministic and the
 * last-writer-wins cases can name the timestamps they use.
 */

import { buildDocument } from "../builder";
import type { DocumentModel } from "../model";
import type { Bookmark, DocumentMeta, EntityKind, Folder, LibraryStore, Op, Progress } from "../store/types";

export interface LibraryStoreConformanceOptions {
  deviceId: string;
  now: () => number;
  newId: () => string;
}

export type LibraryStoreFactory = (options: LibraryStoreConformanceOptions) => LibraryStore | Promise<LibraryStore>;

export interface LibraryStoreConformanceResult {
  name: string;
  ok: boolean;
  error?: string;
}

/** The first timestamp every case starts its clock at. */
const START_TS = 1000;

/** A clock the suite sets by hand, so a case can say exactly when a record was written. */
interface ConformanceClock {
  now: () => number;
  set: (value: number) => void;
}

function makeClock(start = START_TS): ConformanceClock {
  const state = { value: start };
  return {
    now: () => state.value,
    set: (value: number) => {
      state.value = value;
    },
  };
}

/** A source of op identifiers, shared between stores when they have to exchange ops. */
function makeIdSource(): () => string {
  let issued = 0;
  return () => {
    issued += 1;
    return `op-${issued}`;
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** A document whose text — and therefore whose `docId` — is unique to `index`. */
function makeDocument(index: number, title: string): { meta: DocumentMeta; model: DocumentModel } {
  const model = buildDocument([{ kind: "paragraph", text: `${title} is document number ${index}, and it has one sentence.` }], {
    source: { kind: "txt" },
  });
  const meta: DocumentMeta = {
    docId: model.docId,
    title,
    sourceKind: "txt",
    folderId: null,
    addedAt: START_TS,
    wordCount: model.wordCount,
    sentenceCount: model.sentenceCount,
    updatedAt: 0,
    deleted: false,
  };
  return { meta, model };
}

function makeFolder(id: string, name: string, parentId: string | null = null): Folder {
  return { id, name, parentId, updatedAt: 0, deleted: false };
}

function makeBookmark(id: string, docId: string, sentenceIndex: number, wordIndex: number): Bookmark {
  return { id, docId, sentenceIndex, wordIndex, note: `bookmark ${id}`, createdAt: START_TS, updatedAt: 0, deleted: false };
}

function makeProgress(docId: string, sentenceIndex: number, wordIndex: number): Progress {
  return { docId, sentenceIndex, wordIndex, updatedAt: 0 };
}

/** One remote op for an existing folder, carrying a record a case can recognise afterwards. */
function folderOp(opId: string, name: string, ts: number, deviceId: string): Op {
  return {
    opId,
    deviceId,
    entity: "folder",
    entityId: "folder-1",
    kind: "put",
    ts,
    record: { id: "folder-1", name, parentId: null, updatedAt: ts, deleted: false },
  };
}

/**
 * A comparable view of everything a store exposes, with every list in a stable order so two stores that
 * reached the same state serialise identically whatever order they applied the ops in.
 */
async function snapshot(store: LibraryStore, settingKeys: readonly string[]): Promise<string> {
  const documents = (await store.listDocuments()).sort((left, right) => left.docId.localeCompare(right.docId));
  const folders = (await store.listFolders()).sort((left, right) => left.id.localeCompare(right.id));
  const bookmarks = await Promise.all(
    documents.map(async (doc) => (await store.listBookmarks(doc.docId)).sort((left, right) => left.id.localeCompare(right.id))),
  );
  const positions = await Promise.all(documents.map((doc) => store.getProgress(doc.docId)));
  const settings = await Promise.all(settingKeys.map((key) => store.getSetting(key)));
  return JSON.stringify({ documents, folders, bookmarks, positions, settings });
}

/** Run every F§5.9 store case against `factory`. Each case gets a fresh store of its own. */
export async function runLibraryStoreConformance(factory: LibraryStoreFactory): Promise<LibraryStoreConformanceResult[]> {
  const results: LibraryStoreConformanceResult[] = [];

  const record = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
      results.push({ name, ok: true });
    } catch (cause) {
      results.push({ name, ok: false, error: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  /** A store with its own clock, identified as `deviceId`. */
  const open = async (deviceId = "conformance-a", clock = makeClock(), newId = makeIdSource()): Promise<LibraryStore> =>
    factory({ deviceId, now: clock.now, newId });

  await record("document round trip", async () => {
    const store = await open();
    const { meta, model } = makeDocument(1, "Round Trip");
    await store.putDocument(meta, model);

    const stored = await store.getDocumentMeta(meta.docId);
    assert(stored !== null, "getDocumentMeta answered null straight after putDocument");
    assert(stored.docId === meta.docId, `getDocumentMeta answered docId ${stored.docId}`);
    assert(stored.title === "Round Trip", `the title came back as ${stored.title}`);
    assert(stored.sourceKind === "txt", `the source kind came back as ${stored.sourceKind}`);
    assert(stored.wordCount === model.wordCount, `wordCount came back as ${stored.wordCount}, expected ${model.wordCount}`);
    assert(stored.sentenceCount === model.sentenceCount, `sentenceCount came back as ${stored.sentenceCount}`);
    assert(stored.folderId === null, `folderId came back as ${String(stored.folderId)}`);
    assert(stored.deleted === false, "a document that was put came back deleted");
    assert(stored.updatedAt === START_TS, `updatedAt came back as ${stored.updatedAt}, expected the store clock's ${START_TS}`);

    const loaded = await store.getDocumentModel(meta.docId);
    assert(loaded !== null, "getDocumentModel answered null straight after putDocument");
    assert(loaded.docId === meta.docId, "the model came back under a different docId");
    assert(loaded.blocks.length === model.blocks.length, `the model came back with ${loaded.blocks.length} blocks`);

    const listed = await store.listDocuments();
    assert(listed.length === 1, `listDocuments answered ${listed.length} documents after one put`);
  });

  await record("list filtered by folder and by text", async () => {
    const store = await open();
    await store.putFolder(makeFolder("folder-a", "Course reading"));
    await store.putFolder(makeFolder("folder-b", "Later"));
    const alpha = makeDocument(2, "Alpha Report");
    const beta = makeDocument(3, "Beta Notes");
    const gamma = makeDocument(4, "Gamma Summary");
    await store.putDocument({ ...alpha.meta, folderId: "folder-a" }, alpha.model);
    await store.putDocument({ ...beta.meta, folderId: "folder-b" }, beta.model);
    await store.putDocument(gamma.meta, gamma.model);

    const titles = (metas: DocumentMeta[]): string[] => metas.map((meta) => meta.title).sort();

    assert(titles(await store.listDocuments()).join("|") === "Alpha Report|Beta Notes|Gamma Summary", "an unfiltered list lost a document");
    assert(
      titles(await store.listDocuments({ folderId: "folder-a" })).join("|") === "Alpha Report",
      "a folder filter did not narrow to that folder",
    );
    assert(
      titles(await store.listDocuments({ folderId: "folder-b" })).join("|") === "Beta Notes",
      "a folder filter did not narrow to the second folder",
    );
    assert(
      titles(await store.listDocuments({ folderId: null })).join("|") === "Gamma Summary",
      "the `null` folder filter did not select the documents at the root",
    );
    assert(titles(await store.listDocuments({ text: "notes" })).join("|") === "Beta Notes", "a text filter missed a lowercase search");
    assert(titles(await store.listDocuments({ text: "A" })).length === 3, "a single-letter text filter did not match every title");
    assert(
      titles(await store.listDocuments({ folderId: "folder-a", text: "summary" })).length === 0,
      "a folder filter and a text filter did not have to agree",
    );
    assert(titles(await store.listDocuments({ text: "nothing here" })).length === 0, "a text filter matched text that is in no title");
  });

  await record("delete produces a tombstone and removes the model", async () => {
    const clock = makeClock();
    const store = await open("conformance-a", clock);
    const { meta, model } = makeDocument(5, "Tombstone");
    await store.putDocument(meta, model);
    assert((await store.getDocumentModel(meta.docId)) !== null, "the model was absent before the delete");

    clock.set(START_TS + 60);
    await store.deleteDocument(meta.docId);

    assert((await store.getDocumentMeta(meta.docId)) === null, "getDocumentMeta still answered a deleted document");
    assert((await store.getDocumentModel(meta.docId)) === null, "the model outlived the delete");
    assert((await store.listDocuments()).length === 0, "a deleted document is still listed");

    const ops = await store.pendingOps(10);
    assert(ops.length === 2, `expected a put and a delete op, got ${ops.length}`);
    const removed = ops[ops.length - 1];
    assert(removed !== undefined, "the delete op is missing");
    assert(removed.entity === "document" && removed.entityId === meta.docId, "the delete op names another entity");
    assert(removed.kind === "delete", `the delete op's kind is ${removed.kind}`);
    assert(removed.ts === START_TS + 60, `the delete op's ts is ${removed.ts}, expected the clock's ${START_TS + 60}`);
    const payload = removed.record;
    assert(typeof payload === "object" && payload !== null && "deleted" in payload, "the delete op carries no record");
    assert(payload.deleted === true, "the delete op's record is not a tombstone");
  });

  await record("folder, bookmark, progress and setting round trips", async () => {
    const store = await open();
    const { meta, model } = makeDocument(6, "Round Trips");
    await store.putDocument(meta, model);

    await store.putFolder(makeFolder("folder-1", "Reading", null));
    const folders = await store.listFolders();
    assert(folders.length === 1, `listFolders answered ${folders.length} folders`);
    const folder = folders[0];
    assert(folder !== undefined && folder.id === "folder-1" && folder.name === "Reading", "the folder did not round trip");
    assert(folder.updatedAt === START_TS, `the folder's updatedAt is ${folder.updatedAt}`);
    assert(folder.parentId === null, "the folder's parentId did not round trip");

    await store.putBookmark(makeBookmark("bookmark-1", meta.docId, 0, 2));
    const bookmarks = await store.listBookmarks(meta.docId);
    assert(bookmarks.length === 1, `listBookmarks answered ${bookmarks.length} bookmarks`);
    const bookmark = bookmarks[0];
    assert(bookmark !== undefined && bookmark.id === "bookmark-1", "the bookmark did not round trip");
    assert(bookmark.sentenceIndex === 0 && bookmark.wordIndex === 2, "the bookmark's position did not round trip");
    assert(bookmark.note === "bookmark bookmark-1", `the bookmark's note came back as ${bookmark.note}`);
    assert(bookmark.createdAt === START_TS, "the bookmark's createdAt was rewritten");
    assert((await store.listBookmarks("another-document")).length === 0, "a bookmark was listed under another document");

    await store.setProgress(makeProgress(meta.docId, 3, 4));
    const position = await store.getProgress(meta.docId);
    assert(position !== null, "getProgress answered null after setProgress");
    assert(position.sentenceIndex === 3 && position.wordIndex === 4, "the progress position did not round trip");
    assert((await store.getProgress("another-document")) === null, "progress was reported for a document that has none");

    await store.setSetting("voice", "memory:default");
    assert((await store.getSetting("voice")) === "memory:default", "the setting did not round trip");
    await store.setSetting("voice", "memory:second");
    assert((await store.getSetting("voice")) === "memory:second", "a setting kept its first value");
    assert((await store.getSetting("unset")) === null, "an unset setting answered a value");
  });

  await record("each mutation appends exactly one op", async () => {
    const clock = makeClock();
    const store = await open("conformance-a", clock);
    const { meta, model } = makeDocument(7, "One Op Each");
    const bookmark = makeBookmark("bookmark-7", meta.docId, 1, 1);
    const mutations: { label: string; entity: EntityKind; entityId: string; kind: "put" | "delete"; run: () => Promise<void> }[] = [
      { label: "putDocument", entity: "document", entityId: meta.docId, kind: "put", run: () => store.putDocument(meta, model) },
      {
        label: "putFolder",
        entity: "folder",
        entityId: "folder-7",
        kind: "put",
        run: () => store.putFolder(makeFolder("folder-7", "Seven")),
      },
      { label: "putBookmark", entity: "bookmark", entityId: bookmark.id, kind: "put", run: () => store.putBookmark(bookmark) },
      {
        label: "setProgress",
        entity: "progress",
        entityId: meta.docId,
        kind: "put",
        run: () => store.setProgress(makeProgress(meta.docId, 0, 0)),
      },
      { label: "setSetting", entity: "setting", entityId: "theme", kind: "put", run: () => store.setSetting("theme", "sepia") },
      { label: "deleteBookmark", entity: "bookmark", entityId: bookmark.id, kind: "delete", run: () => store.deleteBookmark(bookmark.id) },
      { label: "deleteFolder", entity: "folder", entityId: "folder-7", kind: "delete", run: () => store.deleteFolder("folder-7") },
      { label: "deleteDocument", entity: "document", entityId: meta.docId, kind: "delete", run: () => store.deleteDocument(meta.docId) },
    ];

    let expected = 0;
    for (const mutation of mutations) {
      clock.set(START_TS + expected);
      await mutation.run();
      expected += 1;
      const ops = await store.pendingOps(expected + 5);
      assert(ops.length === expected, `${mutation.label} left ${ops.length} ops in the outbox, expected ${expected}`);
      const added = ops[ops.length - 1];
      assert(added !== undefined, `${mutation.label} appended no op`);
      assert(
        added.entity === mutation.entity && added.entityId === mutation.entityId && added.kind === mutation.kind,
        `${mutation.label} appended ${added.kind} ${added.entity} ${added.entityId}`,
      );
      assert(added.ts === START_TS + expected - 1, `${mutation.label} stamped ts ${added.ts}, expected ${START_TS + expected - 1}`);
      assert(added.deviceId === "conformance-a", `${mutation.label} stamped another device: ${added.deviceId}`);
      assert(added.opId.length > 0, `${mutation.label} appended an op with no id`);
      const ids = new Set(ops.map((op) => op.opId));
      assert(ids.size === ops.length, "two ops in the outbox share an opId");
    }
  });

  await record("ackOps removes them", async () => {
    const store = await open();
    const first = makeDocument(8, "Ack First");
    const second = makeDocument(9, "Ack Second");
    await store.putDocument(first.meta, first.model);
    await store.putDocument(second.meta, second.model);
    const before = await store.pendingOps(10);
    assert(before.length === 2, `two puts left ${before.length} ops`);
    const firstOp = before[0];
    assert(firstOp !== undefined, "the first op is missing");

    await store.ackOps([firstOp.opId]);
    const after = await store.pendingOps(10);
    assert(after.length === 1, `ackOps left ${after.length} ops`);
    assert(after[0]?.opId === before[1]?.opId, "ackOps removed the op it was not given");

    await store.ackOps(before.map((op) => op.opId));
    assert((await store.pendingOps(10)).length === 0, "ackOps left ops in the outbox");
    await store.ackOps([]);
  });

  await record("applyRemote applies newer, ignores older, breaks ties by deviceId, and never appends to the outbox", async () => {
    const store = await open("dev-mid");
    await store.putFolder(makeFolder("folder-1", "local"));
    const local = await store.pendingOps(10);
    assert(local.length === 1, `the local put left ${local.length} ops`);

    await store.applyRemote([folderOp("remote-1", "newer-ts", START_TS + 1, "dev-0")]);
    const newer = (await store.listFolders())[0];
    assert(newer?.name === "newer-ts", `a newer timestamp was not applied (name is ${newer?.name ?? "absent"})`);

    await store.applyRemote([folderOp("remote-2", "older-ts", START_TS - 1, "dev-z")]);
    const older = (await store.listFolders())[0];
    assert(older?.name === "newer-ts", `an older timestamp replaced the record (name is ${older?.name ?? "absent"})`);

    await store.applyRemote([folderOp("remote-3", "tie-wins", START_TS + 1, "dev-mid")]);
    const tie = (await store.listFolders())[0];
    assert(tie?.name === "tie-wins", `an equal timestamp with a later deviceId lost (name is ${tie?.name ?? "absent"})`);

    await store.applyRemote([folderOp("remote-4", "tie-loses", START_TS + 1, "dev-0")]);
    const settled = (await store.listFolders())[0];
    assert(settled?.name === "tie-wins", `an equal timestamp with an earlier deviceId won (name is ${settled?.name ?? "absent"})`);

    const after = await store.pendingOps(10);
    assert(after.length === 1, `applyRemote queued ops: the outbox holds ${after.length}`);
    assert(after[0]?.opId === local[0]?.opId, "applyRemote replaced the queued op");
  });

  await record("cursor round trip", async () => {
    const store = await open();
    assert((await store.getCursor()) === 0, `a fresh store started at cursor ${await store.getCursor()}`);
    await store.setCursor(42);
    assert((await store.getCursor()) === 42, `setCursor(42) read back as ${await store.getCursor()}`);
    await store.setCursor(0);
    assert((await store.getCursor()) === 0, "the cursor could not go back to 0");
    assert((await store.pendingOps(10)).length === 0, "moving the cursor queued an op");
  });

  await record("two stores exchanging all ops in both directions converge to equal state", async () => {
    const ids = makeIdSource();
    const a = await open("device-a", makeClock(), ids);
    const b = await open("device-b", makeClock(), ids);
    const fromA = makeDocument(10, "From A");
    const fromB = makeDocument(11, "From B");
    const settings = ["voice", "speed"] as const;

    await a.putDocument(fromA.meta, fromA.model);
    await a.putFolder(makeFolder("folder-a", "A folder"));
    await a.putBookmark(makeBookmark("bookmark-a", fromA.meta.docId, 0, 0));
    await a.setProgress(makeProgress(fromA.meta.docId, 2, 3));
    await a.setSetting("voice", "memory:default");
    await b.putDocument(fromB.meta, fromB.model);
    await b.putFolder(makeFolder("folder-b", "B folder"));
    await b.setSetting("speed", 1.25);

    const opsA = await a.pendingOps(100);
    const opsB = await b.pendingOps(100);
    assert(opsA.length === 5, `store A queued ${opsA.length} ops, expected 5`);
    assert(opsB.length === 3, `store B queued ${opsB.length} ops, expected 3`);

    await b.applyRemote(opsA);
    await a.applyRemote(opsB);

    const stateA = await snapshot(a, settings);
    const stateB = await snapshot(b, settings);
    assert(stateA === stateB, `the two stores did not converge\nA: ${stateA}\nB: ${stateB}`);
    assert((await a.pendingOps(100)).length === opsA.length, "applying B's ops queued new ops on A");
    assert((await b.pendingOps(100)).length === opsB.length, "applying A's ops queued new ops on B");

    const remoteModel = await b.getDocumentModel(fromA.meta.docId);
    assert(remoteModel === null, "an applied document op brought a model it never carried");
    const ownModel = await b.getDocumentModel(fromB.meta.docId);
    assert(ownModel !== null, "exchanging ops dropped a document's own model");
  });

  return results;
}
