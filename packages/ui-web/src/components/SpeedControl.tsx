/**
 * The speed control (F§10.1, F§5.6(e)): one slider over the rate range the reader offers, the preset
 * buttons beside it, and the two readouts that make a rate legible — the multiplier and what it does
 * to the reader's own pace.
 *
 * The value comes from the snapshot and every change leaves as a `setRate` command, clamped to
 * `RATE_MAX` so no drag or keystroke can ask for a rate the reader does not offer.
 */

import { clampRate, type PlayerCommand, RATE_MAX, RATE_MIN, RATE_PRESETS, RATE_STEP } from "@lectern/core";
import { formatRate, formatWpm } from "../format";
import { SpeedIcon } from "./icons";

export interface SpeedControlProps {
  /** The rate the snapshot reports. */
  rate: number;
  /** The reader's own pace in words per minute (F§5.6(f)). */
  baseWpm: number;
  /** Where a user action goes. */
  onCommand: (command: PlayerCommand) => void;
}

export function SpeedControl({ rate, baseWpm, onCommand }: SpeedControlProps) {
  const multiplier = formatRate(rate);
  const pace = formatWpm(rate, baseWpm);

  return (
    <fieldset aria-label="Playback speed" className="lectern-speed">
      <p className="lectern-speed__readout">
        <SpeedIcon />
        <span className="lectern-speed__multiplier">{multiplier}</span>
        <span className="lectern-speed__pace">{pace}</span>
      </p>
      <input
        aria-label="Playback speed"
        aria-valuetext={`${multiplier}, ${pace}`}
        className="lectern-speed__slider"
        max={RATE_MAX}
        min={RATE_MIN}
        onChange={(event) => onCommand({ type: "setRate", rate: clampRate(Number(event.currentTarget.value)) })}
        step={RATE_STEP}
        type="range"
        value={rate}
      />
      <ul className="lectern-speed__presets">
        {RATE_PRESETS.map((preset) => (
          <li key={preset}>
            <button
              aria-pressed={preset === rate}
              className="lectern-button lectern-speed__preset"
              onClick={() => onCommand({ type: "setRate", rate: preset })}
              type="button"
            >
              {formatRate(preset)}
            </button>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
