/**
 * The Android app's sync wiring (F§8, F§10.4): this device's one engine, built from the app's own
 * composition.
 *
 * Everything U-058's engine cannot supply for itself is supplied here and nowhere else — the platform's
 * clock, React Native's own `WebSocket` wrapped into F§8.3's feed (a socket whose first message is F§11's
 * token), the app's foreground signal (React Native has no `navigator.onLine`, and this app runs no
 * background work, so the only honest answer to "may a round run" is "is the app in front of the reader"),
 * and the two halves of F§7.2's gzip container over `fflate`, because Hermes ships no `CompressionStream`
 * and `node:zlib` is not a thing on a device.
 *
 * Three things the contract fixes, and how this module keeps them:
 *
 * - **Sync is never a requirement.** An engine exists only when a hub is configured *and* this device's
 *   switch says yes, and every failure is a state rather than an exception: with sync off, or with a hub
 *   nobody can reach, the library, the reader and the importer work exactly as they do without it.
 * - **A round follows the reader.** F§8.3 asks a client to pull when the app comes back to the foreground,
 *   so a change to `active` calls `syncNow()`, and the same signal is what tells the engine a round is worth
 *   attempting at all. Nothing here runs in the background: the queue F§10.4 plays from advances without
 *   JavaScript, so a reader listening with the screen off is not waiting on this module, and F§8.3's
 *   five-minute round is the only timer this file owns.
 * - **A local write reaches the hub without a wire from every screen.** F§5.9's store raises no change
 *   event, and the screens that write to it — the importer, the library, an offline pin — are files frozen
 *   by the units that built them, so a one-second look at the outbox is what notices that something is
 *   waiting: the doorbell (U-059's own measurement, reproduced here because the store it reads is the same
 *   store). A write a caller *can* announce, the reader's own progress, rings it directly through
 *   `notifyLocalChange()` — which is U-061's patch to `player-context.tsx`.
 *
 * **No platform module is loaded when this module is imported.** The connection, the secure store, React
 * Native's `AppState` and `expo/fetch` are each reached inside the function that needs them, so the
 * package's own Node test program can import this file and drive it with fakes — the rule every platform
 * module in this app follows (U-046, U-047).
 *
 * **Where the switch lives.** It is a property of *this* device's connection, kept beside the connection in
 * the platform's secure store rather than as an F§5.9 `setting` record: a setting is exactly the kind of
 * thing F§8 carries to the reader's other devices, and one device turning sync off must not turn it off on
 * another. The store is the app's existing key-value store for the two values that describe this
 * installation's hub (U-045's `connection.ts`), and a boolean beside them is the same kind of fact.
 */

import {
  createSyncClient,
  createSyncEngine,
  type SyncEngine,
  type SyncFeedSocket,
  type SyncGunzip,
  type SyncGzip,
  type SyncStatus,
} from "@lectern/api-client";
import { MAX_PUSH_OPS, WsServerMessageSchema } from "@lectern/api-contract";
import type { Clock, DocumentModel, LibraryStore } from "@lectern/core";
import { gunzipSync, gzipSync, strFromU8, strToU8 } from "fflate";
import type { Connection } from "../connection";

/** F§8.3's feed path, on the socket scheme; U-057's route owns the server end. */
const FEED_PATH = "/v1/sync/ws";

/** Where this device's sync switch lives (see the module comment for why it is not a store record). */
export const SYNC_ENABLED_KEY = "lectern.sync-enabled";

/** How long the hub has to answer the feed's authentication before the attempt is given up on. */
const AUTH_DEADLINE_MS = 10_000;

/** How often the outbox is looked at: the doorbell's own beat, in milliseconds. */
const DOORBELL_MS = 1_000;

/** What a device that is not syncing reports. */
const IDLE_STATUS: SyncStatus = { state: "idle", lastSyncedAt: null, pending: 0 };

/** What the service needs from the app's composition: F§5.9's records, and the outbox beside them. */
export interface SyncServices {
  store: LibraryStore;
}

/**
 * The app's own foreground signal (F§8.3): whether the reader has the app in front of them right now, and
 * every later change to that. On this platform it is also the reachability signal — see the module comment.
 */
export interface ForegroundSource {
  /** Whether the app is in front of the reader right now. */
  now(): Promise<boolean>;
  /** Watch it; the listener runs on every change with the new answer, and the answer removes it. */
  watch(listener: (foreground: boolean) => void): Promise<() => void>;
}

/** The seams the app supplies and the engine cannot: a clock, a feed, a reachability signal, a listener. */
export interface SyncEngineSeams {
  /** Every timer and timestamp the engine reads (F§5.7). */
  clock: Clock;
  /** F§8.3's feed, authenticated by the caller that opens it. */
  openSocket: () => Promise<SyncFeedSocket>;
  /** Whether a hub can be reached at all, so a round of a device with no hub in front of it is not attempted. */
  isOnline: () => boolean;
  /** Told the status whenever it changes, which is what the card renders. */
  onStatus: (status: SyncStatus) => void;
}

/** What a screen shows about sync: whether this device is syncing at all, and what the engine last said. */
export interface SyncView {
  /** True while an engine exists — the switch is on and a hub is configured. */
  running: boolean;
  /** The engine's own three figures (F§8.2). */
  status: SyncStatus;
}

/** Everything the service touches that a caller may replace: the platform's own by default, fakes in a test. */
export interface SyncServiceOptions {
  /** The clock every timer and timestamp comes from. */
  clock?: Clock;
  /** Whether this device syncs at all, and how the switch writes itself. */
  isEnabled?: () => Promise<boolean>;
  setEnabled?: (value: boolean) => Promise<void>;
  /** Take the listener that runs when the app comes back to the foreground, and answer its remover. */
  foreground?: ForegroundSource;
  /** The hub connection F§11's two values describe, or `null` while none is configured. */
  connection?: () => Promise<Connection | null>;
  /** Take the listener that runs when the connection is saved, and answer its remover. */
  connectionChanges?: (listener: () => void) => Promise<() => void>;
  /** Authenticate F§8.3's feed for a hub: the socket the engine drives, once the hub has said `ready`. */
  feed?: (hubUrl: string, token: string) => Promise<SyncFeedSocket>;
  /** Build the engine. The app's own builder by default; a fake engine in a unit test. */
  engineFor?: (services: SyncServices, seams: SyncEngineSeams, connection: Connection) => Promise<SyncEngine>;
  /** How often the outbox is looked at. */
  doorbellMs?: number;
}

/**
 * `SyncService` — this device's half of F§8, as F§10.4's screens use it.
 *
 * `start` is what the root layout calls with the app's own store, `stop` is what the switch calls, and the
 * four members the contract names — `status`, `syncNow`, `ensureModel`, `notifyLocalChange` — are what the
 * settings card, the diagnostics check and the reader ask for. `subscribe` is how the card re-renders
 * without polling.
 */
export interface SyncService {
  /** Build and start the engine for this composition. Idempotent, and inert while the switch is off. */
  start(services: SyncServices): Promise<void>;
  /** Stop the engine and forget it. Every later call that needs one is inert. */
  stop(): void;
  /** Whether an engine exists right now. */
  running(): boolean;
  /** This device's switch, as it is stored. */
  enabled(): Promise<boolean>;
  /** Flip the switch: on starts the engine, off stops it. */
  setEnabled(value: boolean): Promise<void>;
  /** The engine's figures, read from the store itself when no engine exists. */
  status(): Promise<SyncStatus>;
  /** The current view, and every later one, until the listener is removed. */
  subscribe(listener: (view: SyncView) => void): () => void;
  /** The current view, without waiting. */
  view(): SyncView;
  /** Ask for a round and wait for it. Inert without an engine. */
  syncNow(): Promise<void>;
  /** F§8.2's lazy document body, or `null` when there is no engine or the hub holds no model. */
  ensureModel(docId: string): Promise<DocumentModel | null>;
  /** Tell the engine a local record changed. Inert without an engine. */
  notifyLocalChange(): void;
}

/** The platform's clock: the one place this module reads the time or schedules against it (F§5.7). */
const PLATFORM_CLOCK: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

/**
 * Whether this device syncs, as the switch is stored. A store that cannot be read — a device whose keystore
 * is unavailable — keeps F§8's default: yes, because a reader who has configured a hub asked for this.
 */
async function readEnabled(): Promise<boolean> {
  try {
    const secure = await import("expo-secure-store");
    return (await secure.getItemAsync(SYNC_ENABLED_KEY)) !== "false";
  } catch {
    return true;
  }
}

/** Write the switch. A store that refuses the write leaves the reader's answer where it was. */
async function writeEnabled(value: boolean): Promise<void> {
  try {
    const secure = await import("expo-secure-store");
    await secure.setItemAsync(SYNC_ENABLED_KEY, value ? "true" : "false");
  } catch {
    return;
  }
}

/** F§8.3's foreground signal over React Native's own `AppState`. */
const platformForeground: ForegroundSource = {
  now: async () => {
    const { AppState } = await import("react-native");
    return AppState.currentState === "active";
  },
  watch: async (listener) => {
    const { AppState } = await import("react-native");
    const subscription = AppState.addEventListener("change", (state) => listener(state === "active"));
    return () => subscription.remove();
  },
};

/** F§11's two values, read from the platform's secure store (U-045's `connection.ts`). */
async function appConnection(): Promise<Connection | null> {
  const connection = await import("../connection");
  return await connection.getConnection();
}

/** Told whenever a connection is saved, which is when this service may have something to do. */
async function appConnectionChanges(listener: () => void): Promise<() => void> {
  const connection = await import("../connection");
  return connection.onConnectionChanged(() => listener());
}

/**
 * F§7.2's model body: the JSON text as a gzip container, over `fflate` — the one compressor this platform
 * has.
 *
 * The signatures relied on, from the installed `fflate@0.8.3` (`esm/browser.d.ts`, the browser build Metro
 * resolves for this app):
 *
 *   gzipSync(data: Uint8Array, opts?: GzipOptions): Uint8Array<ArrayBuffer>
 *   gunzipSync<TArrayBuffer extends ArrayBufferLike = ArrayBuffer>(data: Uint8Array, opts?: GunzipOptions<TArrayBuffer>): Uint8Array<TArrayBuffer>
 *   strToU8(str: string, latin1?: boolean): Uint8Array<ArrayBuffer>
 *   strFromU8(dat: Uint8Array, latin1?: boolean): string
 */
const gzipText: SyncGzip = async (text) => gzipSync(strToU8(text));

/** F§7.2's model body read back: the container as the JSON text it holds. */
const gunzipText: SyncGunzip = async (bytes) => strFromU8(gunzipSync(bytes));

/** The feed's address for a hub's origin: F§8.3's own path, on the scheme a socket needs. */
function feedUrl(baseUrl: string): string {
  const url = new URL(FEED_PATH, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

/** F§8.3's first frame, read for the `rev` the hub reports when it accepts the authentication. */
function readyRev(text: string): number | null {
  let frame: unknown;
  try {
    frame = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const parsed = WsServerMessageSchema.safeParse(frame);
  return parsed.success && parsed.data.type === "ready" ? parsed.data.rev : null;
}

/**
 * F§8.3's feed over React Native's own `WebSocket`: authenticated, and answering once the hub has said
 * `ready`.
 *
 * The handshake is this function's business and not the engine's — F§11's token leaves as the socket's
 * *first message*, which is what U-057's route waits for — and a frame that arrives between `ready` and the
 * engine's own handler is buffered and replayed, because the engine wires its handlers up after the factory
 * resolves. A socket that closes or fails before the hub answers rejects here: the engine reads a rejected
 * factory as one failed attempt, and F§8.3's own ladder (1 s to 60 s, U-058) is what retries it.
 */
function platformFeed(hubUrl: string, token: string, clock: Clock): Promise<SyncFeedSocket> {
  const socket = new WebSocket(feedUrl(hubUrl));
  const buffered: string[] = [];
  let onMessage: ((text: string) => void) | null = null;
  let onClose: (() => void) | null = null;
  let authenticated = false;
  let over = false;

  const feed: SyncFeedSocket = {
    send: (text) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
    },
    close: () => socket.close(),
    onMessage: (handler) => {
      onMessage = handler;
      for (const frame of buffered.splice(0)) handler(frame);
    },
    onClose: (handler) => {
      onClose = handler;
      // A feed that died before the engine wired it up is still a feed the engine has to replace.
      if (over) handler();
    },
  };

  return new Promise<SyncFeedSocket>((resolve, reject) => {
    const deadline = clock.setTimeout(() => {
      if (!authenticated) reject(new Error("the hub did not answer the feed's authentication in time"));
    }, AUTH_DEADLINE_MS);

    /** The feed is over, one way or another: the deadline has nothing left to wait for, and the engine is told. */
    const finish = (): void => {
      if (over) return;
      over = true;
      clock.clearTimeout(deadline);
      onClose?.();
    };

    socket.onopen = () => socket.send(JSON.stringify({ type: "auth", token }));
    socket.onmessage = (event: MessageEvent<unknown>) => {
      const data: unknown = event.data;
      if (typeof data !== "string") return;
      if (!authenticated) {
        // A frame that is not F§8.3's `ready` is not the handshake; the hub closes on a refusal instead.
        if (readyRev(data) === null) return;
        authenticated = true;
        clock.clearTimeout(deadline);
        resolve(feed);
        return;
      }
      if (onMessage === null) buffered.push(data);
      else onMessage(data);
    };
    socket.onclose = () => {
      finish();
      if (!authenticated) reject(new Error("the feed closed before the hub authenticated it"));
    };
    socket.onerror = () => {
      finish();
      if (!authenticated) reject(new Error("the feed failed before the hub authenticated it"));
    };
  });
}

/**
 * This app's engine: F§7.2's sync client over the platform's own transport and the `fflate` pair above,
 * driven by F§8.2's round (U-058).
 *
 * The transport is `expo/fetch` rather than the JavaScript global, for the reason U-045 chose it for the hub
 * client: F§7.2's model bodies are bytes, and the platform's own implementation carries a `Uint8Array` as
 * bytes where the polyfill behind the global would coerce it to text.
 */
async function engineFrom(services: SyncServices, seams: SyncEngineSeams, connection: Connection): Promise<SyncEngine> {
  const { fetch: expoFetch } = await import("expo/fetch");
  const client = createSyncClient({
    baseUrl: connection.hubUrl,
    token: connection.token,
    // The token rides in a header of every call and never in a URL (F§11).
    fetch: expoFetch as unknown as typeof fetch,
    gzip: gzipText,
    gunzip: gunzipText,
  });
  return createSyncEngine({
    store: services.store,
    client,
    clock: seams.clock,
    openSocket: seams.openSocket,
    isOnline: seams.isOnline,
    gzip: gzipText,
    gunzip: gunzipText,
    onStatus: seams.onStatus,
  });
}

/**
 * `createSyncService({ … })` — this device's sync, with every platform API behind a seam.
 *
 * The seams are what let the behaviours the contract asks about be unit-tested without a device: a test
 * hands in its own switch, its own foreground source, its own connection, and an engine of its own making.
 */
export function createSyncService(options: SyncServiceOptions = {}): SyncService {
  const clock = options.clock ?? PLATFORM_CLOCK;
  const switchOn = options.isEnabled ?? readEnabled;
  const switchWrite = options.setEnabled ?? writeEnabled;
  const foreground = options.foreground ?? platformForeground;
  const readConnection = options.connection ?? appConnection;
  const watchConnection = options.connectionChanges ?? appConnectionChanges;
  const authenticate = options.feed ?? ((hubUrl: string, token: string) => platformFeed(hubUrl, token, clock));
  const build = options.engineFor ?? engineFrom;
  const beat = options.doorbellMs ?? DOORBELL_MS;

  let services: SyncServices | null = null;
  let engine: SyncEngine | null = null;
  let doorbell: number | null = null;
  let watches: (() => void)[] = [];
  let connectionWatch: (() => void) | null = null;
  let reachable = false;
  let latest: SyncStatus = IDLE_STATUS;
  const listeners = new Set<(view: SyncView) => void>();

  function view(): SyncView {
    return { running: engine !== null, status: latest };
  }

  /** Every listener is told the whole view, because "is it running" changes with the status. */
  function emit(): void {
    const current = view();
    for (const listener of listeners) listener(current);
  }

  /** The engine's own listener: keep the status, and let the card redraw. */
  function note(status: SyncStatus): void {
    latest = status;
    emit();
  }

  /**
   * How many ops the outbox holds. F§5.9's interface answers a page and no count, so the page is widened
   * until it comes back short — the same arithmetic U-058's `status()` does for the running engine.
   */
  async function outboxDepth(): Promise<number> {
    const store = services?.store;
    if (store === undefined) return 0;
    let limit = MAX_PUSH_OPS;
    for (;;) {
      const page = await store.pendingOps(limit);
      if (page.length < limit) return page.length;
      limit *= 2;
    }
  }

  /**
   * One beat of the doorbell: anything waiting in the outbox is worth a round. A store that cannot be read
   * has nothing to tell the engine, and the next beat looks again.
   */
  async function ring(): Promise<void> {
    const store = services?.store;
    if (store === undefined || engine === null || !reachable) return;
    void store
      .pendingOps(1)
      .then((waiting) => {
        if (waiting.length > 0) engine?.notifyLocalChange();
      })
      .catch(() => undefined);
  }

  function scheduleDoorbell(): void {
    doorbell = clock.setTimeout(() => {
      doorbell = null;
      void ring();
      if (engine !== null) scheduleDoorbell();
    }, beat);
  }

  /** Take the engine apart: its timers, its socket, and the watches this module holds for it. */
  function halt(): void {
    engine?.stop();
    engine = null;
    if (doorbell !== null) {
      clock.clearTimeout(doorbell);
      doorbell = null;
    }
    for (const stopWatching of watches) stopWatching();
    watches = [];
  }

  /**
   * Build the engine for the connection in force, and start it.
   *
   * The connection is read once and used for both halves of the subsystem — the client's base URL and token,
   * and the feed's handshake — so a hub saved mid-flight cannot have one half talking to the old address.
   */
  async function begin(): Promise<void> {
    const current = services;
    if (current === null || engine !== null) return;
    const connection = await readConnection();
    if (connection === null || !(await switchOn())) {
      emit();
      return;
    }
    reachable = await foreground.now();
    const seams: SyncEngineSeams = {
      clock,
      openSocket: async () => await authenticate(connection.hubUrl, connection.token),
      isOnline: () => reachable,
      onStatus: note,
    };
    const built = await build(current, seams, connection);
    engine = built;
    watches = [
      // F§8.3: a client pulls when the app comes back to the foreground.
      await foreground.watch((isForeground) => {
        reachable = isForeground;
        if (isForeground) void engine?.syncNow();
      }),
    ];
    scheduleDoorbell();
    emit();
    await built.start();
  }

  return {
    start: async (incoming) => {
      services = incoming;
      // One watcher for the service's life: a connection saved while nothing is running is what a reader
      // expects to start syncing, and `begin` re-reads the switch itself.
      if (connectionWatch === null) {
        connectionWatch = await watchConnection(() => {
          halt();
          void begin();
        });
      }
      if (engine !== null) return;
      await begin();
    },

    stop: () => {
      halt();
      emit();
    },

    running: () => engine !== null,

    enabled: switchOn,

    setEnabled: async (value) => {
      await switchWrite(value);
      if (!value) {
        halt();
        emit();
        return;
      }
      await begin();
    },

    status: async () => {
      if (engine !== null) return await engine.status();
      try {
        return { state: latest.state, lastSyncedAt: latest.lastSyncedAt, pending: await outboxDepth() };
      } catch {
        return latest;
      }
    },

    subscribe: (listener) => {
      listeners.add(listener);
      // A card that subscribes after the engine said something would otherwise draw nothing until the next
      // change, which for an idle device may be minutes away.
      listener(view());
      return () => listeners.delete(listener);
    },

    view,

    syncNow: async () => {
      await engine?.syncNow();
    },

    ensureModel: async (docId) => {
      if (engine === null) return null;
      return await engine.ensureModel(docId);
    },

    notifyLocalChange: () => {
      engine?.notifyLocalChange();
    },
  };
}

/** The app's one sync service (F§10.4): the root layout starts it, and the settings card reads it. */
export const syncService: SyncService = createSyncService();
