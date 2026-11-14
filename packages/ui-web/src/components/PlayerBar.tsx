/**
 * The player bar (F§10.1): one row pinned along the bottom edge of the reader, with a progress strip
 * above it and three groups inside it — transport on the left, the speed, voice and sleep controls in
 * the middle, and the clock on the right.
 *
 * The bar owns no state. Everything it draws comes from the `PlayerSnapshot` it is handed, and every
 * user action leaves as a `PlayerCommand` through `onCommand`, so the same bar serves the web app,
 * the extension panel and the desktop window (F§5.7). The `compact` variant keeps the transport and
 * the clock and drops the three panels, which is what the mini-player uses (F§10.1).
 */

import type { PlayerCommand, PlayerSnapshot } from "@lectern/core";
import type { Voice } from "@lectern/core-tts";
import { formatRate, formatRemaining, formatWpm } from "../format";
import { NextIcon, PauseIcon, PlayIcon, PreviousIcon } from "./icons";
import { SleepTimerMenu } from "./SleepTimerMenu";
import { SpeedControl } from "./SpeedControl";
import { VoicePicker } from "./VoicePicker";

/** The percentage the progress strip is measured in. */
const PERCENT = 100;

export interface PlayerBarProps {
  /** What the player is doing right now (F§5.7). */
  snapshot: PlayerSnapshot;
  /** The voices the hub offers (F§6). */
  voices: Voice[];
  /** How far through the document playback is, from 0 to 1. */
  progressFraction: number;
  /** Time left in the document, in milliseconds. */
  remainingMs: number;
  /** The reader's own pace in words per minute (F§5.6(f)). */
  baseWpm: number;
  /** `full` shows every control; `compact` is the mini-player. */
  variant: "full" | "compact";
  /** Where a user action goes. */
  onCommand: (command: PlayerCommand) => void;
}

/** A fraction pulled into 0–100 and rounded, so a caller's arithmetic cannot distort the strip. */
function progressPercent(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  return Math.round(Math.min(1, Math.max(0, fraction)) * PERCENT);
}

export function PlayerBar({ snapshot, voices, progressFraction, remainingMs, baseWpm, variant, onCommand }: PlayerBarProps) {
  const playing = snapshot.state === "playing";
  const busy = snapshot.state === "loading" || snapshot.state === "buffering";
  const percent = progressPercent(progressFraction);

  return (
    <section aria-label="Player" className={`lectern-player lectern-player--${variant}`}>
      <div
        aria-label="Playback progress"
        aria-valuemax={PERCENT}
        aria-valuemin={0}
        aria-valuenow={percent}
        className="lectern-player__progress"
        role="progressbar"
      >
        <div className="lectern-player__progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="lectern-player__row">
        <fieldset aria-label="Transport" className="lectern-player__group">
          <button
            aria-label="Previous sentence"
            className="lectern-button lectern-player__control"
            onClick={() => onCommand({ type: "skip", sentences: -1 })}
            type="button"
          >
            <PreviousIcon />
          </button>
          <button
            aria-label={playing ? "Pause" : "Play"}
            className="lectern-button lectern-player__control lectern-player__control--primary"
            onClick={() => onCommand(playing ? { type: "pause" } : { type: "play" })}
            type="button"
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button
            aria-label="Next sentence"
            className="lectern-button lectern-player__control"
            onClick={() => onCommand({ type: "skip", sentences: 1 })}
            type="button"
          >
            <NextIcon />
          </button>
        </fieldset>
        {variant === "full" ? (
          <>
            <SpeedControl baseWpm={baseWpm} onCommand={onCommand} rate={snapshot.rate} />
            <VoicePicker onCommand={onCommand} voiceId={snapshot.voiceId} voices={voices} />
            <SleepTimerMenu onCommand={onCommand} sleepRemainingMs={snapshot.sleepRemainingMs} />
          </>
        ) : (
          <p className="lectern-player__mini">
            <span className="lectern-player__mini-rate">{formatRate(snapshot.rate)}</span>
            <span className="lectern-player__mini-pace">{formatWpm(snapshot.rate, baseWpm)}</span>
          </p>
        )}
        <div className="lectern-player__clock">
          {busy ? <span aria-label="Loading audio" className="lectern-spinner" role="status" /> : null}
          <span className="lectern-player__remaining">{formatRemaining(remainingMs)}</span>
        </div>
      </div>
      {snapshot.state === "error" && snapshot.error !== null ? (
        <p className="lectern-player__error" role="alert">
          {snapshot.error.message}
        </p>
      ) : null}
    </section>
  );
}
