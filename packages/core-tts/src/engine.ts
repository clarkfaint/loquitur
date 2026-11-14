/**
 * The TTS engine boundary (F§6): what a voice is, what every engine must answer, and the `engine:voice`
 * identifier the rest of Lectern passes around.
 *
 * The package is isomorphic: an adapter reaches its backend with `fetch` and hands back a plain
 * `Uint8Array`, so the same interface serves the hub, the browser, the extension and the desktop app.
 */

import type { EngineToken } from "@lectern/core";
import { z } from "zod";

/**
 * A voice an engine offers (F§6): the global `id` the reader is set to (`kokoro:af_heart`), the engine
 * that serves it, that engine's own name for it, a display name and a language tag. Strict, so a voice
 * that grows a field this design does not define is refused at the engine boundary.
 */
export const VoiceSchema = z.strictObject({
  id: z.string(),
  engine: z.string(),
  engineVoiceId: z.string(),
  name: z.string(),
  lang: z.string(),
});
export type Voice = z.infer<typeof VoiceSchema>;

/** The two audio containers F§6 allows: the hub's engines return one or the other, never anything else. */
export type AudioMime = "audio/mpeg" | "audio/wav";

/** What an engine is asked for (F§6): the text, the engine's own voice id, and the engine-side speed. */
export interface SynthesisRequest {
  text: string;
  engineVoiceId: string;
  synthSpeed: number;
}

/**
 * What an engine answers (F§6): the audio, the container it is in, its duration in integer milliseconds,
 * and one timestamped token per word it can time — or `null` when the engine reports no timestamps at all
 * (F§5.6(b) then estimates them). Kokoro answers an empty array for a language it cannot time, which the
 * alignment path treats the same way as `null`.
 */
export interface SynthesisResult {
  audio: Uint8Array;
  mime: AudioMime;
  durationMs: number;
  engineTokens: EngineToken[] | null;
}

/** Every speech engine implements this (F§6). `id` is the scheme half of a voice id, for example `mock`. */
export interface TtsEngine {
  readonly id: string;
  listVoices(): Promise<Voice[]>;
  synthesize(request: SynthesisRequest): Promise<SynthesisResult>;
}

/** The two halves of an `engine:voice` identifier (F§6), each of them non-empty. */
export const VoiceIdPartsSchema = z.strictObject({
  engine: z.string().min(1),
  engineVoiceId: z.string().min(1),
});
export type VoiceIdParts = z.infer<typeof VoiceIdPartsSchema>;

/** The identifier a voice is addressed by, in settings, in the hub's API and in a chunk id (F§6). */
export function voiceIdFor(engine: string, engineVoiceId: string): string {
  return `${engine}:${engineVoiceId}`;
}

/**
 * `parseVoiceId('engine:voice')` — F§6's identifier split at its **first** colon, so an engine voice id
 * that itself contains one stays whole. Text that is not such an identifier answers `null` rather than a
 * half-parsed pair.
 */
export function parseVoiceId(voiceId: string): VoiceIdParts | null {
  const separator = voiceId.indexOf(":");
  if (separator <= 0 || separator === voiceId.length - 1) return null;
  const parts = { engine: voiceId.slice(0, separator), engineVoiceId: voiceId.slice(separator + 1) };
  const parsed = VoiceIdPartsSchema.safeParse(parts);
  return parsed.success ? parsed.data : null;
}
