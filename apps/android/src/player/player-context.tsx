/**
 * The reader's player (F§5.7, F§5.6(f), F§10.4).
 *
 * One provider owns one document's playback: it builds F§5.7's controller over the four boundaries the
 * controller is written against — U-047's audio queue, a caching chunk source over the hub client and the blob
 * cache, a store-backed document provider, and the platform's own clock — and hands the screens below it the
 * snapshot to draw, the commands to send, the voices to offer and the two numbers of F§5.6(f)'s progress.
 *
 * Four things this file does that the controller deliberately does not:
 *
 * - **It writes the reader's place.** F§5.9 keeps one `progress` record per document, and this unit writes it
 *   at most every 2 s while audio is moving and once more whenever the player settles — a pause, the end of the
 *   document, a failure or the reader leaving the screen. The write is the controller's *active* word, not the
 *   sentence it last announced, so a reader who comes back lands where they stopped listening.
 * - **It keeps the lock screen current.** F§10.4's media session shows what is being read, so the document's
 *   title and the sentence now playing are handed to U-047's `setNowPlaying` every time the sentence changes,
 *   and taken back when the screen goes away.
 * - **It measures the voice's pace.** F§5.6(f)'s `baseWpm` is a running average of `60000 · words / durationMs`
 *   over chunks played with the current voice, seeded at 170, and the time remaining is computed from it. The
 *   wrapper below learns each chunk's word count from its own timings and its duration from the queue's report,
 *   which is the only place both numbers are known together.
 * - **It survives a hub that is not configured.** Reading text needs no hub, so the document still loads and the
 *   reader still draws; only the chunk source refuses, and its refusal is F§5.7's `error` state with the retry
 *   button, which is a sentence the reader can act on rather than a screen that quietly does nothing.
 *
 * The three settings the controller reads while it works (`skipFurniture`, `skipCitations`, `lookaheadMs`) are
 * held in one object the controller keeps, and the reader's own preferences are read from F§5.9's store before
 * the document is loaded. `lookaheadMs` defaults to F§5.6(d)'s 80 ms for Android.
 */

import { createCachingChunkSource, type HubClient } from "@lectern/api-client";
import {
  type AudioQueueSink,
  type ChunkSource,
  createPlayerController,
  type DocumentModel,
  type DocumentProvider,
  type LibraryStore,
  type PlayerCommand,
  type PlayerController,
  type PlayerSettings,
  type PlayerSnapshot,
  type Position,
  progressFraction,
  remainingMs,
  sentenceAt,
  updateBaseWpm,
} from "@lectern/core";
import type { Voice } from "@lectern/core-tts";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { clearNowPlaying, configureAudioSession, setNowPlaying } from "../audio/audio-session";
import { createExpoQueueSink, type ExpoQueueSink, readSinkMaxRate } from "../audio/expo-queue-sink";
import { createClient } from "../connection";
import { getStores } from "../stores";
import { syncService } from "../sync/sync-service";

/** How long the player is when nothing is loaded (F§5.7's `idle`). */
const IDLE_SNAPSHOT: PlayerSnapshot = {
  state: "idle",
  docId: null,
  sentenceIndex: 0,
  wordIndex: 0,
  rate: 1,
  voiceId: null,
  sleepRemainingMs: null,
  error: null,
};

/** F§5.9's progress record is written at most this often while audio is moving (the contract's 2 s). */
const PROGRESS_INTERVAL_MS = 2000;

/** How often F§5.6(f)'s two numbers are recomputed while playing: the bar moves, the text does not. */
const PROGRESS_SAMPLE_MS = 500;

/** F§5.6(f)'s seed for the running average, before any chunk of this voice has been played. */
const BASE_WPM_SEED = 170;

/** F§5.6(d)'s `lookaheadMs` for Android, and this contract's default. */
export const DEFAULT_LOOKAHEAD_MS = 80;

/** The states in which audio is moving: the states that write progress, sample it and follow the highlight. */
const MOVING_STATES: readonly string[] = ["playing", "buffering"];

/** The state a settled player pauses in, which is the one that writes the reader's place at once. */
const SETTLED_STATES: readonly string[] = ["paused", "ended", "error"];

/** The store keys the reader's playback preferences live under (F§5.9's `setting` records). */
export const RATE_SETTING = "rate";
export const VOICE_SETTING = "voiceId";
export const SKIP_FURNITURE_SETTING = "skipFurniture";
export const SKIP_CITATIONS_SETTING = "skipCitations";
export const LOOKAHEAD_SETTING = "lookaheadMs";

/** F§5.6(f)'s two numbers, as the player bar draws them. */
export interface PlayerProgress {
  fraction: number;
  remainingMs: number;
}

/** Everything a reader screen asks of the player. */
export interface PlayerView {
  /** F§5.7's controller, for the one thing the snapshot cannot answer: the word under the clock. */
  controller: PlayerController | null;
  /** F§5.7's snapshot: the state, the position, the rate, the voice, the sleep timer and the failure. */
  snapshot: PlayerSnapshot;
  /** The document being read, or `null` while it is still loading. */
  model: DocumentModel | null;
  /** F§6's voices, grouped by the sheets; empty while none could be listed. */
  voices: Voice[];
  /** F§5.6(f)'s fraction and time remaining at the rate in force. */
  progress: PlayerProgress;
  /** Whether the library holds no document with this id. */
  notFound: boolean;
  /** Why nothing can be read yet — a hub that is not configured, a voice list that could not be listed. */
  problem: string | null;
  /** Send one command to the controller (F§5.7). */
  dispatch(command: PlayerCommand): void;
}

/** The player in force for the reader screen below it. */
const PlayerContext = createContext<PlayerView | null>(null);

/** The message of a thrown value, which is what a reader is shown. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The platform's clock, which is the only clock the controller may read (F§5.7). */
const PLATFORM_CLOCK = {
  now: (): number => Date.now(),
  setTimeout: (callback: () => void, delayMs: number): number => setTimeout(callback, delayMs),
  clearTimeout: (handle: number): void => clearTimeout(handle),
};

/** The word count a chunk reads, taken from the timings it carries one per word (F§5.6). */
function wordsIn(chunk: { timings: readonly unknown[] }): number {
  return chunk.timings.length;
}

/**
 * The two boundaries F§5.6(f)'s pace is measured across, wrapped around the real ones.
 *
 * The chunk source is what knows how many words a chunk reads, the queue is what reports how long it took, and
 * neither knows both: so a resolved chunk is remembered by its id, and the report that the queue finished it
 * closes the measurement. Everything else is forwarded untouched — the player sees the same sink and the same
 * source it built, plus one average it does not know about.
 */
function withPace(source: ChunkSource, sink: AudioQueueSink): { chunks: ChunkSource; sink: AudioQueueSink; baseWpm(): number } {
  const played = new Map<string, { words: number; durationMs: number }>();
  let baseWpm = BASE_WPM_SEED;

  const chunks: ChunkSource = {
    async get(request) {
      const chunk = await source.get(request);
      played.set(chunk.chunkId, { words: wordsIn(chunk), durationMs: chunk.durationMs });
      return chunk;
    },
  };

  const pacedSink: AudioQueueSink = {
    get maxRate() {
      return sink.maxRate;
    },
    enqueue: (item) => sink.enqueue(item),
    clear: () => sink.clear(),
    play: () => sink.play(),
    pause: () => sink.pause(),
    seekInCurrent: (ms) => sink.seekInCurrent(ms),
    setRate: (rate) => sink.setRate(rate),
    current: () => sink.current(),
    dispose: () => sink.dispose(),
    on: (event, callback) => {
      if (event !== "chunk-end") return sink.on(event, callback);
      return sink.on("chunk-end", (payload) => {
        const finished = payload.chunkId === undefined ? undefined : played.get(payload.chunkId);
        if (finished !== undefined) baseWpm = updateBaseWpm(baseWpm, finished.words, finished.durationMs);
        callback(payload);
      });
    },
  };

  return { chunks, sink: pacedSink, baseWpm: () => baseWpm };
}

/** The sentence with a global index, as text, or `null` when the document has none (F§5.1). */
function sentenceText(doc: DocumentModel, sentenceIndex: number): string | null {
  try {
    return sentenceAt(doc, sentenceIndex).text;
  } catch {
    // A position restored from the library can name a sentence a re-tokenized document no longer has.
    return null;
  }
}

export interface PlayerProviderProps {
  /** The document to read (F§5.1's `docId`). */
  docId: string;
  /** Whether playback starts as soon as the document is loaded — the reader screen's `?autoplay=1`. */
  autoplay: boolean;
  children: ReactNode;
}

/**
 * `PlayerProvider` — build one player for one document and hand it to the screens below.
 *
 * The player is built once per `docId`: the effect that builds it takes it apart again when the route moves on,
 * which is what releases the audio queue and takes the lock screen back.
 */
export function PlayerProvider({ docId, autoplay, children }: PlayerProviderProps) {
  const [controller, setController] = useState<PlayerController | null>(null);
  const [snapshot, setSnapshot] = useState<PlayerSnapshot>(IDLE_SNAPSHOT);
  const [model, setModel] = useState<DocumentModel | null>(null);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [progress, setProgress] = useState<PlayerProgress>({ fraction: 0, remainingMs: 0 });
  const [notFound, setNotFound] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const modelRef = useRef<DocumentModel | null>(null);
  const storeRef = useRef<LibraryStore | null>(null);
  const sinkRef = useRef<ExpoQueueSink | null>(null);
  const controllerRef = useRef<PlayerController | null>(null);
  const paceRef = useRef<number>(BASE_WPM_SEED);
  const lastWriteRef = useRef(0);

  /** F§5.6(f)'s two numbers, at the word the clock is on right now. */
  const refreshProgress = useCallback((current: PlayerController): void => {
    const doc = modelRef.current;
    if (doc === null) return;
    const word = current.activeWord();
    const position: Position = { docId: doc.docId, sentenceIndex: word.sentenceIndex, wordIndex: word.wordIndex };
    const rate = current.snapshot().rate;
    setProgress({ fraction: progressFraction(doc, position), remainingMs: remainingMs(doc, position, rate, paceRef.current) });
  }, []);

  /** Write F§5.9's progress record for the word being read, unless one was written a moment ago. */
  const writeProgress = useCallback((current: PlayerController, force: boolean): void => {
    const store = storeRef.current;
    const doc = modelRef.current;
    if (store === null || doc === null) return;
    const at = Date.now();
    if (!force && at - lastWriteRef.current < PROGRESS_INTERVAL_MS) return;
    lastWriteRef.current = at;
    const word = current.activeWord();
    void store
      .setProgress({ docId: doc.docId, sentenceIndex: word.sentenceIndex, wordIndex: word.wordIndex, updatedAt: at })
      // F§8.2: the reader's place is the one local write this file can announce, so the sync service is told
      // about it directly rather than waiting for its own look at the outbox.
      .then(() => syncService.notifyLocalChange())
      .catch(() => undefined);
  }, []);

  const dispatch = useCallback((command: PlayerCommand): void => {
    void controllerRef.current?.dispatch(command);
  }, []);

  useEffect(() => {
    let live = true;
    let unsubscribe: (() => void) | null = null;
    let beat: ReturnType<typeof setInterval> | null = null;

    const build = async (): Promise<void> => {
      const stores = await getStores();
      if (!live) return;
      storeRef.current = stores.store;

      // F§8.2's lazy document body: a record can arrive from the reader's other device before its text does,
      // so a document whose model is missing locally asks the sync service for it once — the hub's copy,
      // stored — and only a document the hub holds no model for either is "not found".
      const loaded = (await stores.store.getDocumentModel(docId)) ?? (await syncService.ensureModel(docId));
      if (!live) return;
      if (loaded === null) {
        setNotFound(true);
        return;
      }
      modelRef.current = loaded;
      setModel(loaded);
      setNotFound(false);

      // The reader's own preferences come from F§5.9's store, so a voice and a speed chosen on another screen
      // (or another device) are the ones this document is read with.
      const settings: PlayerSettings = {
        skipFurniture: (await stores.store.getSetting<boolean>(SKIP_FURNITURE_SETTING)) ?? true,
        skipCitations: (await stores.store.getSetting<boolean>(SKIP_CITATIONS_SETTING)) ?? true,
        lookaheadMs: (await stores.store.getSetting<number>(LOOKAHEAD_SETTING)) ?? DEFAULT_LOOKAHEAD_MS,
      };
      if (!live) return;

      // A hub that is not configured is not a reason to refuse to draw the document: text is already local, and
      // only a chunk has to come from somewhere. The refusal becomes the chunk source's own, so the reader sees
      // it through F§5.7's error state and its retry button.
      let client: HubClient | null = null;
      let refusal: string | null = null;
      try {
        client = await createClient();
      } catch (cause) {
        refusal = messageOf(cause);
      }
      if (!live) return;

      const chunks: ChunkSource =
        client === null
          ? {
              get: async () => {
                throw new Error(refusal ?? "the hub is not configured yet");
              },
            }
          : createCachingChunkSource({ client, cache: stores.cache });

      let offered: Voice[] = [];
      if (client !== null) {
        try {
          offered = await client.voices();
        } catch (cause) {
          refusal = messageOf(cause);
        }
      }
      if (!live) return;
      setVoices(offered);
      setProblem(refusal);

      const sink: ExpoQueueSink = await createExpoQueueSink({ maxRate: await readSinkMaxRate(stores.store) });
      if (!live) {
        await sink.dispose();
        return;
      }
      sinkRef.current = sink;
      // F§10.4: audio keeps playing while the app is in the background, and the session does not mix.
      await configureAudioSession();

      const paced = withPace(chunks, sink);
      paceRef.current = BASE_WPM_SEED;
      const documents: DocumentProvider = { get: (id) => stores.store.getDocumentModel(id) };
      const player = createPlayerController({ sink: paced.sink, chunks: paced.chunks, documents, clock: PLATFORM_CLOCK, settings });
      controllerRef.current = player;
      setController(player);

      let lastSentence = -1;
      unsubscribe = player.subscribe((next) => {
        setSnapshot(next);
        paceRef.current = paced.baseWpm();
        refreshProgress(player);
        if (MOVING_STATES.includes(next.state)) writeProgress(player, false);
        if (SETTLED_STATES.includes(next.state)) writeProgress(player, true);
        if (next.sentenceIndex !== lastSentence) {
          lastSentence = next.sentenceIndex;
          const text = sentenceText(loaded, next.sentenceIndex);
          if (text !== null) setNowPlaying(sink, { title: loaded.title, subtitle: text });
        }
      });

      // The bar's own numbers move with the word, not with the sentence, so they are resampled while playing —
      // well below the 20 Hz the *highlight* is capped at, because the bar is not the highlight.
      beat = setInterval(() => {
        const state = player.snapshot().state;
        if (MOVING_STATES.includes(state)) refreshProgress(player);
      }, PROGRESS_SAMPLE_MS);

      // F§6: a chunk with no voice is refused, so the reader's saved voice — or the hub's first — is chosen
      // before the document is loaded, and the rate before the first chunk is asked for.
      const savedVoice = (await stores.store.getSetting<string>(VOICE_SETTING)) ?? "";
      const voiceId = savedVoice === "" ? (offered[0]?.id ?? "") : savedVoice;
      if (voiceId !== "") await player.dispatch({ type: "setVoice", voiceId });
      await player.dispatch({ type: "setRate", rate: (await stores.store.getSetting<number>(RATE_SETTING)) ?? 1 });

      const restored = await stores.store.getProgress(docId);
      await player.dispatch({
        type: "load",
        docId,
        position: {
          docId,
          sentenceIndex: restored?.sentenceIndex ?? 0,
          wordIndex: restored?.wordIndex ?? 0,
        },
      });
      if (!live) return;
      if (autoplay) await player.dispatch({ type: "play" });
    };

    void build().catch((cause: unknown) => {
      if (live) setProblem(messageOf(cause));
    });

    return () => {
      live = false;
      if (beat !== null) clearInterval(beat);
      unsubscribe?.();
      const player = controllerRef.current;
      controllerRef.current = null;
      if (player !== null) {
        // The reader's place is written once more before the player goes: a pause writes it anyway, but a
        // screen that is left while playing has no pause to rely on.
        writeProgress(player, true);
        void player.dispose();
      }
      clearNowPlaying();
      const sink = sinkRef.current;
      sinkRef.current = null;
      if (sink !== null) void sink.dispose();
      setController(null);
    };
  }, [docId, autoplay, refreshProgress, writeProgress]);

  const value: PlayerView = { controller, snapshot, model, voices, progress, notFound, problem, dispatch };
  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

/** The player the reader screen is inside. */
export function usePlayer(): PlayerView {
  const value = useContext(PlayerContext);
  if (value === null) throw new Error("usePlayer must be used inside a PlayerProvider");
  return value;
}
