/**
 * The synthesis path (F§6): one call that turns text into a named, timed chunk. It is the only place the
 * three halves of the TTS layer meet — the engine that produced the audio, the formula that names the
 * chunk, and the timing math of F§5.6 that turns the engine's tokens (or the text alone) into word timings
 * the hub hands to a client ready to play.
 */

import type { TimingSource, WordTiming } from "@lectern/core";
import { alignEngineTimings, estimateTimings, splitWords } from "@lectern/core";
import { chunkIdFor } from "./chunk-id";
import type { AudioMime, SynthesisRequest, TtsEngine } from "./engine";

/** A chunk ready to serve: its identity, its bytes, and the timings the client highlights with. */
export interface SynthesizedChunk {
  chunkId: string;
  audio: Uint8Array;
  mime: AudioMime;
  durationMs: number;
  timings: WordTiming[];
  timingSource: TimingSource;
}

/**
 * `synthesizeChunk(engine, request)` — synthesize, name and time one chunk.
 *
 * The text is tokenized with F§5.3's word splitter so a timing's index is a word index in the tokenizer
 * the whole document model is pinned to. An engine that reported tokens has them aligned over the chunk
 * (F§5.6(b)); `null` — or an empty array, which is what an engine answers for a language it cannot time —
 * goes through `estimateTimings` alone. `alignEngineTimings` makes that same choice itself once it finds
 * fewer than half the words matched, so the two paths cannot disagree.
 */
export async function synthesizeChunk(engine: TtsEngine, request: SynthesisRequest): Promise<SynthesizedChunk> {
  const result = await engine.synthesize(request);
  const words = splitWords(request.text).map((word) => word.text);
  const tokens = result.engineTokens;
  const aligned =
    tokens === null || tokens.length === 0
      ? { timings: estimateTimings(words, result.durationMs), timingSource: "estimated" as TimingSource }
      : alignEngineTimings(words, tokens, result.durationMs);
  return {
    chunkId: chunkIdFor(engine.id, request.engineVoiceId, request.synthSpeed, request.text),
    audio: result.audio,
    mime: result.mime,
    durationMs: result.durationMs,
    timings: aligned.timings,
    timingSource: aligned.timingSource,
  };
}
