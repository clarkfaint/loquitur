/**
 * The conformance suite every `TtsEngine` implementation must pass (F§6). It is runner-agnostic: it drives
 * the engine only through the interface and returns one result per case, so a test can assert all of them
 * or a hub can report which ones a configured backend failed.
 */

import type { TtsEngine } from "../engine";

export interface TtsEngineConformanceResult {
  name: string;
  ok: boolean;
  error?: string;
}

/** The text every case synthesizes: two words, so the caller can also check what came back for them. */
const SAMPLE_TEXT = "Hello, world.";
/** A longer phrase for the speed case, so a duration is measured over more than a word. */
const SPEED_TEXT = "Lectern reads this text aloud.";
/** A voice id no engine in this suite offers. */
const UNKNOWN_ENGINE_VOICE = "no-such-voice";
/** The two engine speeds the speed case compares, and how far the ratio may sit from the inverse. */
const BASE_SPEED = 1;
const FASTER_SPEED = 2;
const SPEED_TOLERANCE = 0.25;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * `runTtsEngineConformance(engine)` — F§6's four cases: a voice list, real audio with a real duration, a
 * duration that answers the engine speed, and a refusal for a voice the engine does not have.
 *
 * The speed case compares durations, so an engine that ignores `synthSpeed` fails it; the tolerance is
 * 25% because an engine may quantize its own speed steps.
 */
export async function runTtsEngineConformance(engine: TtsEngine): Promise<TtsEngineConformanceResult[]> {
  const results: TtsEngineConformanceResult[] = [];

  const record = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
      results.push({ name, ok: true });
    } catch (cause) {
      results.push({ name, ok: false, error: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const firstVoice = async (): Promise<string> => {
    const voices = await engine.listVoices();
    assert(voices.length > 0, `${engine.id} lists no voice at all`);
    return voices[0]?.engineVoiceId ?? "";
  };

  await record("lists at least one voice", async () => {
    const voices = await engine.listVoices();
    assert(voices.length > 0, `${engine.id} lists no voice at all`);
    for (const voice of voices) {
      assert(voice.engine === engine.id, `voice ${voice.id} claims engine ${voice.engine}, not ${engine.id}`);
      assert(voice.engineVoiceId !== "", `voice ${voice.id} has an empty engine voice id`);
    }
  });

  await record("synthesizes non-empty audio with a positive duration", async () => {
    const result = await engine.synthesize({ text: SAMPLE_TEXT, engineVoiceId: await firstVoice(), synthSpeed: BASE_SPEED });
    assert(result.audio.byteLength > 0, `${engine.id} returned no audio`);
    assert(result.durationMs > 0, `${engine.id} returned a duration of ${result.durationMs} ms`);
    assert(result.mime === "audio/mpeg" || result.mime === "audio/wav", `${engine.id} returned the container ${result.mime}`);
  });

  await record("duration scales inversely with synthSpeed within 25%", async () => {
    const engineVoiceId = await firstVoice();
    const slow = await engine.synthesize({ text: SPEED_TEXT, engineVoiceId, synthSpeed: BASE_SPEED });
    const fast = await engine.synthesize({ text: SPEED_TEXT, engineVoiceId, synthSpeed: FASTER_SPEED });
    assert(slow.durationMs > 0 && fast.durationMs > 0, `${engine.id} returned no duration at one of the two speeds`);
    const ratio = slow.durationMs / (fast.durationMs * (FASTER_SPEED / BASE_SPEED));
    assert(
      Math.abs(ratio - 1) <= SPEED_TOLERANCE,
      `${engine.id} took ${slow.durationMs} ms at ${BASE_SPEED} and ${fast.durationMs} ms at ${FASTER_SPEED}`,
    );
  });

  await record("an unknown voice rejects", async () => {
    const outcome = await engine.synthesize({ text: SAMPLE_TEXT, engineVoiceId: UNKNOWN_ENGINE_VOICE, synthSpeed: BASE_SPEED }).then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    assert(outcome === "rejected", `${engine.id} synthesized the unknown voice ${UNKNOWN_ENGINE_VOICE}`);
  });

  return results;
}
