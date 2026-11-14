/**
 * The mock engine (F§6): a deterministic 220 Hz tone in place of speech, so every test, the hub's own
 * conformance run and the player's fakes can exercise the whole pipeline — the chunk id, the WAV writer,
 * the estimated timings — with no model, no network and no real voice.
 *
 * The same text and the same speed always produce the same bytes, which is what makes a chunk id and a
 * cached chunk comparable across runs.
 */

import type { EngineToken } from "@lectern/core";
import { estimateTimings, splitWords } from "@lectern/core";
import { type TtsEngine, type Voice, voiceIdFor } from "./engine";
import { encodeWavPcm16 } from "./wav";

/** The engine's scheme in a voice id (F§6). */
const ENGINE_ID = "mock";

/** The two voices F§6 gives the mock engine. */
const VOICES: readonly Voice[] = [
  { id: voiceIdFor(ENGINE_ID, "mock-a"), engine: ENGINE_ID, engineVoiceId: "mock-a", name: "Mock A", lang: "en" },
  { id: voiceIdFor(ENGINE_ID, "mock-b"), engine: ENGINE_ID, engineVoiceId: "mock-b", name: "Mock B", lang: "en" },
];

/** The mock tone's own numbers (F§6): a 22 050 Hz mono WAV of a 220 Hz tone. */
const SAMPLE_RATE = 22050;
const TONE_HZ = 220;

/** F§6's duration law: `60 ms × alnum characters`, floored at 200 ms, divided by the engine-side speed. */
const MS_PER_CHARACTER = 60;
const MIN_DURATION_MS = 200;

/** Half-scale: loud enough to read in a waveform, far enough from the 16-bit clipping point. */
const AMPLITUDE = 0.3;
const INT16_MAX = 32767;

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/gu;

/** `alnum(w)` for a whole chunk: every letter and digit the text contains. */
function alnumCount(text: string): number {
  return text.match(LETTER_OR_DIGIT)?.length ?? 0;
}

/**
 * F§6's duration for this text at this speed, in whole milliseconds. The sample count is derived first and
 * the duration read back from it, so the reported duration and the WAV's own header agree exactly — the
 * invariant `readWavDurationMs(audio) === durationMs` holds for every text and every speed.
 */
function toneDurationMs(text: string, synthSpeed: number): number {
  const base = Math.max(MS_PER_CHARACTER * alnumCount(text), MIN_DURATION_MS);
  const samples = Math.round((base / synthSpeed / 1000) * SAMPLE_RATE);
  return Math.round((samples / SAMPLE_RATE) * 1000);
}

/** The tone itself: a 220 Hz sine sampled at 22 050 Hz and rounded to 16-bit samples. */
function toneSamples(durationMs: number): Int16Array {
  const count = Math.round((durationMs / 1000) * SAMPLE_RATE);
  const samples = new Int16Array(count);
  for (let index = 0; index < count; index += 1) {
    const angle = (2 * Math.PI * TONE_HZ * index) / SAMPLE_RATE;
    samples[index] = Math.round(Math.sin(angle) * AMPLITUDE * INT16_MAX);
  }
  return samples;
}

/**
 * `createMockEngine()` — F§6's mock adapter. A voice it does not have is refused rather than quietly
 * served by another one, and its tokens come from `estimateTimings`, so a chunk synthesized here walks
 * the same alignment path a real engine's timestamps walk.
 */
export function createMockEngine(): TtsEngine {
  return {
    id: ENGINE_ID,
    listVoices: async () => VOICES.map((voice) => ({ ...voice })),
    synthesize: async (request) => {
      const voice = VOICES.find((candidate) => candidate.engineVoiceId === request.engineVoiceId);
      if (voice === undefined) throw new Error(`UNKNOWN_VOICE: ${ENGINE_ID} has no voice ${request.engineVoiceId}`);
      const durationMs = toneDurationMs(request.text, request.synthSpeed);
      const words = splitWords(request.text).map((word) => word.text);
      const engineTokens: EngineToken[] = estimateTimings(words, durationMs).map((timing) => ({
        text: words[timing.i] ?? "",
        s: timing.s,
        e: timing.e,
      }));
      return { audio: encodeWavPcm16(toneSamples(durationMs), SAMPLE_RATE), mime: "audio/wav", durationMs, engineTokens };
    },
  };
}
