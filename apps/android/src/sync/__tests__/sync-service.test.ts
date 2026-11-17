/**
 * The Node-side tests of the Android sync service (AGENTS.md §7, F§8).
 *
 * `src/sync/sync-service.ts` is the one module of this unit that can run without a device, and it is written
 * to be: every platform API it touches — the connection, the switch, React Native's `AppState`, `expo/fetch`,
 * the socket — arrives as a seam with the platform's own implementation behind it. So what runs here is the
 * real service: the real start conditions, the real foreground wiring, the real doorbell and the real
 * lifecycle, with a fake engine standing in for U-058's (whose own round is U-058's test's business) and the
 * reference `MemoryLibraryStore` for F§5.9's records.
 *
 * Nothing here reaches a hub, a socket or a timer: the clock is `FakeClock`, so the doorbell fires when the
 * test says so and never while a case is settling.
 */

import type { SyncEngine, SyncStatus } from "@lectern/api-client";
import { createMemoryLibraryStore, type LibraryStore } from "@lectern/core";
import { FakeClock } from "@lectern/core/testing";
import { describe, expect, it } from "vitest";
import type { Connection } from "../../connection";
import { createSyncService, type ForegroundSource, type SyncServices } from "../sync-service";

/** The hub the fake connection points at. It is never contacted: the engine is a fake. */
const HUB: Connection = { hubUrl: "http://127.0.0.1:8787", token: "lectern-test-token" };

/** A store with nothing in it, over F§5.9's own reference implementation. */
function emptyStore(): LibraryStore {
  return createMemoryLibraryStore({ deviceId: "u061-test-device", now: () => 0, newId: () => `op-${Math.random()}` });
}

/** A foreground source a case drives by hand, with the two answers a real one gives. */
interface DrivenForeground extends ForegroundSource {
  fire(foreground: boolean): void;
}

function foreground(initial: boolean): DrivenForeground {
  const listeners = new Set<(foreground: boolean) => void>();
  return {
    now: async () => initial,
    watch: async (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    fire(value) {
      for (const listener of [...listeners]) listener(value);
    },
  };
}

/** What a fake engine was asked to do. */
interface EngineCalls {
  start: number;
  stop: number;
  syncNow: number;
  notifyLocalChange: number;
}

/** A fake U-058 engine: it records every call the service makes and answers F§8.2's own status. */
function fakeEngine(): { calls: EngineCalls; engine: SyncEngine } {
  const calls: EngineCalls = { start: 0, stop: 0, syncNow: 0, notifyLocalChange: 0 };
  const status: SyncStatus = { state: "idle", lastSyncedAt: 1, pending: 0 };
  return {
    calls,
    engine: {
      start: async () => {
        calls.start += 1;
      },
      stop: () => {
        calls.stop += 1;
      },
      syncNow: async () => {
        calls.syncNow += 1;
      },
      notifyLocalChange: () => {
        calls.notifyLocalChange += 1;
      },
      ensureModel: async () => null,
      status: async () => status,
    },
  };
}

/** Everything a case needs to drive the service. */
interface Harness {
  clock: FakeClock;
  store: LibraryStore;
  app: DrivenForeground;
  services: SyncServices;
  engines: { calls: EngineCalls; engine: SyncEngine }[];
  service: ReturnType<typeof createSyncService>;
  switches: boolean[];
  /** This device's switch, as the fakes hold it: what `isEnabled` answers and `setEnabled` writes. */
  switch: { enabled: boolean };
}

function harness(options: { enabled?: boolean; connection?: Connection | null; foreground?: boolean } = {}): Harness {
  const clock = new FakeClock();
  const store = emptyStore();
  const app = foreground(options.foreground ?? true);
  const engines: { calls: EngineCalls; engine: SyncEngine }[] = [];
  const switches: boolean[] = [];
  const state = { enabled: options.enabled ?? true };
  const service = createSyncService({
    clock,
    isEnabled: async () => state.enabled,
    setEnabled: async (value) => {
      state.enabled = value;
      switches.push(value);
    },
    foreground: app,
    connection: async () => (options.connection === undefined ? HUB : options.connection),
    connectionChanges: async () => () => undefined,
    feed: async () => {
      throw new Error("this service never opens a socket: the engine it is given is a fake");
    },
    engineFor: async () => {
      const made = fakeEngine();
      engines.push(made);
      return made.engine;
    },
    doorbellMs: 1000,
  });
  return { clock, store, app, services: { store }, engines, service, switches, switch: state };
}

/** Let every already-resolved promise of a service call run: five microtask turns are more than the two it takes. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

describe("the sync service's start conditions", () => {
  it("starts an engine when a hub is configured and this device's switch is on", async () => {
    const h = harness();
    await h.service.start(h.services);

    expect(h.engines).toHaveLength(1);
    expect(h.engines[0]?.calls.start).toBe(1);
    expect(h.service.running()).toBe(true);
    expect(h.service.view().running).toBe(true);
  });

  it("starts nothing while no hub is configured", async () => {
    const h = harness({ connection: null });
    await h.service.start(h.services);

    expect(h.engines).toHaveLength(0);
    expect(h.service.running()).toBe(false);
  });

  it("starts nothing while this device's switch is off", async () => {
    const h = harness({ enabled: false });
    await h.service.start(h.services);

    expect(h.engines).toHaveLength(0);
    expect(h.service.running()).toBe(false);
  });

  it("keeps one engine when start is called again", async () => {
    const h = harness();
    await h.service.start(h.services);
    await h.service.start(h.services);

    expect(h.engines).toHaveLength(1);
    expect(h.engines[0]?.calls.start).toBe(1);
  });
});

describe("the foreground signal", () => {
  it("runs a round when the app comes back to the foreground, and none when it leaves", async () => {
    const h = harness({ foreground: false });
    await h.service.start(h.services);
    const engine = h.engines[0];
    expect(engine).toBeDefined();
    expect(engine?.calls.syncNow).toBe(0);

    h.app.fire(true);
    expect(engine?.calls.syncNow).toBe(1);

    h.app.fire(false);
    expect(engine?.calls.syncNow).toBe(1);

    h.app.fire(true);
    expect(engine?.calls.syncNow).toBe(2);
  });
});

describe("the switch", () => {
  it("stops the engine when it goes off, and starts a new one when it comes back on", async () => {
    const h = harness();
    await h.service.start(h.services);
    const first = h.engines[0];

    await h.service.setEnabled(false);

    expect(h.switches).toEqual([false]);
    expect(first?.calls.stop).toBe(1);
    expect(h.service.running()).toBe(false);

    // Nothing runs a round while the switch is off, whatever the app does.
    h.app.fire(true);
    expect(first?.calls.syncNow).toBe(0);

    await h.service.setEnabled(true);

    expect(h.switches).toEqual([false, true]);
    expect(h.engines).toHaveLength(2);
    expect(h.service.running()).toBe(true);
  });

  it("stops the engine when the service is stopped", async () => {
    const h = harness();
    await h.service.start(h.services);
    const engine = h.engines[0];

    h.service.stop();

    expect(engine?.calls.stop).toBe(1);
    expect(h.service.running()).toBe(false);
  });
});

describe("the doorbell", () => {
  it("rings the engine once a beat while the outbox holds something", async () => {
    const h = harness();
    await h.service.start(h.services);
    const engine = h.engines[0];
    expect(engine?.calls.notifyLocalChange).toBe(0);

    // An empty outbox is not worth a round: the first beat finds nothing and the engine is not told.
    h.clock.advance(1000);
    await settle();
    expect(engine?.calls.notifyLocalChange).toBe(0);

    await h.store.setSetting("sync-roundtrip", 1);
    h.clock.advance(1000);
    await settle();
    expect(engine?.calls.notifyLocalChange).toBe(1);

    // A second beat with the same op still waiting rings again, which is what keeps a failed round retrying.
    h.clock.advance(1000);
    await settle();
    expect(engine?.calls.notifyLocalChange).toBe(2);
  });

  it("does not ring while the app is not in front of the reader", async () => {
    const h = harness({ foreground: false });
    await h.service.start(h.services);
    const engine = h.engines[0];
    await h.store.setSetting("sync-roundtrip", 1);

    h.clock.advance(1000);
    await settle();

    expect(engine?.calls.notifyLocalChange).toBe(0);
  });
});

describe("what the service answers", () => {
  it("reads the outbox itself when no engine exists", async () => {
    const h = harness({ enabled: false });
    await h.service.start(h.services);
    await h.store.setSetting("rate", 1.5);

    const status = await h.service.status();

    expect(status.pending).toBe(1);
    expect(status.state).toBe("idle");
    expect(status.lastSyncedAt).toBeNull();
  });

  it("hands the engine's own figures back while one exists", async () => {
    const h = harness();
    await h.service.start(h.services);

    expect(await h.service.status()).toEqual({ state: "idle", lastSyncedAt: 1, pending: 0 });
  });

  it("delegates ensureModel and notifyLocalChange, and answers null without an engine", async () => {
    const h = harness();
    await h.service.start(h.services);
    const engine = h.engines[0];

    h.service.notifyLocalChange();
    expect(engine?.calls.notifyLocalChange).toBe(1);
    expect(await h.service.ensureModel("f8c3bf62a9aa3e6fc1619c250e48abe7")).toBeNull();

    const stopped = harness({ enabled: false });
    await stopped.service.start(stopped.services);
    expect(await stopped.service.ensureModel("f8c3bf62a9aa3e6fc1619c250e48abe7")).toBeNull();
  });

  it("tells every subscriber the view, and stops telling one that has unsubscribed", async () => {
    const h = harness({ enabled: false });
    await h.service.start(h.services);
    const seen: boolean[] = [];
    const unsubscribe = h.service.subscribe((view) => seen.push(view.running));

    await h.service.setEnabled(true);
    unsubscribe();
    await h.service.setEnabled(false);

    // The subscriber hears its own first view, then the one the engine's arrival produced — and nothing after.
    expect(seen[0]).toBe(false);
    expect(seen[1]).toBe(true);
    expect(seen).toHaveLength(2);
  });
});
