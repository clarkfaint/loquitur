/**
 * F§5.6(d)'s highlight clock on Android (F§10.4).
 *
 * The position to highlight is not a state the player publishes: `t = sink.current().positionMs + lookaheadMs`
 * is read from the audio queue as it plays, and the word it falls on changes far faster than the sentence-level
 * snapshot does. So the reader samples the controller on a timer instead of subscribing to it.
 *
 * The interval is the ceiling F§5.6(d) and F§10.4 both name — at most every 50 ms, which is 20 Hz — and it runs
 * only while audio is actually moving. Every other state paints once, when it arrives, so a restored, seeked or
 * paused position is shown without playback having to start.
 *
 * A sample that reports the position already on screen returns the previous object rather than an equal one, so
 * a 20 Hz timer does not re-render the reader twenty times a second for a word that has not changed.
 */

import type { PlayerController, PlayerState } from "@lectern/core";
import { useEffect, useState } from "react";
import type { ActivePoint } from "../reader/highlight-model";

/** How often the highlight may be resampled: F§5.6(d)'s 50 ms on Android, and F§10.4's 20 Hz ceiling. */
export const ACTIVE_WORD_INTERVAL_MS = 50;

/** The states in which the audio position is moving and the highlight has to follow it. */
const MOVING_STATES: readonly PlayerState[] = ["playing", "buffering"];

/** The point a player with no controller reports: the start of the document. */
const START: ActivePoint = { sentenceIndex: 0, wordIndex: 0 };

/** The controller's current position, or the start of the document while there is no controller. */
function sample(controller: PlayerController | null): ActivePoint {
  return controller === null ? START : controller.activeWord();
}

/**
 * `useActiveWord(controller, state)` — the sentence and word to highlight, sampled at most every 50 ms while
 * the player is playing or buffering and once per change otherwise.
 */
export function useActiveWord(controller: PlayerController | null, state: PlayerState): ActivePoint {
  const [active, setActive] = useState<ActivePoint>(() => sample(controller));

  useEffect(() => {
    const paint = (): void => {
      setActive((previous) => {
        const next = sample(controller);
        const unchanged = previous.sentenceIndex === next.sentenceIndex && previous.wordIndex === next.wordIndex;
        return unchanged ? previous : next;
      });
    };

    paint();
    if (!MOVING_STATES.includes(state)) return;
    const handle = setInterval(paint, ACTIVE_WORD_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [controller, state]);

  return active;
}
