/**
 * The reader's playback (F§10.1, F§5.7): the one place the web app builds a `PlayerController`.
 *
 * The controller is used exactly as U-013 froze it — this hook supplies the four things it needs and nothing
 * else: the browser's audio sink (F§5.8), F§5.8's chunk source over the hub client and the cache (U-021), a
 * document provider reading the frozen library store (F§5.9), and the page's own clock. Everything the reader
 * sees is then derived from one snapshot:
 *
 * - the word being read, sampled per frame while audio moves and read once per change otherwise, which is
 *   F§5.6(d)'s highlight clock;
 * - the progress fraction and the time remaining, from F§5.6(f)'s own arithmetic in `@lectern/core`;
 * - `baseWpm`, the running average of the pace the voice actually manages, updated from the wall time each
 *   sentence takes (see the note below);
 * - the bus, which the hook **hosts**: every snapshot is published for a mini-player or a second tab, and every
 *   command they send is executed here, because this is the page that owns the audio.
 *
 * Progress is persisted through the store as F§5.9's `progress` record — at most once every two seconds while
 * audio is moving, and at once whenever playback settles or the page is hidden, which is the rule the contract
 * sets. The position written is the word being read, so a reload returns the reader to the word they left.
 */

import {
  type Clock,
  createPlayerController,
  type DocumentModel,
  type LibraryStore,
  type PlayerCommand,
  type PlayerController,
  type PlayerSettings,
  type PlayerSnapshot,
  type PlayerState,
  type Position,
  progressFraction,
  remainingMs as remainingTimeMs,
  sentenceAt,
  updateBaseWpm,
} from "@lectern/core";
import type { Voice } from "@lectern/core-tts";
import {
  createBroadcastChannelTransport,
  createDesktopBridgeTransport,
  createHtmlAudioQueueSink,
  createPlayerBus,
  getDesktopBridge,
  PLAYER_CHANNEL,
  type PlayerBus,
  type TextPosition,
} from "@lectern/ui-web";
import { useCallback, useEffect, useRef, useState } from "react";
import { getServices } from "../services";
import { useSettingsStore } from "../settings/settings";
import { syncService } from "../sync/sync-service";

/** What a reader's screen gets from the player. */
export interface PlayerView {
  /** What the player is doing right now (F§5.7). */
  snapshot: PlayerSnapshot;
  /** The word being read, or `null` before anything has been loaded (F§5.6(d)). */
  active: TextPosition | null;
  /** The voices the hub offers (F§6); empty while the hub has not answered. */
  voices: Voice[];
  /** How far through the document playback is, from 0 to 1 (F§5.6(f)). */
  progressFraction: number;
  /** Time left in the document, in milliseconds (F§5.6(f)). */
  remainingMs: number;
  /** The reader's own pace in words per minute (F§5.6(f)). */
  baseWpm: number;
  /** The document, once the library has answered for it. */
  document: DocumentModel | null;
  /** True when the library holds no live document with this id. */
  notFound: boolean;
  /** A failure that happened before a player existed — an unreadable library, say. */
  problem: string | null;
  /** Where a user action goes. */
  dispatch: (command: PlayerCommand) => void;
}

/** The state a screen starts in, before the controller has said anything. */
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

/** The states a reader's position is settled in, and therefore worth writing down at once. */
const SETTLED_STATES: readonly PlayerState[] = ["ready", "paused", "ended", "error"];

/** How often progress is written while audio is moving — the contract's own ceiling. */
const PROGRESS_INTERVAL_MS = 2000;

/** F§5.6(f)'s seed for the reader's own pace, before any chunk has been measured. */
const BASE_WPM_SEED = 170;

/** The page's clock: the one place the controller reads the time or schedules against it (F§5.7). */
const CLOCK: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (handle) => window.clearTimeout(handle),
};

/** How many words a sentence holds, or none when the document has no such sentence. */
function wordsIn(document: DocumentModel | null, sentenceIndex: number): number {
  if (document === null) return 0;
  try {
    return sentenceAt(document, sentenceIndex).words.length;
  } catch {
    return 0;
  }
}

/** One sentence's playback, as the pace measurement sees it: which sentence, and when it started. */
interface SentenceClock {
  sentenceIndex: number;
  startedAt: number;
}

export function usePlayer(docId: string): PlayerView {
  const preferences = useSettingsStore((state) => state.preferences);
  const [snapshot, setSnapshot] = useState<PlayerSnapshot>(IDLE_SNAPSHOT);
  const [active, setActive] = useState<TextPosition | null>(null);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [model, setModel] = useState<DocumentModel | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [baseWpm, setBaseWpm] = useState(BASE_WPM_SEED);

  const controllerRef = useRef<PlayerController | null>(null);
  const busRef = useRef<PlayerBus | null>(null);
  const storeRef = useRef<LibraryStore | null>(null);
  const modelRef = useRef<DocumentModel | null>(null);
  const baseWpmRef = useRef(BASE_WPM_SEED);
  const paceRef = useRef<SentenceClock | null>(null);
  const lastWriteRef = useRef(0);
  const appliedSkipRef = useRef(preferences.skipFurniture);

  // The three settings the controller reads while it works are kept in one object it holds, so a change
  // reaches the next chunk (or the next document load) without rebuilding the player.
  const settingsRef = useRef<PlayerSettings>({
    skipFurniture: preferences.skipFurniture,
    skipCitations: preferences.skipCitations,
    lookaheadMs: preferences.lookaheadMs,
  });

  useEffect(() => {
    settingsRef.current.skipFurniture = preferences.skipFurniture;
    settingsRef.current.skipCitations = preferences.skipCitations;
    settingsRef.current.lookaheadMs = preferences.lookaheadMs;
  }, [preferences.lookaheadMs, preferences.skipCitations, preferences.skipFurniture]);

  /**
   * Write F§5.9's progress record for the word being read, unless one was written a moment ago.
   *
   * A written position is also F§8's own business: the reader announces it through the sync service, which
   * rings the engine for the round that carries it. Inert with sync off, like every other call into it.
   */
  const writeProgress = useCallback(
    (force: boolean): void => {
      const controller = controllerRef.current;
      const store = storeRef.current;
      if (controller === null || store === null) return;
      const at = Date.now();
      if (!force && at - lastWriteRef.current < PROGRESS_INTERVAL_MS) return;
      lastWriteRef.current = at;
      const word = controller.activeWord();
      const written = { docId, sentenceIndex: word.sentenceIndex, wordIndex: word.wordIndex, updatedAt: at };
      void store.setProgress(written).catch(() => undefined);
      syncService.notifyLocalChange();
    },
    [docId],
  );

  const dispatch = useCallback((command: PlayerCommand): void => {
    void controllerRef.current?.dispatch(command);
  }, []);

  // One player per document: build it, hand it the document and the restored position, and take it apart when
  // the route moves on.
  useEffect(() => {
    let live = true;
    let unsubscribe: (() => void) | null = null;
    let beat = 0;

    const build = async (): Promise<void> => {
      const services = await getServices();
      if (!live) return;
      storeRef.current = services.store;

      let loaded = await services.store.getDocumentModel(docId);
      if (!live) return;
      if (loaded === null) {
        // F§8.2's lazy body: a document that arrived from another device as a record alone has no model on
        // this one yet, so the hub's own copy is asked for through the sync service — which answers `null`
        // for a device with sync off or no hub, leaving the reader exactly as it was before sync existed.
        loaded = await syncService.ensureModel(docId);
        if (!live) return;
      }
      if (loaded === null) {
        setNotFound(true);
        return;
      }
      modelRef.current = loaded;
      setModel(loaded);
      setNotFound(false);

      // A chunk with no voice is refused by the hub (F§6), so the voices are asked for before playback can be
      // asked for, and the reader's saved voice — or the hub's first — is chosen here.
      let offered: Voice[] = [];
      try {
        offered = await services.client.voices();
      } catch {
        offered = [];
      }
      if (!live) return;
      setVoices(offered);

      const controller = createPlayerController({
        sink: createHtmlAudioQueueSink(),
        chunks: services.chunks,
        documents: { get: (id) => services.store.getDocumentModel(id) },
        clock: CLOCK,
        settings: settingsRef.current,
      });
      controllerRef.current = controller;

      /** Publish the player's state for every remote, with the figures their own bar draws. */
      const publish = (next: PlayerSnapshot): void => {
        const bus = busRef.current;
        const document = modelRef.current;
        if (bus === null || document === null) return;
        const word = controller.activeWord();
        const where: Position = { docId: next.docId ?? docId, sentenceIndex: next.sentenceIndex, wordIndex: next.wordIndex };
        bus.publish({
          ...next,
          title: document.title,
          active: { sentenceIndex: word.sentenceIndex, wordIndex: word.wordIndex },
          progressFraction: progressFraction(document, where),
          remainingMs: remainingTimeMs(document, where, next.rate, baseWpmRef.current),
          baseWpm: baseWpmRef.current,
        });
      };

      /**
       * Measure the pace of the voice from the wall time a sentence takes.
       *
       * F§5.6(f) averages `60000 · words / durationMs` over chunks played with the current voice. The web
       * sink's ceiling is 16, so `planSpeed` never moves a rate below it to synthesis and the chunk's media
       * duration is the wall time it was heard for, times the rate it was heard at.
       */
      const measurePace = (next: PlayerSnapshot): void => {
        if (next.state !== "playing") {
          paceRef.current = null;
          return;
        }
        const at = Date.now();
        const previous = paceRef.current;
        if (previous !== null && previous.sentenceIndex !== next.sentenceIndex) {
          const words = wordsIn(modelRef.current, previous.sentenceIndex);
          baseWpmRef.current = updateBaseWpm(baseWpmRef.current, words, (at - previous.startedAt) * next.rate);
          setBaseWpm(baseWpmRef.current);
        }
        paceRef.current = { sentenceIndex: next.sentenceIndex, startedAt: at };
      };

      unsubscribe = controller.subscribe((next) => {
        setSnapshot(next);
        measurePace(next);
        publish(next);
      });

      const bridge = getDesktopBridge();
      const bus = createPlayerBus(
        bridge === null ? createBroadcastChannelTransport(PLAYER_CHANNEL) : createDesktopBridgeTransport(bridge),
        "host",
      );
      bus.onCommand((command) => {
        // The host executes what a remote asked for: this page owns the audio (F§10.1).
        void controller.dispatch(command);
      });
      busRef.current = bus;

      // A remote that opens later has missed every earlier change, so the current state is published once a
      // second as well: F§10.1's bus defines no handshake for a tab that arrives after the reading started.
      beat = window.setInterval(() => publish(controller.snapshot()), 1000);

      const saved = useSettingsStore.getState().preferences;
      const voiceId = saved.voiceId === "" ? (offered[0]?.id ?? "") : saved.voiceId;
      if (voiceId !== "") await controller.dispatch({ type: "setVoice", voiceId });
      await controller.dispatch({ type: "setRate", rate: saved.rate });

      const restored = await services.store.getProgress(docId);
      await controller.dispatch({
        type: "load",
        docId,
        position: { docId, sentenceIndex: restored?.sentenceIndex ?? 0, wordIndex: restored?.wordIndex ?? 0 },
      });
    };

    void build().catch((cause: unknown) => {
      if (live) setProblem(cause instanceof Error ? cause.message : String(cause));
    });

    return () => {
      live = false;
      window.clearInterval(beat);
      unsubscribe?.();
      busRef.current?.dispose();
      busRef.current = null;
      const controller = controllerRef.current;
      controllerRef.current = null;
      modelRef.current = null;
      void controller?.dispose();
    };
  }, [docId]);

  // F§5.6(d): the highlight clock. Per frame while audio moves, and once per change otherwise, so a restored
  // or seeked position is painted without playback having to start.
  useEffect(() => {
    const controller = controllerRef.current;
    if (controller === null) return;
    const paint = (): void => {
      const word = controller.activeWord();
      setActive((previous) =>
        previous !== null && previous.sentenceIndex === word.sentenceIndex && previous.wordIndex === word.wordIndex ? previous : word,
      );
    };
    paint();
    if (snapshot.state !== "playing" && snapshot.state !== "buffering") return;
    let frame = 0;
    const step = (): void => {
      paint();
      writeProgress(false);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [snapshot, writeProgress]);

  // Pause, stop, the end of a document and a failure all settle the position, so it is written at once.
  useEffect(() => {
    if (!SETTLED_STATES.includes(snapshot.state)) return;
    writeProgress(true);
  }, [snapshot.state, writeProgress]);

  // A closed or hidden tab is the last chance to keep the reader's place (F§5.9).
  useEffect(() => {
    const onHide = (): void => writeProgress(true);
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") writeProgress(true);
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [writeProgress]);

  // Whether furniture is read at all is decided once per document load (F§5.7's playback order), so a change
  // to the setting rebuilds the order at the position the reader is on.
  useEffect(() => {
    const changed = appliedSkipRef.current !== preferences.skipFurniture;
    appliedSkipRef.current = preferences.skipFurniture;
    if (!changed) return;
    const controller = controllerRef.current;
    if (controller === null) return;
    const state = controller.snapshot().state;
    if (state === "idle" || state === "loading") return;
    const word = controller.activeWord();
    void controller.dispatch({ type: "load", docId, position: { docId, sentenceIndex: word.sentenceIndex, wordIndex: word.wordIndex } });
  }, [docId, preferences.skipFurniture]);

  const position: Position = { docId, sentenceIndex: snapshot.sentenceIndex, wordIndex: snapshot.wordIndex };

  return {
    snapshot,
    active,
    voices,
    progressFraction: model === null ? 0 : progressFraction(model, position),
    remainingMs: model === null ? 0 : remainingTimeMs(model, position, snapshot.rate, baseWpm),
    baseWpm,
    document: model,
    notFound,
    problem,
    dispatch,
  };
}
