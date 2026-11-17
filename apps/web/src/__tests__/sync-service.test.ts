/**
 * The page's sync wiring (F§8, F§10.1), without a browser.
 *
 * What is under test is this module's own five decisions: that an engine is built only for a device whose
 * switch is on, that the page coming back to the foreground asks for a round, that switching sync off really
 * stops the engine and silences the signals the page would otherwise deliver, that a write nothing announced
 * is still noticed — the doorbell — and that where a device's cursor starts is decided once, from what the
 * device itself holds and the `rev` the hub answers with.
 *
 * The engine itself is this file's (U-058 owns the round), the store is `@lectern/core`'s in-memory one, and
 * the clock, the switch, the visibility, the network and the feed are all fakes, so no case touches a hub, a
 * socket or a real timer.
 */

import type { SyncEngine, SyncFeedSocket, SyncStatus } from "@lectern/api-client";
import { buildDocument, type Clock, createMemoryLibraryStore, type DocumentMeta, type LibraryStore } from "@lectern/core";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  createSyncService,
  readSyncEnabled,
  SYNC_ENABLED_KEY,
  type SyncEngineSeams,
  type SyncService,
  type SyncServices,
  writeSyncEnabled,
} from "../sync/sync-service";

/** The document a case writes progress for: any id, because nothing here reads the record back. */
const DOC_ID = "0123456789abcdef0123456789abcdef";

/** The `rev` the fake hub reports when it accepts a feed, which is where a joining device starts. */
const HUB_REV = 42;

/** An engine the test drives by hand: every member a listener this file can assert on. */
interface FakeEngine {
  engine: SyncEngine;
  start: Mock;
  stop: Mock;
  syncNow: Mock;
  notifyLocalChange: Mock;
  status: Mock;
}

/** The statuses a fake engine reports, so a case can watch one reach the service's own view. */
const ENGINE_STATUS: SyncStatus = { state: "idle", lastSyncedAt: 12, pending: 0 };

/**
 * A fake engine whose `start` opens the feed the way U-058's does — which is what takes the join decision,
 * because the real engine authenticates before its first round reads the cursor.
 */
function fakeEngine(seams: SyncEngineSeams): FakeEngine {
  const start = vi.fn(async (): Promise<void> => {
    (await seams.openSocket()).close();
  });
  const stop = vi.fn();
  const syncNow = vi.fn(async (): Promise<void> => undefined);
  const notifyLocalChange = vi.fn();
  const ensureModel = vi.fn(async () => null);
  const status = vi.fn(async (): Promise<SyncStatus> => ENGINE_STATUS);
  return {
    engine: { start, stop, syncNow, notifyLocalChange, ensureModel, status },
    start,
    stop,
    syncNow,
    notifyLocalChange,
    status,
  };
}

/** A feed that answers F§8.3's `ready` with the hub's own rev and does nothing else. */
function fakeFeed(): SyncFeedSocket {
  return {
    send: () => undefined,
    close: () => undefined,
    onMessage: () => undefined,
    onClose: () => undefined,
  };
}

/** A clock the test moves by hand, so the doorbell's beat is an assertion rather than a wait. */
interface FakeClock {
  clock: Clock;
  advance(ms: number): void;
}

function fakeClock(): FakeClock {
  const timers = new Map<number, { at: number; run: () => void }>();
  let now = 0;
  let handles = 0;
  return {
    clock: {
      now: () => now,
      setTimeout: (run, delayMs) => {
        handles += 1;
        timers.set(handles, { at: now + delayMs, run });
        return handles;
      },
      clearTimeout: (handle) => {
        timers.delete(handle);
      },
    },
    advance: (ms) => {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)
          .at(0);
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = target;
    },
  };
}

/** Let every already-resolved promise run: the doorbell's beat finishes in microtasks, not on a timer. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

/** Write one document into a device's store, as an import before the device joined the hub would. */
async function holdDocument(store: LibraryStore): Promise<void> {
  const model = buildDocument([{ kind: "paragraph", text: "A page the reader imported before joining." }], {
    source: { kind: "txt" },
  });
  const meta: DocumentMeta = {
    docId: model.docId,
    title: "Already held",
    sourceKind: "txt",
    folderId: null,
    addedAt: 1,
    wordCount: model.wordCount,
    sentenceCount: model.sentenceCount,
    updatedAt: 1,
    deleted: false,
  };
  await store.putDocument(meta, model);
}

/** One service, its fakes, and the levers a case pulls. */
interface Rig {
  service: SyncService;
  services: SyncServices;
  engines: FakeEngine[];
  seams: () => SyncEngineSeams;
  visible: () => void;
  network: (online: boolean) => void;
  advance: (ms: number) => void;
}

function rig(options: { enabled?: boolean; hubRev?: number } = {}): Rig {
  const engines: FakeEngine[] = [];
  const timer = fakeClock();
  let switchOn = options.enabled ?? true;
  let visibility: (() => void) | null = null;
  let network: ((online: boolean) => void) | null = null;
  let seams: SyncEngineSeams | null = null;

  const service = createSyncService({
    clock: timer.clock,
    isEnabled: () => switchOn,
    setEnabled: (value) => {
      switchOn = value;
    },
    visibility: (listener) => {
      visibility = listener;
      return () => {
        visibility = null;
      };
    },
    network: (listener) => {
      network = listener;
      return () => {
        network = null;
      };
    },
    feed: async () => ({ rev: options.hubRev ?? HUB_REV, socket: fakeFeed() }),
    engineFor: (_services, provided) => {
      seams = provided;
      const next = fakeEngine(provided);
      engines.push(next);
      return next.engine;
    },
  });

  let issued = 0;
  const store: LibraryStore = createMemoryLibraryStore({
    deviceId: "device-a",
    now: () => 1000,
    newId: () => {
      issued += 1;
      return `op-${issued}`;
    },
  });

  return {
    service,
    services: { store },
    engines,
    seams: () => {
      if (seams === null) throw new Error("no engine was built, so it has no seams");
      return seams;
    },
    visible: () => visibility?.(),
    network: (online) => network?.(online),
    advance: (ms) => timer.advance(ms),
  };
}

// A device's join is remembered in this browser's own storage, which every rig in this file shares.
beforeEach(() => {
  globalThis.localStorage.clear();
});

describe("the sync service", () => {
  it("builds no engine while this device's switch is off", async () => {
    const under = rig({ enabled: false });
    await under.service.start(under.services);

    expect(under.engines).toHaveLength(0);
    expect(under.service.running()).toBe(false);
    expect(under.service.view()).toEqual({ running: false, status: { state: "idle", lastSyncedAt: null, pending: 0 } });

    // The page's own signals reach nothing, and there is no body to fetch for a document either.
    under.visible();
    expect(under.engines).toHaveLength(0);
    await expect(under.service.ensureModel(DOC_ID)).resolves.toBeNull();
    await expect(under.service.syncNow()).resolves.toBeUndefined();
  });

  it("starts one engine for a device whose switch is on, and never a second", async () => {
    const under = rig();
    await under.service.start(under.services);

    expect(under.engines).toHaveLength(1);
    expect(under.engines[0]?.start).toHaveBeenCalledTimes(1);
    expect(under.service.running()).toBe(true);
    expect(under.service.view().running).toBe(true);

    // A boot feature that runs twice, or a settings screen that asks again, is still one engine.
    await under.service.start(under.services);
    expect(under.engines).toHaveLength(1);
    expect(under.engines[0]?.start).toHaveBeenCalledTimes(1);
  });

  it("asks for a round every time the page comes back to the foreground", async () => {
    const under = rig();
    await under.service.start(under.services);

    under.visible();
    expect(under.engines[0]?.syncNow).toHaveBeenCalledTimes(1);
    under.visible();
    expect(under.engines[0]?.syncNow).toHaveBeenCalledTimes(2);

    // Regaining the network is the same request: a device that was offline is caught up at once.
    under.network(true);
    expect(under.engines[0]?.syncNow).toHaveBeenCalledTimes(3);
  });

  it("stops the engine, and stops listening, when the switch goes off", async () => {
    const under = rig();
    await under.service.start(under.services);

    await under.service.setEnabled(false);

    expect(under.engines[0]?.stop).toHaveBeenCalledTimes(1);
    expect(under.service.running()).toBe(false);
    expect(under.service.enabled()).toBe(false);
    expect(under.service.view().running).toBe(false);

    // Nothing the page does reaches an engine that is gone...
    under.visible();
    under.network(true);
    under.service.notifyLocalChange();
    expect(under.engines[0]?.syncNow).toHaveBeenCalledTimes(0);
    expect(under.engines[0]?.notifyLocalChange).toHaveBeenCalledTimes(0);

    // ...and switching it back on builds a fresh one rather than reviving the dead.
    await under.service.setEnabled(true);
    expect(under.engines).toHaveLength(2);
    expect(under.engines[1]?.start).toHaveBeenCalledTimes(1);
    expect(under.service.running()).toBe(true);
  });

  it("rings the engine while the outbox is waiting, and stays quiet while it is empty", async () => {
    const waiting = rig();
    await waiting.service.start(waiting.services);

    // A write nothing announced — an import, a bookmark, a folder — leaves one op in F§5.9's outbox.
    await waiting.services.store.setProgress({ docId: DOC_ID, sentenceIndex: 3, wordIndex: 1, updatedAt: 5 });
    waiting.advance(1000);
    await settle();

    expect(waiting.engines[0]?.notifyLocalChange).toHaveBeenCalledTimes(1);

    // A device with nothing to send is not asked for a round, however many beats pass.
    const empty = rig();
    await empty.service.start(empty.services);
    empty.advance(5000);
    await settle();

    expect(empty.engines[0]?.notifyLocalChange).toHaveBeenCalledTimes(0);
  });

  it("answers a stopped device's figures from the store it still holds", async () => {
    const under = rig({ enabled: false });
    await under.service.start(under.services);
    await under.services.store.setProgress({ docId: DOC_ID, sentenceIndex: 0, wordIndex: 0, updatedAt: 1 });

    await expect(under.service.status()).resolves.toEqual({ state: "idle", lastSyncedAt: null, pending: 1 });
  });

  it("hands the engine the seams the page owns", async () => {
    const under = rig();
    await under.service.start(under.services);

    // The engine is given the browser's clock and reachability, and this module's own status listener.
    expect(under.seams().clock.now()).toBe(0);
    expect(under.seams().isOnline()).toBe(true);
    under.seams().onStatus({ state: "syncing", lastSyncedAt: null, pending: 4 });
    expect(under.service.view().status).toEqual({ state: "syncing", lastSyncedAt: null, pending: 4 });

    await expect(under.service.status()).resolves.toEqual(ENGINE_STATUS);
  });
});

describe("where a device starts", () => {
  it("starts a device that already holds documents at the hub's own rev", async () => {
    const under = rig();
    await holdDocument(under.services.store);

    await under.service.start(under.services);

    // F§8.3's `ready` frame is the hub's own rev, and the change log before the join is not replayed into a
    // library the reader built.
    await expect(under.services.store.getCursor()).resolves.toBe(HUB_REV);
  });

  it("leaves a device that holds nothing to take the hub's library", async () => {
    const under = rig();

    await under.service.start(under.services);

    // The cursor stays at zero, so the device's first pull is the whole change log (F§8.2).
    await expect(under.services.store.getCursor()).resolves.toBe(0);
  });

  it("decides a device's start once, and keeps the cursor a pull earns afterwards", async () => {
    const under = rig();
    await holdDocument(under.services.store);
    await under.service.start(under.services);
    await expect(under.services.store.getCursor()).resolves.toBe(HUB_REV);

    // A round moves the cursor, and a reconnecting feed — the same join, a second time — must not move it
    // back to the hub's rev.
    await under.services.store.setCursor(HUB_REV + 5);
    (await under.seams().openSocket()).close();

    await expect(under.services.store.getCursor()).resolves.toBe(HUB_REV + 5);
  });
});

describe("this device's switch", () => {
  it("is on until it is turned off, and remembers what it is told", () => {
    globalThis.localStorage.removeItem(SYNC_ENABLED_KEY);
    expect(readSyncEnabled()).toBe(true);

    writeSyncEnabled(false);
    expect(readSyncEnabled()).toBe(false);
    expect(globalThis.localStorage.getItem(SYNC_ENABLED_KEY)).toBe("false");

    writeSyncEnabled(true);
    expect(readSyncEnabled()).toBe(true);
    expect(globalThis.localStorage.getItem(SYNC_ENABLED_KEY)).toBe("true");
  });
});
