/**
 * The engine registry (F§6): one merged voice list for the voice picker, and one lookup from a voice id to
 * the voice behind it.
 *
 * Engines fail independently. A hub whose Kokoro container is down still offers every Piper voice, and a
 * voice list that does not match `VoiceSchema` counts as that engine's failure alone — a bad answer from one
 * backend never empties the reader's picker or hides the voices of another.
 */

import { z } from "zod";
import { parseVoiceId, type TtsEngine, type Voice, VoiceSchema } from "./engine";

/** What the rest of Lectern asks of a set of engines (F§6). */
export interface EngineRegistry {
  listVoices(): Promise<Voice[]>;
  resolve(voiceId: string): Promise<Voice>;
}

const VoiceListSchema = z.array(VoiceSchema);

/**
 * `createEngineRegistry(engines)` — list every voice the engines can offer, and resolve one voice id.
 *
 * `listVoices` asks every engine at once and keeps the answers that arrived; `resolve` refuses an id that
 * is not an `engine:voice` pair, an engine nobody registered, and a voice the engine does not list, each
 * with the reason in the message rather than a silent `null`.
 */
export function createEngineRegistry(engines: readonly TtsEngine[]): EngineRegistry {
  const listVoices = async (): Promise<Voice[]> => {
    const settled = await Promise.allSettled(engines.map(async (engine) => VoiceListSchema.parse(await engine.listVoices())));
    const voices: Voice[] = [];
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") voices.push(...outcome.value);
    }
    return voices;
  };

  const resolve = async (voiceId: string): Promise<Voice> => {
    const parts = parseVoiceId(voiceId);
    if (parts === null) throw new Error(`UNKNOWN_VOICE: ${voiceId} is not an engine:voice identifier`);
    if (!engines.some((engine) => engine.id === parts.engine)) throw new Error(`UNKNOWN_ENGINE: no engine registered as ${parts.engine}`);
    const voice = (await listVoices()).find((candidate) => candidate.id === voiceId);
    if (voice === undefined) throw new Error(`UNKNOWN_VOICE: no engine offers ${voiceId}`);
    return voice;
  };

  return { listVoices, resolve };
}
