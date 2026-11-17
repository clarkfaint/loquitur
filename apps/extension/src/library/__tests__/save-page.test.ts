/**
 * Saving a page, and the reader's place in it (F§10.2, Phase 5).
 *
 * Four things are pinned here, and each is one of the module's own promises: a save writes exactly one document
 * and asks the hub for one round; a second save of the same page is an answer and not a second document; a place
 * is written only for a document the library holds; and a place is written at most every five seconds — except
 * when the player has settled, which is what makes a pause land.
 *
 * The store is F§5.9's reference implementation and the engine is a two-counter stand-in, because neither of
 * those is what this file is testing: the store is the interface's own behaviour, already covered by
 * `runLibraryStoreConformance`, and the engine's rounds are U-058's. What is measured here is what this module
 * asks of them. Time is faked, so the five-second rule is exercised without waiting five seconds.
 */

import type { SyncEngine, SyncStatus } from "@lectern/api-client";
import { buildDocument, createMemoryLibraryStore, type DocumentModel, type LibraryStore, type PlayerSnapshot } from "@lectern/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROGRESS_INTERVAL_MS, recordProgress, savePage } from "../save-page";

/** The instant every case starts at, so the throttle is arithmetic rather than elapsed time. */
const T0 = Date.UTC(2026, 10, 17, 9, 0, 0);

/** The page a case saves. */
const PAGE_URI = "https://reader.example.invalid/tide-machine";

/** What this unit's module asks of F§8.2's engine: one round, and one notification. */
interface FakeEngine extends SyncEngine {
  /** How many rounds were asked for. */
  syncs: number;
  /** How many local changes were announced. */
  changes: number;
}

/** An engine that counts the two calls these functions make and does nothing else. */
function fakeEngine(): FakeEngine {
  const engine: FakeEngine = {
    syncs: 0,
    changes: 0,
    start: async () => undefined,
    stop: () => undefined,
    syncNow: async () => {
      engine.syncs += 1;
    },
    notifyLocalChange: () => {
      engine.changes += 1;
    },
    ensureModel: async () => null,
    status: async (): Promise<SyncStatus> => ({ state: "idle", lastSyncedAt: null, pending: 0 }),
  };
  return engine;
}

/** A store over memory, whose clock and op ids are the faked ones every case reads back. */
function memoryStore(): LibraryStore {
  let issued = 0;
  return createMemoryLibraryStore({
    deviceId: "device-a",
    now: () => Date.now(),
    newId: () => {
      issued += 1;
      return `op-${issued}`;
    },
  });
}

/** The page as the content script would have extracted it (F§5.1, F§10.2). */
function probePage(): DocumentModel {
  return buildDocument([{ kind: "paragraph", text: "The tide machine turns twice a day. The harbour keeps its own clock." }], {
    title: "The tide machine",
    source: { kind: "html", uri: PAGE_URI },
  });
}

/** One player state, with everything a case does not name left at rest. */
function snapshotOf(overrides: Partial<PlayerSnapshot>): PlayerSnapshot {
  return {
    state: "playing",
    docId: null,
    sentenceIndex: 0,
    wordIndex: 0,
    rate: 1,
    voiceId: null,
    sleepRemainingMs: null,
    error: null,
    ...overrides,
  };
}

let store: LibraryStore;
let engine: FakeEngine;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  store = memoryStore();
  engine = fakeEngine();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("savePage", () => {
  it("writes one document, with F§5.9's metadata for a page, and asks for a round", async () => {
    const document = probePage();
    const result = await savePage({ store, engine, document, now: Date.now() });

    expect(result).toEqual({ docId: document.docId, duplicate: false });
    const meta = await store.getDocumentMeta(document.docId);
    expect(meta).toMatchObject({
      docId: document.docId,
      title: "The tide machine",
      sourceKind: "html",
      sourceUri: PAGE_URI,
      folderId: null,
      addedAt: T0,
      updatedAt: T0,
      deleted: false,
    });
    // The counts are the model's own, so a library row cannot disagree with the document it names.
    expect(meta?.wordCount).toBe(document.wordCount);
    expect(meta?.sentenceCount).toBe(document.sentenceCount);
    // The model travels with the record: the hub's own `PUT …/model` needs it, and F§8.2 uploads it first.
    expect(await store.getDocumentModel(document.docId)).toEqual(document);
    expect(engine.syncs).toBe(1);
  });

  it("reports a duplicate the second time, and writes nothing", async () => {
    const document = probePage();
    await savePage({ store, engine, document, now: Date.now() });
    const again = await savePage({ store, engine, document, now: Date.now() + 60_000 });

    expect(again).toEqual({ docId: document.docId, duplicate: true });
    expect(engine.syncs).toBe(1);
    expect(await store.listDocuments()).toHaveLength(1);
    // One document put and nothing else: a duplicate is not a second record for the hub to sort out.
    const pending = await store.pendingOps(10);
    expect(pending.filter((op) => op.entity === "document")).toHaveLength(1);
    expect((await store.getDocumentMeta(document.docId))?.addedAt).toBe(T0);
  });
});

describe("recordProgress", () => {
  it("writes nothing for a document the library does not hold", async () => {
    const wrote = await recordProgress(store, engine, snapshotOf({ docId: "never-saved", sentenceIndex: 4 }));

    expect(wrote).toBe(false);
    expect(await store.getProgress("never-saved")).toBeNull();
    expect(engine.changes).toBe(0);
  });

  it("writes nothing when no document is loaded", async () => {
    expect(await recordProgress(store, engine, snapshotOf({ docId: null }))).toBe(false);
    expect(engine.changes).toBe(0);
  });

  it("writes the place of a saved document, and tells the engine once", async () => {
    const document = probePage();
    await savePage({ store, engine, document, now: Date.now() });

    const wrote = await recordProgress(store, engine, snapshotOf({ docId: document.docId, sentenceIndex: 1, wordIndex: 3 }));

    expect(wrote).toBe(true);
    expect(await store.getProgress(document.docId)).toEqual({
      docId: document.docId,
      sentenceIndex: 1,
      wordIndex: 3,
      updatedAt: T0,
    });
    expect(engine.changes).toBe(1);
  });

  it("throttles a moving player to one write per interval, and lets a pause through", async () => {
    const document = probePage();
    await savePage({ store, engine, document, now: Date.now() });
    const docId = document.docId;

    expect(await recordProgress(store, engine, snapshotOf({ docId, sentenceIndex: 1 }))).toBe(true);
    vi.setSystemTime(T0 + 1_000);
    expect(await recordProgress(store, engine, snapshotOf({ docId, sentenceIndex: 2 }))).toBe(false);
    expect((await store.getProgress(docId))?.sentenceIndex).toBe(1);

    // A settled player is written at once: the reader's pause is the place worth keeping.
    vi.setSystemTime(T0 + 2_000);
    expect(await recordProgress(store, engine, snapshotOf({ docId, state: "paused", sentenceIndex: 3 }))).toBe(true);
    expect((await store.getProgress(docId))?.sentenceIndex).toBe(3);

    // And once the interval has passed, a moving player is written again.
    vi.setSystemTime(T0 + 2_000 + PROGRESS_INTERVAL_MS);
    expect(await recordProgress(store, engine, snapshotOf({ docId, sentenceIndex: 4 }))).toBe(true);
    expect((await store.getProgress(docId))?.sentenceIndex).toBe(4);
    expect(engine.changes).toBe(3);
  });
});
