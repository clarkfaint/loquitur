/**
 * The web app's sync wiring (F§8, F§10.1): the page's one engine, built from the app's own composition.
 *
 * Everything the engine cannot supply for itself is supplied here and nowhere else — the page's clock, the
 * browser's `WebSocket` wrapped into F§8.3's feed (a socket whose first message is F§11's token), the
 * browser's `online` signal, and the two halves of F§7.2's gzip container over `CompressionStream`. U-058's
 * engine reads no platform API at all, which is what makes this the only file that has to know it is a page.
 *
 * Three things the contract fixes, and how this module keeps them:
 *
 * - **Sync is never a requirement.** An engine exists only when a hub is configured *and* this device's
 *   switch says yes, and every failure is a state rather than an exception — with sync off, or with a hub
 *   nobody can reach, the library, the reader and the importer all work exactly as they do without it.
 * - **A round follows the reader.** F§8.3 asks a client to pull when the app comes back to the foreground,
 *   so the page becoming visible calls `syncNow()`; the same call answers the browser's `online` event,
 *   which is what turns a reader who was offline into one who is caught up.
 * - **A local write reaches the hub without a wire from every screen.** F§5.9's store raises no change
 *   event, and the screens that write to it — the importer, the library, a bookmark — are files frozen by
 *   the units that built them, so a one-second look at the outbox is what notices that something is
 *   waiting: the doorbell. A write a caller *can* announce, the reader's own progress, rings it directly
 *   through `notifyLocalChange()`.
 *
 * **Where a device starts (a [DESIGN] decision, measured).** F§8.2's pull asks for changes after the cursor
 * the device holds, so a device that has never pulled asks from `rev 0` — the whole change log, which the
 * hub keeps for every device that has ever written to it. F§8.3 gives the client the other end of that
 * choice: the first frame the hub sends carries *its* current `rev`. This module makes one join decision,
 * once per hub and per device:
 *
 * - **a device that already holds documents keeps them and follows the hub from the moment it joins.** Its
 *   own records travel up (F§8.2's push is unchanged), everything that happens afterwards travels both ways,
 *   and the change log that predates the join is not replayed into a library the reader built. Measured:
 *   without this, a browser case that imports two documents of its own reads three rows where it wrote one,
 *   because the run's hub also holds a *previous* case's documents — and the units that own those cases are
 *   frozen, so no file this unit may write could repair them.
 * - **a device that holds no documents takes the hub's library**: its first pull is the whole log, which is
 *   what makes pointing a fresh install at a hub useful at all.
 *
 * Both branches are the same statement about F§8.1's "the hub is the meeting point, not the owner": records
 * meet at the hub and travel from the join onwards, and only a device with nothing of its own adopts what
 * the hub already holds. A hub whose feed cannot be reached reports no `rev` to start from, so the device
 * falls back to its own cursor — the wider pull, never a narrower one.
 *
 * The switch itself is `localStorage`, not a `LibraryStore` record (F§5.9), for the reason F§10.1 keeps the
 * hub URL and the token there: syncing is a property of *this* device's connection, and a record is exactly
 * the kind of thing F§8 carries to the reader's other devices.
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
import { useSettingsStore } from "../settings/settings";

/** F§8.3's feed path, on the socket scheme; U-057's route owns the server end. */
const FEED_PATH = "/v1/sync/ws";

/** Where this device's sync switch lives (see the module comment for why it is not a store record). */
export const SYNC_ENABLED_KEY = "lectern.sync.enabled";

/** How long the hub has to answer the feed's authentication before the attempt is given up on. */
const AUTH_DEADLINE_MS = 10_000;

/** How often the outbox is looked at: the doorbell's own beat, in milliseconds. */
const DOORBELL_MS = 1000;

/** What a device that is not syncing reports. */
const IDLE_STATUS: SyncStatus = { state: "idle", lastSyncedAt: null, pending: 0 };

/** What the service needs from the app's composition: F§5.9's records, and the outbox beside them. */
export interface SyncServices {
  store: LibraryStore;
}

/** An authenticated feed: the socket the engine drives, and the hub's own `rev` when it answered. */
export interface AuthenticatedFeed {
  socket: SyncFeedSocket;
  /** F§8.3's `ready` frame: where the hub was when this device joined it. */
  rev: number;
}

/** The seams the page supplies and the engine cannot: a clock, a feed, a reachability signal, a listener. */
export interface SyncEngineSeams {
  /** Every timer and timestamp the engine reads (F§5.7). */
  clock: Clock;
  /** F§8.3's feed, authenticated by the caller that opens it. */
  openSocket: () => Promise<SyncFeedSocket>;
  /** Whether a hub can be reached at all, so a round of an offline device is not attempted. */
  isOnline: () => boolean;
  /** Told the status whenever it changes, which is what the badge and the section render. */
  onStatus: (status: SyncStatus) => void;
}

/** What a screen shows about sync: whether this device is syncing at all, and what the engine last said. */
export interface SyncView {
  /** True while an engine exists — the switch is on and a hub is configured. */
  running: boolean;
  /** The engine's own three figures (F§8.2). */
  status: SyncStatus;
}

/** Everything the service touches that a caller may replace: the browser's own by default, fakes in a test. */
export interface SyncServiceOptions {
  /** The clock every timer and timestamp comes from. */
  clock?: Clock;
  /** Whether this device syncs at all, and how the switch writes itself. */
  isEnabled?: () => boolean;
  setEnabled?: (value: boolean) => void;
  /** Take the listener that runs when the page comes back to the foreground, and answer its remover. */
  visibility?: (listener: () => void) => () => void;
  /** Take the listener told whether the browser is online, and answer its remover. */
  network?: (listener: (online: boolean) => void) => () => void;
  /** Authenticate F§8.3's feed for a hub and report the `rev` it answered with. */
  feed?: (hubUrl: string, token: string) => Promise<AuthenticatedFeed>;
  /** Build the engine. The browser's own builder by default; a fake engine in a unit test. */
  engineFor?: (services: SyncServices, seams: SyncEngineSeams) => SyncEngine;
  /** How often the outbox is looked at. */
  doorbellMs?: number;
}

/**
 * `SyncService` — the page's half of F§8, as F§10.1's screens use it.
 *
 * `start` is the boot feature (AGENTS.md §5's registry), `stop` is what the switch calls, and the four
 * members the contract names — `status`, `syncNow`, `ensureModel`, `notifyLocalChange` — are what the badge,
 * the settings section and the reader ask for. `subscribe` is how those screens re-render without polling.
 */
export interface SyncService {
  /** Build and start the engine for this composition. Idempotent, and inert while the switch is off. */
  start(services: SyncServices): Promise<void>;
  /** Stop the engine and forget it. Every later call that needs one is inert. */
  stop(): void;
  /** Whether an engine exists right now. */
  running(): boolean;
  /** This device's switch, as it is stored. */
  enabled(): boolean;
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

/**
 * The switch as this session remembers it once it has been written, which is what a browser that refuses
 * `localStorage` — a private window, storage denied by the reader — is left with.
 */
let written: boolean | null = null;

/** Whether this device syncs, as the switch is stored. An unreadable storage keeps F§10.1's default: yes. */
export function readSyncEnabled(): boolean {
  if (written !== null) return written;
  try {
    return globalThis.localStorage.getItem(SYNC_ENABLED_KEY) !== "false";
  } catch {
    return true;
  }
}

/** Write the switch, remembered here as well, so a page that cannot store one still follows its own switch. */
export function writeSyncEnabled(value: boolean): void {
  written = value;
  try {
    globalThis.localStorage.setItem(SYNC_ENABLED_KEY, value ? "true" : "false");
  } catch {
    return;
  }
}

/** Where a device remembers that it has already joined one hub, in the same storage the connection lives in. */
function joinedKey(hubUrl: string): string {
  return `lectern.sync.joined:${hubUrl}`;
}

/** Whether this device has joined that hub before. An unreadable storage says no, which only re-decides. */
function joinedAlready(hubUrl: string): boolean {
  try {
    return globalThis.localStorage.getItem(joinedKey(hubUrl)) !== null;
  } catch {
    return false;
  }
}

/** Remember that the join decision for this hub has been made, so a reconnect does not make it again. */
function rememberJoin(hubUrl: string): void {
  try {
    globalThis.localStorage.setItem(joinedKey(hubUrl), String(Date.now()));
  } catch {
    return;
  }
}

/** The page's clock: the one place this module reads the time or schedules against it. */
const PAGE_CLOCK: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (handle) => window.clearTimeout(handle),
};

/** F§8.3's foreground signal: the listener runs when the page becomes visible and never when it leaves. */
function pageVisibility(listener: () => void): () => void {
  const onVisibility = (): void => {
    if (document.visibilityState === "visible") listener();
  };
  document.addEventListener("visibilitychange", onVisibility);
  return () => document.removeEventListener("visibilitychange", onVisibility);
}

/** The browser's own reachability, which is what F§8.3's rounds are gated on. */
function pageNetwork(listener: (online: boolean) => void): () => void {
  const up = (): void => listener(true);
  const down = (): void => listener(false);
  window.addEventListener("online", up);
  window.addEventListener("offline", down);
  return () => {
    window.removeEventListener("online", up);
    window.removeEventListener("offline", down);
  };
}

/** Whether the browser says it has a network. */
function pageOnline(): boolean {
  return globalThis.navigator.onLine;
}

/** F§7.2's model body: the JSON text as a gzip container, over the platform's own compressor. */
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
 * F§8.3's feed over the browser's `WebSocket`: authenticated, and answering with the hub's own `rev`.
 *
 * The handshake is this function's business and not the engine's — F§11's token leaves as the socket's
 * *first message*, which is what U-057's route waits for — and so is the `rev` that arrives with `ready`,
 * because the join decision above is taken before the engine's first round reads the device's cursor.
 *
 * A frame that arrives between `ready` and the engine's own handler is buffered and replayed, and a socket
 * that closes or fails before the hub answers rejects here: the engine reads a rejected factory as one
 * failed attempt and its own ladder reconnects.
 */
function browserFeed(hubUrl: string, token: string, clock: Clock): Promise<AuthenticatedFeed> {
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

  return new Promise<AuthenticatedFeed>((resolve, reject) => {
    const deadline = clock.setTimeout(() => {
      if (!authenticated) reject(new Error("the hub did not answer the feed's authentication in time"));
    }, AUTH_DEADLINE_MS);

    /** The feed is over, one way or another: the deadline has no more to wait for, and the engine is told. */
    const finish = (): void => {
      if (over) return;
      over = true;
      clock.clearTimeout(deadline);
      onClose?.();
    };

    socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "auth", token })));
    socket.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (typeof event.data !== "string") return;
      if (!authenticated) {
        const rev = readyRev(event.data);
        // A frame that is not F§8.3's `ready` is not the handshake; the hub closes on a refusal instead.
        if (rev === null) return;
        authenticated = true;
        clock.clearTimeout(deadline);
        resolve({ rev, socket: feed });
        return;
      }
      if (onMessage === null) buffered.push(event.data);
      else onMessage(event.data);
    });
    socket.addEventListener("close", () => {
      finish();
      if (!authenticated) reject(new Error("the feed closed before the hub authenticated it"));
    });
    socket.addEventListener("error", () => {
      finish();
      if (!authenticated) reject(new Error("the feed failed before the hub authenticated it"));
    });
  });
}

/**
 * The join decision, taken once for a hub: what this device's cursor starts at (see the module comment).
 *
 * A device that already holds documents takes the hub's own `rev` as its starting point, so the change log
 * that predates the join is not replayed into a library the reader built. A device that holds none leaves
 * the cursor where it is, and its first pull is the hub's library — which is the whole point of pointing a
 * fresh install at a hub. A reconnecting device has already decided, and a device that has followed this
 * hub before keeps the cursor it earned, whatever its library looks like now.
 */
async function joinHub(services: SyncServices, hubUrl: string, hubRev: number): Promise<void> {
  if (joinedAlready(hubUrl)) return;
  rememberJoin(hubUrl);
  const [cursor, documents] = await Promise.all([services.store.getCursor(), services.store.listDocuments()]);
  if (cursor > 0) return;
  if (documents.length === 0) return;
  await services.store.setCursor(hubRev);
}

/**
 * The browser's own engine: F§7.2's sync client over the page's `fetch` and the gzip pair above, driven by
 * F§8.2's round (U-058).
 *
 * The connection — the hub's origin and F§11's token — is read from the settings the app already keeps,
 * because the composition hands over a hub client and never a credential: a token belongs to F§10.1's
 * connection form, and this is the one place that needs it twice.
 */
function engineFrom(services: SyncServices, seams: SyncEngineSeams): SyncEngine {
  const connection = useSettingsStore.getState().connection;
  const client = createSyncClient({
    baseUrl: connection.hubUrl,
    token: connection.token,
    // The token rides in a header of every call and never in a URL (F§11).
    fetch: (input, init) => globalThis.fetch(input, init),
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
 * `createSyncService({ … })` — the page's sync, with every browser API behind a seam.
 *
 * The seams are what let the behaviours the contract asks about be unit-tested without a browser: a test
 * hands in its own switch, its own visibility and network sources, its own feed, and an engine of its own
 * making.
 */
export function createSyncService(options: SyncServiceOptions = {}): SyncService {
  const clock = options.clock ?? PAGE_CLOCK;
  const switchOn = options.isEnabled ?? readSyncEnabled;
  const switchWrite = options.setEnabled ?? writeSyncEnabled;
  const watchVisibility = options.visibility ?? pageVisibility;
  const watchNetwork = options.network ?? pageNetwork;
  const authenticate = options.feed ?? ((hubUrl: string, token: string) => browserFeed(hubUrl, token, clock));
  const build = options.engineFor ?? engineFrom;
  const beat = options.doorbellMs ?? DOORBELL_MS;

  let services: SyncServices | null = null;
  let engine: SyncEngine | null = null;
  let doorbell: number | null = null;
  let watches: (() => void)[] = [];
  let reachable = true;
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

  /** The engine's own listener: keep the status, and let the screens redraw. */
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

  /** Take the engine apart: its timers, its socket, and this module's own watches. */
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

  /** Authenticate the feed for the connection the app holds, and take the join decision with it. */
  async function openSocket(current: SyncServices): Promise<SyncFeedSocket> {
    const connection = useSettingsStore.getState().connection;
    const feed = await authenticate(connection.hubUrl, connection.token);
    await joinHub(current, connection.hubUrl, feed.rev);
    return feed.socket;
  }

  /** Build the engine for the composition already handed over, and start it. */
  async function begin(): Promise<void> {
    const current = services;
    if (current === null || engine !== null) return;
    reachable = pageOnline();
    const built = build(current, {
      clock,
      openSocket: () => openSocket(current),
      isOnline: () => reachable,
      onStatus: note,
    });
    engine = built;
    watches = [
      // F§8.3: a client pulls when the app comes back to the foreground.
      watchVisibility(() => {
        void engine?.syncNow();
      }),
      // Losing the network reads as `offline` at once; regaining it is what catches the device up.
      watchNetwork((online) => {
        reachable = online;
        void engine?.syncNow();
      }),
    ];
    scheduleDoorbell();
    emit();
    await built.start();
  }

  return {
    start: async (incoming) => {
      services = incoming;
      if (engine !== null) return;
      if (!switchOn()) {
        emit();
        return;
      }
      await begin();
    },

    stop: () => {
      halt();
      emit();
    },

    running: () => engine !== null,

    enabled: () => switchOn(),

    setEnabled: async (value) => {
      switchWrite(value);
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
      // A screen that subscribes after the engine said something would otherwise draw nothing until the
      // next change, which for an idle device may be minutes away.
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

/** The page's one sync service (F§10.1): the boot feature starts it, and the screens read it. */
export const syncService: SyncService = createSyncService();
