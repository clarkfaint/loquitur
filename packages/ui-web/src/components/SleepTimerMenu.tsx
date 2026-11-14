/**
 * The sleep timer (F§10.1, F§5.7): the five choices the reader offers — off, and four lengths — plus
 * the countdown while one is running.
 *
 * F§5.7 keeps the deadline in the player, so the remaining time arrives in the snapshot and every
 * choice leaves as a `setSleep` command; `null` minutes is the off choice.
 */

import type { PlayerCommand } from "@lectern/core";
import { formatRemaining } from "../format";
import { TimerIcon } from "./icons";

/** The lengths the timer offers, in minutes; "off" is `null`. */
export const SLEEP_MINUTES: readonly number[] = [5, 15, 30, 60];

export interface SleepTimerMenuProps {
  /** Milliseconds left on the timer, or `null` when it is off (F§5.7). */
  sleepRemainingMs: number | null;
  /** Where a user action goes. */
  onCommand: (command: PlayerCommand) => void;
}

export function SleepTimerMenu({ sleepRemainingMs, onCommand }: SleepTimerMenuProps) {
  const running = sleepRemainingMs !== null;

  return (
    <fieldset aria-label="Sleep timer" className="lectern-timer">
      <p className="lectern-timer__readout">
        <TimerIcon />
        <span className="lectern-timer__remaining">{running ? formatRemaining(sleepRemainingMs) : "Off"}</span>
      </p>
      <ul className="lectern-timer__options">
        <li>
          <button
            aria-pressed={!running}
            className="lectern-button lectern-timer__option"
            onClick={() => onCommand({ type: "setSleep", minutes: null })}
            type="button"
          >
            Off
          </button>
        </li>
        {SLEEP_MINUTES.map((minutes) => (
          <li key={minutes}>
            <button className="lectern-button lectern-timer__option" onClick={() => onCommand({ type: "setSleep", minutes })} type="button">
              {minutes} min
            </button>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
