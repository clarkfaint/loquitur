/**
 * The app's audio session and its lock-screen controls (F§10.4).
 *
 * Two declarations belong to the app rather than to a sink, and both are made once per run:
 *
 * - `configureAudioSession()` sets F§10.4's mode: audio keeps playing while the app is in the background, and
 *   the session does not mix — a reader's audio pauses for a phone call instead of talking over it. The
 *   platform's own defaults for everything else are the ones Lectern wants (silent mode still plays, nothing
 *   is routed to the earpiece, recording is off), so only these two are named.
 * - `setNowPlaying(sink, { title, subtitle })` hands the queue to the lock screen: play/pause and
 *   previous/next sentence, which is F§10.4's control list. The platform shows one owner at a time, so the
 *   queue that was handed over is remembered and `clearNowPlaying()` takes it back.
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
 * two declarations and leaves the platform's other defaults alone.
 */
export async function configureAudioSession(): Promise<void> {
  const audio: typeof import("expo-audio") = await import("expo-audio");
  await audio.setAudioModeAsync({
    shouldPlayInBackground: true,
    interruptionMode: "doNotMix",
  });
}

/**
 * `setNowPlaying(sink, { title, subtitle })` — put this queue on the lock screen with F§10.4's controls. A sink
 * that has been disposed is ignored rather than asked for a queue that no longer exists.
 */
export function setNowPlaying(sink: ExpoQueueSink, now: NowPlaying): void {
  if (sink.disposed) return;
  owner = sink;
  // The platform's second line is its `artist` field; a reader sees the title and what is being read.
  sink.playlist.setActiveForLockScreen(true, { title: now.title, artist: now.subtitle }, LOCK_SCREEN_OPTIONS);
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
