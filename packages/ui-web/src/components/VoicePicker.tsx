/**
 * The voice picker (F§10.1, F§6): every voice the hub offers, grouped by language and then by the
 * engine that serves it, with a filter that matches a voice's own name.
 *
 * The only state this component holds is the text in the filter box — a view detail, not playback
 * state. Which voice is selected comes from the snapshot (`voiceId`) and choosing one leaves as a
 * `setVoice` command carrying F§6's `engine:voice` id.
 */

import type { PlayerCommand } from "@lectern/core";
import type { Voice } from "@lectern/core-tts";
import { useState } from "react";
import { VoiceIcon } from "./icons";

export interface VoicePickerProps {
  /** Every voice the hub answered with. */
  voices: Voice[];
  /** The voice the snapshot reports, or `null` before one has been chosen. */
  voiceId: string | null;
  /** Where a user action goes. */
  onCommand: (command: PlayerCommand) => void;
}

interface VoiceGroup {
  lang: string;
  engine: string;
  voices: Voice[];
}

/** Language, then engine, each alphabetically, voices inside a group by name. */
function groupVoices(voices: Voice[], filter: string): VoiceGroup[] {
  const needle = filter.trim().toLowerCase();
  const matching = needle === "" ? voices : voices.filter((voice) => voice.name.toLowerCase().includes(needle));
  const groups = new Map<string, VoiceGroup>();
  for (const voice of matching) {
    const key = `${voice.lang}\u0000${voice.engine}`;
    const group = groups.get(key) ?? { lang: voice.lang, engine: voice.engine, voices: [] };
    group.voices.push(voice);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, voices: [...group.voices].sort((left, right) => left.name.localeCompare(right.name)) }))
    .sort((left, right) => left.lang.localeCompare(right.lang) || left.engine.localeCompare(right.engine));
}

export function VoicePicker({ voices, voiceId, onCommand }: VoicePickerProps) {
  const [filter, setFilter] = useState("");
  const groups = groupVoices(voices, filter);

  return (
    <fieldset aria-label="Voice" className="lectern-voice">
      <p className="lectern-voice__head">
        <VoiceIcon />
        <label className="lectern-voice__filter-label" htmlFor="lectern-voice-filter">
          Voice
        </label>
        <input
          className="lectern-voice__filter"
          id="lectern-voice-filter"
          onChange={(event) => setFilter(event.currentTarget.value)}
          placeholder="Filter voices"
          type="search"
          value={filter}
        />
      </p>
      {groups.length === 0 ? (
        <p className="lectern-voice__empty">No voice matches that filter.</p>
      ) : (
        <div className="lectern-voice__list">
          {groups.map((group) => (
            <fieldset
              aria-label={`${group.lang} ${group.engine}`}
              className="lectern-voice__group"
              key={`${group.lang}\u0000${group.engine}`}
            >
              <p className="lectern-voice__group-title">
                {group.lang} · {group.engine}
              </p>
              <ul className="lectern-voice__options">
                {group.voices.map((voice) => (
                  <li key={voice.id}>
                    <button
                      aria-pressed={voice.id === voiceId}
                      className="lectern-button lectern-voice__option"
                      onClick={() => onCommand({ type: "setVoice", voiceId: voice.id })}
                      type="button"
                    >
                      {voice.name}
                    </button>
                  </li>
                ))}
              </ul>
            </fieldset>
          ))}
        </div>
      )}
    </fieldset>
  );
}
