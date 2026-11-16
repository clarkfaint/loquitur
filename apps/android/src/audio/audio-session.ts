/**
 * The app's audio session and its lock-screen controls (F§10.4).
 *
 * Two declarations belong to the app rather than to a sink, and both are made once per run:
 *
 * - `configureAudioSession()` sets F§10.4's mode: audio keeps playing while the app is in the background, it does
 *   not mix — a reader's audio pauses for a phone call instead of talking over it — and it *plays in silent
 *   mode*. The platform's own defaults are the ones Lectern wants for everything else (nothing is routed to the
 *   earpiece, recording is off), so only those three are named.
 *
 * **`playsInSilentMode` has to be named, and that is not a style choice.** The module's Android mode record
 * declares `playsInSilentMode = true`, but its JavaScript wrapper builds the record with *every* field and fills
 * in the ones a caller left out as `undefined`, so the platform sees a field that is present-and-false rather
 * than an absent one and takes its default. Measured on the device: with `playsInSilentMode` omitted, the module
 * refuses to start playback at all — `playWithAudioFocus` returns before touching the player whenever
 * `playsInSilentMode` is false *and* the platform's ringer mode is not `RINGER_MODE_NORMAL` — which is exactly
 * the state a phone in Do Not Disturb is in: `AudioManager.getRingerMode()` answers the *external* ringer mode,
 * which Zen mode reports as `SILENT` even though the device's own (internal) mode is `NORMAL`. Every sink the
 * app builds was silent under it: the playlist stalled at 0 ms, no chunk ever finished, and Android's media
 * session never left `NONE`. Naming the field is what makes F§10.4's "silent mode still plays" true.
 * - `setNowPlaying(sink, { title, subtitle })` hands the queue to the lock screen: play/pause and
 *   previous/next sentence, which is F§10.4's control list. The platform shows one owner at a time, so the
 *   queue that was handed over is remembered and `clearNowPlaying()` takes it back. **The queue is activated
 *   once; every later sentence only updates the metadata** — see that function for the measurement that makes
 *   this necessary.
 *
 * The lock-screen controls are what make sustained background playback possible on Android at all — the
 * platform stops audio that has no media session behind it after a few minutes — so a reader who leaves the
 * app gets the same reading in the notification shade.
 *
 * The platform module is loaded inside `configureAudioSession`, not at import time, for the reason
 * `expo-queue-sink.ts` gives: the diagnostics registry reaches this module from a Node test program, where
 * `expo-audio` cannot be parsed.
 */

import type { AudioLockScreenOptions } from "expo-audio";
import type { ExpoQueueSink } from "./expo-queue-sink";

/** The lock screen's two lines: the document's title, and what is being read under it. */
export interface NowPlaying {
  title: string;
  subtitle: string;
}

/**
 * F§10.4's controls: previous and next are enabled because a chunk *is* a sentence, so the lock screen's
 * transport moves a sentence at a time; both seek buttons are off, because seeking inside a sentence is not
 * something a reader can aim at from a lock screen. The reader is not a live stream — the queue has a duration
 * and a position — so nothing here hides them.
 */
const LOCK_SCREEN_OPTIONS: AudioLockScreenOptions = {
  showPreviousTrack: true,
  showNextTrack: true,
  showSeekBackward: false,
  showSeekForward: false,
};

/** The queue currently holding the lock screen, or `null` when none is. */
let owner: ExpoQueueSink | null = null;

/**
 * `configureAudioSession()` — F§10.4's mode for the whole app. Safe to call more than once: it sets the same
 * three declarations and leaves the platform's other defaults alone.
 */
export async function configureAudioSession(): Promise<void> {
  const audio: typeof import("expo-audio") = await import("expo-audio");
  await audio.setAudioModeAsync({
    shouldPlayInBackground: true,
    interruptionMode: "doNotMix",
    // Named because an omitted field reaches the platform as `false`: see this file's header.
    playsInSilentMode: true,
  });
}

/**
 * `setNowPlaying(sink, { title, subtitle })` — put this queue on the lock screen with F§10.4's controls, and keep
 * its second line current as the reading moves. A sink that has been disposed is ignored rather than asked for a
 * queue that no longer exists.
 *
 * **The queue is activated once, and only its metadata is updated after that, because activating it again
 * rebuilds the platform's media session.** Measured on the device: expo-audio's `setPlayableOptions` releases the
 * current `MediaSession` and builds a new one with a new id whenever `setActiveForLockScreen` runs, and this
 * function runs on every sentence — so the session was destroyed and re-added every ~2 s for a whole reading.
 * SystemUI watches that life: after a few rebuilds its `MediaDataManager` logged `session destroyed for
 * 0|dev.lectern.app|…` and then `Removing still-active player`, and it sent the session a **stop** media key
 * (`MediaSessionService: tempAllowlistTargetPkgIfPossible … reason:MediaSessionRecord:stop`). The playback was
 * stopped dead a few seconds into the reading — by the platform, with no error, with the position frozen and the
 * metadata still on the lock screen, which is exactly what the device check reports as the session leaving
 * `playing`. `updateLockScreenMetadata` reaches the same two lines without touching the session's life (its own
 * doc comment: "This method only has an effect if this playlist is currently active for lock screen controls"),
 * so the session is built once per queue and then left alone.
 */
export function setNowPlaying(sink: ExpoQueueSink, now: NowPlaying): void {
  if (sink.disposed) return;
  // The platform's second line is its `artist` field; a reader sees the title and what is being read.
  const metadata = { title: now.title, artist: now.subtitle };
  if (owner === sink) {
    sink.playlist.updateLockScreenMetadata(metadata);
    return;
  }
  owner = sink;
  sink.playlist.setActiveForLockScreen(true, metadata, LOCK_SCREEN_OPTIONS);
}

/**
 * `clearNowPlaying()` — take the lock screen back from whichever queue holds it. The contract gives this no
 * argument, so the queue that was handed over is the one cleared; disposing that queue already clears its
 * controls, and this is the ordinary way for the app to do it earlier.
 */
export function clearNowPlaying(): void {
  const sink = owner;
  owner = null;
  if (sink === null || sink.disposed) return;
  sink.playlist.clearLockScreenControls();
}
