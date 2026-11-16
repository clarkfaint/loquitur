/**
 * F§5.8's `AudioQueueSink` over `expo-audio`'s audio playlist (F§10.4).
 *
 * The playlist is a *queue*, not a single track: sources are appended and the platform advances between them
 * by itself, so playback survives a throttled or backgrounded JavaScript thread. That is the whole reason this
 * sink holds no timer and polls nothing — it listens to the platform's own reports and translates them into
 * F§5.8's four events, with `queue-map.ts` deciding what each report means.
 *
 * Four of this platform's own numbers and rules are worth stating, because they are what the rest of Lectern
 * is built on:
 *
 * - **positions and durations are seconds** here and whole milliseconds everywhere else (F§5.6), so the
 *   conversion happens in exactly one place: `current()`;
 * - **the rate is bounded by the platform** to `0.1 … 2.0`, which is F§5.8's `maxRate = 2` for Android — above
 *   2× `planSpeed` (F§5.6(e)) moves the rest of the speed-up into synthesis, so one cached chunk still serves
 *   several rates;
 * - **pitch correction has no switch on a playlist.** The rate is applied by the platform's own time-stretcher,
 *   which keeps the pitch; only the single-item player carries a `shouldCorrectPitch` flag, and this unit uses
 *   the playlist. "Pitch correction left on" therefore means: set the rate and nothing else;
 * - **a rate reaches only the audio the platform has not written into its track yet** — the sink applies a
 *   speed change by draining the audio processors and taking the new parameters from the frame it lands on, so
 *   whatever is already buffered plays at the old speed. Measured on the device: a rate set after the first
 *   source had been prepared left the first ~340 ms of a chunk — one audio track's worth — at 1×, which is
 *   exactly what F§5.8's `setRate(2) roughly halves wall time` measures. The queue therefore holds the sources
 *   it was asked for until playback starts and the rate is known: see `handOverPending`.
 *
 * The platform module is loaded **when a sink is built, not when this module is imported**. The diagnostics
 * registry reaches this module (through `audio/diagnostics.ts`), and that registry is imported by the package's
 * Node test program, where `expo-audio` — and, through it, `react-native` — cannot be parsed. `createExpoBlobFs`
 * (U-046) is the same shape for the same reason, which is why building a sink is asynchronous.
 */

import type { AudioQueueSink, LibraryStore } from "@lectern/core";
import type { AudioPlaylist, AudioPlaylistStatus } from "expo-audio";
import { createQueueMap, NO_PREVIOUS_INDEX, type QueueMapEvent } from "./queue-map";

/** The setting that holds this platform's ceiling (F§5.8): the reader may lower it, and this is its name. */
export const SINK_MAX_RATE_SETTING = "sinkMaxRate";

/** What `sinkMaxRate` is worth when the reader has never set it, and F§5.8's ceiling for Android. */
export const DEFAULT_SINK_MAX_RATE = 2;

/** The slowest rate the platform's player accepts (its declared range is 0.1 … 2.0). */
const MIN_RATE = 0.1;

/** The rate the platform's player starts at, and the one a sink plays at until `setRate` says otherwise. */
const DEFAULT_RATE = 1;

/**
 * How often the playlist reports its position. F§5.6(d) draws the highlight at most every 50 ms on Android and
 * reads the position from `current()` rather than from these reports, so this is the rate at which *events*
 * arrive — a buffering state, or the end of the queue — and it is deliberately finer than the 500 ms default.
 */
const STATUS_INTERVAL_MS = 100;

/** The four events F§5.8 gives a sink. */
type SinkEvent = "chunk-start" | "chunk-end" | "queue-empty" | "error";

/** What a listener receives: the chunk an event is about, or the failure that produced it. */
type SinkListener = (event: { chunkId?: string; error?: Error }) => void;

/** One chunk as the sink needs it: the id the map files it under, and the file the platform plays. */
interface QueueItem {
  chunkId: string;
  uri: string;
}

/** F§5.8's sink, plus the native queue itself, which the lock-screen controls need (F§10.4). */
export interface ExpoQueueSink extends AudioQueueSink {
  /** The native queue this sink drives, for `audio-session.ts`'s now-playing controls. */
  readonly playlist: AudioPlaylist;
  /** Whether `dispose()` has run: the native queue is gone, and nothing may be asked of it again. */
  readonly disposed: boolean;
}

/** What a sink is built with. */
export interface ExpoQueueSinkOptions {
  /**
   * The ceiling `planSpeed` splits speeds against (F§5.8). It is the setting `sinkMaxRate`'s value, which
   * `readSinkMaxRate` reads; when it is not given, the setting's own default — 2× — is used.
   */
  maxRate?: number;
}

/**
 * `readSinkMaxRate(store)` — the ceiling this installation's settings ask for: the value stored under
 * `sinkMaxRate`, held inside what the platform can play (`1 … 2`), or the default when nothing usable is
 * stored. A stored value of the wrong kind reads as "not set" rather than as a rate no player would accept.
 */
export async function readSinkMaxRate(store: Pick<LibraryStore, "getSetting">): Promise<number> {
  const stored = await store.getSetting<unknown>(SINK_MAX_RATE_SETTING);
  return ceilingFor(stored);
}

/**
 * `createExpoQueueSink({ maxRate })` — F§5.8's sink over one native audio queue.
 *
 * The queue starts empty and is not playing; `enqueue` records a chunk and `play` starts it. Nothing here
 * starts playback by itself, which is what keeps Android's background-audio rule (F§10.4: playback begins from
 * a reader's tap) true by construction.
 */
export async function createExpoQueueSink(options: ExpoQueueSinkOptions = {}): Promise<ExpoQueueSink> {
  const audio: typeof import("expo-audio") = await import("expo-audio");

  const maxRate = ceilingFor(options.maxRate);
  const map = createQueueMap();
  const listeners = new Map<SinkEvent, Set<SinkListener>>();
  const playlist = audio.createAudioPlaylist({ updateInterval: STATUS_INTERVAL_MS, loop: "none" });
  let disposed = false;
  /** The rate this queue plays at: the platform's own default until `setRate` names another. */
  let rate = DEFAULT_RATE;
  /** The chunks asked for while nothing was playing, in the order they were asked for. */
  const pending: QueueItem[] = [];
  /** Whether any source has ever reached the platform — after that, `enqueue` goes straight to the queue. */
  let handedOver = false;

  /** Hand one event to every listener of its kind. */
  const emit = (event: SinkEvent, payload: { chunkId?: string; error?: Error } = {}): void => {
    const set = listeners.get(event);
    if (set === undefined) return;
    for (const listener of [...set]) listener(payload);
  };

  /** Hand the events one report implies to their listeners, in the order the map decided. */
  const report = (events: QueueMapEvent[]): void => {
    for (const event of events) {
      if (event.type === "queue-empty") emit("queue-empty");
      else emit(event.type, { chunkId: event.chunkId });
    }
  };

  /**
   * Put one chunk on the platform's queue, and file it with the map in the same breath: the map's index `i` is
   * the playlist's index `i`, and that is the only thing tying the platform's reports back to a chunk. A source
   * the map has not been told about is a report about an index it knows nothing about — the chunk never starts,
   * never ends, and `currentChunk()` answers `null` for the whole run.
   */
  const queueSource = (item: QueueItem): void => {
    map.append(item.chunkId);
    // The source is handed over as an object with a `uri` because that is the record the native module reads;
    // the file's own scheme (the blob cache's `file://` directory) is the platform's business.
    playlist.add({ uri: item.uri });
  };

  /**
   * Hand the platform everything the sink was asked for while the queue was idle, and remember that it now
   * owns the queue. The sources wait for playback rather than reaching the playlist inside `enqueue` for one
   * measured reason: the platform applies a rate change only to the audio it has not written to its track yet
   * (see this file's header), so a rate that arrives after the first source has been prepared leaves the audio
   * already buffered at 1×. Applying the rate and *then* queueing puts it in place for the initialization that
   * follows — which is what makes `setRate(2)` halve a whole chunk's wall time (F§5.8) rather than its second
   * half. The reader pays nothing for this: its own controller enqueues the window and starts the queue in the
   * same pass (F§5.7's `buffering → first chunk enqueued → playing`), so the platform prepares the first chunk
   * at the tap instead of a few milliseconds earlier.
   */
  const handOverPending = (): void => {
    handedOver = true;
    for (const item of pending) queueSource(item);
    pending.length = 0;
  };

  const subscriptions = [
    playlist.addListener("trackChanged", ({ previousIndex, currentIndex }) => {
      report(map.onTrackChanged(previousIndex, currentIndex));
    }),
    playlist.addListener("playlistStatusUpdate", (status) => {
      const failure = playbackFailure(status);
      if (failure !== null) {
        emit("error", { error: failure });
        return;
      }
      // The end of the queue arrives here and not as a track change: the index is still the item that
      // finished, so the report is passed on as an equal-index one.
      if (status.didJustFinish) report(map.onTrackChanged(status.currentIndex, status.currentIndex));
    }),
  ];

  return {
    maxRate,
    playlist,

    get disposed() {
      return disposed;
    },

    async enqueue(item) {
      if (disposed) return;
      // A queue that has not started yet holds the chunk back, in playback order, until `play`: see
      // `handOverPending` for why the rate has to be in place first.
      if (!handedOver) {
        pending.push({ chunkId: item.chunkId, uri: item.uri });
        return;
      }
      queueSource({ chunkId: item.chunkId, uri: item.uri });
    },

    async clear() {
      if (disposed) return;
      // Chunks that never reached the platform go with the ones that did: the queue is empty either way, and
      // the map is the only index into it that survives.
      pending.length = 0;
      map.reset();
      playlist.clear();
    },

    async play() {
      if (disposed) return;
      const starting = map.currentChunk() === null;
      if (!handedOver) {
        // The rate, and only then the queue: see `handOverPending`.
        playlist.playbackRate = rate;
        handOverPending();
      }
      playlist.play();
      if (!starting) return;
      // Nothing is playing, so this call either starts the chunk the queue is parked on or finds an empty
      // queue. The platform reports every *later* start as a track change, so this is the only start the sink
      // has to report itself.
      const events = map.onTrackChanged(NO_PREVIOUS_INDEX, playlist.currentIndex);
      if (events.length > 0) report(events);
      else if (playlist.trackCount === 0) emit("queue-empty");
    },

    async pause() {
      if (disposed) return;
      playlist.pause();
    },

    async seekInCurrent(ms) {
      if (disposed) return;
      await playlist.seekTo(ms / 1000);
    },

    setRate(next) {
      if (disposed) return;
      rate = Math.min(Math.max(next, MIN_RATE), maxRate);
      // Applied now for a rate change while a chunk is playing; re-applied in `play()` while the queue is still
      // idle, which is the application that matters — it lands before the platform prepares its first source.
      playlist.playbackRate = rate;
    },

    current() {
      const chunkId = map.currentChunk();
      if (chunkId === null) return { chunkId: null, positionMs: 0 };
      return { chunkId, positionMs: Math.round(playlist.currentTime * 1000) };
    },

    on(event, cb) {
      let set = listeners.get(event);
      if (set === undefined) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(cb);
      return () => {
        set.delete(cb);
      };
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const subscription of subscriptions) subscription.remove();
      listeners.clear();
      pending.length = 0;
      // `destroy` clears the lock-screen controls and drops the queue from the module; `release` detaches the
      // native object, which is what frees the player itself.
      playlist.destroy();
      playlist.release();
    },
  };
}

/**
 * A rate inside what the platform's player can do: at least 0.1, and never above F§5.8's ceiling for Android.
 * A value that is not a finite number reads as the default rather than as a rate no player would accept.
 */
function ceilingFor(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SINK_MAX_RATE;
  return Math.min(Math.max(value, 1), DEFAULT_SINK_MAX_RATE);
}

/**
 * The failure a status report carries, or `null` when it carries none.
 *
 * The module reports a playback failure as one extra member on an ordinary status report, so the declared
 * status shape does not name it: the field is read through the narrow type below, and a report without it is
 * an ordinary status. Both the member's name and its two fields come from the installed package's own Android
 * module (`AudioPlaylist.onPlayerError` → `sendStatusUpdate(mapOf("error" to …))`).
 */
function playbackFailure(status: AudioPlaylistStatus): Error | null {
  const failure = (status as AudioPlaylistStatus & { error?: { message?: string; code?: number } }).error;
  if (failure === undefined || failure === null) return null;
  return new Error(failure.message ?? `the audio queue failed (code ${failure.code ?? "unknown"})`);
}
