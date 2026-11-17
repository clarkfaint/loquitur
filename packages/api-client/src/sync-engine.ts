/**
 * The sync engine (F§8.2, F§8.3): the round, the three clocks that start one, and the feed that tells it
 * when another device has written.
 *
 * Everything it touches arrives as an argument — the store, the client, the clock, the socket factory and
 * the online signal — so this module reads no platform API at all. `window`, `navigator`, `AppState` and the
 * host's own timers are each a caller's business, which is what lets one engine run in a browser tab, an
 * extension worker, an Electron process and a React Native screen.
 *
 * Three properties the contract fixes, and how this module keeps them:
 *
 * - **One round at a time, and a burst is one follow-up.** A request that arrives while a round is running
 *   is not a second round: it sets one flag, and the round in flight runs it once more before it finishes.
 * - **A cursor moves only over applied changes.** F§8.2's cursor is stored after `applyRemote` has resolved
 *   and never before, so a pull that fails halfway leaves the cursor where the store's records really are
 *   and the next round re-applies the page — which last-writer-wins makes a no-op.
 * - **Ops leave the outbox only when the hub says so.** `ackOps` is handed exactly the `accepted` list of
 *   F§8.2's push answer, so a request that never arrived leaves the outbox intact. The hub ignores an `opId`
 *   it has already seen (F§8.2), which is what makes the replay of a lost answer safe.
 *
 * Two decisions the contract leaves to this module:
 *
 * - **The device id comes off the outbox.** F§5.9 stamps every op with the device that made it and the store
 *   interface exposes no identity of its own, so a round pushes under the deviceId of the ops it is sending —
 *   which is the same string for every op of one store.
 * - **The socket factory owns the handshake.** F§8.3's first message carries F§11's token, and this engine
 *   is handed a client and never a credential: the factory a caller supplies points at the hub's feed and
 *   authenticates it, and hands the engine a socket it can already send `pong` on and read `ready` from.
 */

import { MAX_PULL_LIMIT, MAX_PUSH_OPS, type WsServerMessage, WsServerMessageSchema } from "@lectern/api-contract";
import type { Clock, DocumentModel, LibraryStore, Op } from "@lectern/core";
import { HubClientError } from "./errors";
import type { SyncClient, SyncGunzip, SyncGzip } from "./sync-client";

/** F§8.3's reconnect ladder: the first wait, and the ceiling every later one is clamped to. */
const FEED_BASE_DELAY_MS = 1_000;
const FEED_MAX_DELAY_MS = 60_000;

/** F§8.2's local-change debounce: a round runs this long after the last edit it was told about. */
const LOCAL_CHANGE_DELAY_MS = 2_000;

/** F§8.3's own clock: a client also pulls this often whether or not anything told it to. */
const PERIODIC_ROUND_MS = 300_000;

/** The four states a caller shows, and the one it has to be able to act on (F§8.2's failures). */
export type SyncState = "idle" | "syncing" | "offline" | "error";

/** What a caller can say about the engine without asking the store itself. */
export interface SyncStatus {
  state: SyncState;
  /** The clock's reading at the end of the last round that reached the hub, or `null` before the first. */
  lastSyncedAt: number | null;
  /** How many ops the outbox holds — what the next round would send, or what is waiting behind a failure. */
  pending: number;
}

/**
 * One connected change feed (F§8.3), as the engine uses it: frames of text in both directions.
 *
 * The engine owns the protocol — it parses what arrives against F§8.3's message schema and answers a `ping`
 * with a `pong` — so a socket is a transport and nothing more. A caller wraps a platform's WebSocket around
 * this interface, which is also where the handshake belongs: see the module comment.
 */
export interface SyncFeedSocket {
  /** Send one frame: the JSON text of a message F§8.3 defines. */
  send(text: string): void;
  /** Close the feed. */
  close(): void;
  /** Take the handler every arriving frame is handed to. */
  onMessage(handler: (text: string) => void): void;
  /** Take the handler that runs when the feed closes under the engine's feet. */
  onClose(handler: () => void): void;
}

/** A socket factory, which a caller supplies when it wants the feed at all. */
export type SyncFeedFactory = () => SyncFeedSocket | Promise<SyncFeedSocket>;

/** What an engine is built from: its store and client, its clock, and the feed it may be given. */
export interface SyncEngineOptions {
  store: LibraryStore;
  client: SyncClient;
  /** The injected clock (F§5.7): every timer and `lastSyncedAt` reading comes from it, never the host's. */
  clock: Clock;
  /** The feed, when the caller wants one. Without it the engine syncs on its own clocks alone. */
  openSocket?: SyncFeedFactory;
  /** Whether a hub can be reached at all; defaults to a signal that always says yes. */
  isOnline?: () => boolean;
  /**
   * The compression pair, accepted so a caller may hand one to both halves of the subsystem. The engine
   * itself compresses nothing: F§7.2's model bodies are (de)compressed by `createSyncClient`, whose own
   * pair is injected there.
   */
  gzip?: SyncGzip;
  gunzip?: SyncGunzip;
  /** Told the status every time it changes, so a caller does not have to poll `status()`. */
  onStatus?: (status: SyncStatus) => void;
}

/** F§8.2's round and F§8.3's feed, as one object a caller starts and stops. */
export interface SyncEngine {
  /** Open the feed, run one round, and begin the two clocks. Idempotent. */
  start(): Promise<void>;
  /** Cancel every timer and close the feed. A stopped engine runs no further round, ever. */
  stop(): void;
  /**
   * Ask for a round and wait for it. A request that arrives while a round is running is coalesced into the
   * one follow-up round that round runs before it finishes, and this promise settles with it.
   */
  syncNow(): Promise<void>;
  /** Tell the engine a local record changed: a round runs F§8.2's two seconds later, and once per burst. */
  notifyLocalChange(): void;
  /**
   * F§8.2's lazy document body: the model from the store when it is there, otherwise the hub's own copy,
   * stored and answered. `null` means the hub holds no model for that document. A hub that refuses or cannot
   * be reached rejects here rather than answering `null`, because those are different facts to a reader.
   */
  ensureModel(docId: string): Promise<DocumentModel | null>;
  /** What a caller shows: the state, the last clean round, and the depth of the outbox. */
  status(): Promise<SyncStatus>;
}

/**
 * `createSyncEngine({ store, client, clock, openSocket?, isOnline?, gzip?, gunzip?, onStatus? })` — every
 * device's half of F§8.
 *
 * A round never throws: a failure is a state (`offline` for a hub that could not be reached, `error` for
 * anything else) and leaves the outbox and the cursor exactly where they were, because F§8.2's two facts —
 * what was pushed and what was applied — are only ever moved by an answer the hub actually sent.
 */
export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const { store, client, clock } = options;

  let state: SyncState = "idle";
  let lastSyncedAt: number | null = null;
  let started = false;
  let stopped = false;
  let followUp = false;
  let inFlight: Promise<void> | null = null;
  let socket: SyncFeedSocket | null = null;
  let localHandle: number | null = null;
  let periodicHandle: number | null = null;
  let reconnectHandle: number | null = null;
  let feedFailures = 0;

  /**
   * How many ops the outbox holds. F§5.9's interface offers a page and no count, so the page is widened
   * until it comes back short — which is the only way to answer a number rather than a page size.
   */
  async function pendingCount(): Promise<number> {
    let limit = MAX_PUSH_OPS;
    for (;;) {
      const page = await store.pendingOps(limit);
      if (page.length < limit) return page.length;
      limit *= 2;
    }
  }

  async function statusOf(): Promise<SyncStatus> {
    return { state, lastSyncedAt, pending: await pendingCount() };
  }

  /**
   * Record a state and tell the listener. The store is read only when somebody is listening: a status
   * nobody asked for should not cost a page of the outbox on every transition.
   */
  function setState(next: SyncState): void {
    state = next;
    const listener = options.onStatus;
    if (listener === undefined) return;
    void statusOf().then(listener);
  }

  /** F§7.2's failure read as a state: a hub that could not be reached is `offline`, anything else `error`. */
  function failureState(cause: unknown): SyncState {
    return cause instanceof HubClientError && cause.offline ? "offline" : "error";
  }

  /**
   * F§8.2's first step: the model of every `document` put this batch carries, uploaded before the op that
   * names it. A document whose model the store does not hold — one that arrived as a record only, or a
   * tombstone — is skipped, because the hub's records and its files are separate (F§8.4) and its library
   * routes refuse a model that describes another document.
   */
  async function uploadModels(ops: readonly Op[]): Promise<void> {
    for (const op of ops) {
      if (op.entity !== "document" || op.kind !== "put") continue;
      const model = await store.getDocumentModel(op.entityId);
      if (model === null) continue;
      await client.putModel(op.entityId, model);
    }
  }

  /**
   * One round, in F§8.2's order: upload models → push → pull → pull again while another page is waiting. It
   * answers whether the round reached the hub at all, which is what tells `offline` apart from `idle`.
   *
   * A round that has nothing to push still pulls. An empty outbox is not a push with no ops — that shape is
   * refused by F§8's own request schema — so the two are one branch apart.
   */
  async function oneRound(): Promise<boolean> {
    if (options.isOnline !== undefined && !options.isOnline()) {
      setState("offline");
      return false;
    }
    const pending = await store.pendingOps(MAX_PUSH_OPS);
    const firstOp = pending[0];
    if (firstOp !== undefined) {
      await uploadModels(pending);
      const answer = await client.push(firstOp.deviceId, pending);
      await store.ackOps(answer.accepted);
    }
    let since = await store.getCursor();
    for (;;) {
      const page = await client.pull(since, MAX_PULL_LIMIT);
      await store.applyRemote(page.changes);
      await store.setCursor(page.nextRev);
      since = page.nextRev;
      if (!page.more) break;
    }
    lastSyncedAt = clock.now();
    return true;
  }

  /** One round, followed by the single follow-up round a burst of requests is coalesced into. */
  async function runRound(): Promise<void> {
    if (stopped) return;
    setState("syncing");
    try {
      let reachedHub = false;
      do {
        followUp = false;
        reachedHub = await oneRound();
        // A round that never reached the hub has nothing to follow up on: the device is offline.
      } while (followUp && reachedHub && !stopped);
      setState(reachedHub ? "idle" : "offline");
    } catch (cause) {
      setState(failureState(cause));
    }
  }

  /**
   * Ask for a round. While one is running this is not a second round but the flag that makes the round in
   * flight run once more, and the promise a caller waits on is that whole chain — so a caller that asks
   * during a round is still asking for the change it just made to have been pushed by the time it returns.
   */
  function requestRound(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (inFlight !== null) {
      followUp = true;
      return inFlight;
    }
    const chain = runRound().finally(() => {
      inFlight = null;
    });
    inFlight = chain;
    return chain;
  }

  /** F§8.3's ladder: 1 s, 2 s, 4 s … clamped at 60 s, counted from the last failure. */
  function scheduleReconnect(): void {
    if (stopped || reconnectHandle !== null) return;
    const delay = Math.min(FEED_BASE_DELAY_MS * 2 ** feedFailures, FEED_MAX_DELAY_MS);
    feedFailures += 1;
    reconnectHandle = clock.setTimeout(() => {
      reconnectHandle = null;
      void connect();
    }, delay);
  }

  /** One arriving frame, as F§8.3 defines the three the hub sends. */
  function handleMessage(text: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      return;
    }
    const parsed = WsServerMessageSchema.safeParse(payload);
    if (!parsed.success) return;
    const message: WsServerMessage = parsed.data;
    if (message.type === "ping") {
      socket?.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (message.type === "changed") {
      void requestRound();
      return;
    }
    // `ready`: the feed is authenticated and the hub is answering, so the ladder starts over.
    feedFailures = 0;
  }

  /** One socket, opened and wired. A factory that rejects is a failed attempt like any other. */
  async function connect(): Promise<void> {
    const factory = options.openSocket;
    if (stopped || factory === undefined) return;
    let opened: SyncFeedSocket;
    try {
      opened = await factory();
    } catch {
      scheduleReconnect();
      return;
    }
    if (stopped) {
      opened.close();
      return;
    }
    socket = opened;
    opened.onMessage(handleMessage);
    opened.onClose(() => {
      if (socket !== opened) return;
      socket = null;
      scheduleReconnect();
    });
  }

  /**
   * F§8.3's own timer: a round every five minutes whether or not anything asked for one, rescheduled from
   * each tick so the interval never drifts with the engine's own work.
   */
  function schedulePeriodic(): void {
    if (stopped || periodicHandle !== null) return;
    periodicHandle = clock.setTimeout(() => {
      periodicHandle = null;
      void requestRound();
      schedulePeriodic();
    }, PERIODIC_ROUND_MS);
  }

  return {
    start: async () => {
      if (started || stopped) return;
      started = true;
      schedulePeriodic();
      await connect();
      await requestRound();
    },

    stop: () => {
      stopped = true;
      for (const handle of [localHandle, periodicHandle, reconnectHandle]) {
        if (handle !== null) clock.clearTimeout(handle);
      }
      localHandle = null;
      periodicHandle = null;
      reconnectHandle = null;
      socket?.close();
      socket = null;
    },

    syncNow: requestRound,

    notifyLocalChange: () => {
      if (stopped || localHandle !== null) return;
      localHandle = clock.setTimeout(() => {
        localHandle = null;
        void requestRound();
      }, LOCAL_CHANGE_DELAY_MS);
    },

    ensureModel: async (docId) => {
      const held = await store.getDocumentModel(docId);
      if (held !== null) return held;
      const fetched = await client.getModel(docId);
      if (fetched === null) return null;
      const meta = await store.getDocumentMeta(docId);
      if (meta !== null) await store.putDocument(meta, fetched);
      return fetched;
    },

    status: statusOf,
  };
}
