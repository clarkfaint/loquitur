/**
 * U-015's contracts (F§6): the two `chunkId` goldens, the WAV writer against its own reader, the MP3
 * duration reader against synthetic Layer III streams, the mock engine through the conformance suite, the
 * synthesis path and the registry.
 *
 * The synthetic MPEG streams are built here rather than committed: a frame is a header this file writes and
 * a payload of zeros, so the expected duration is arithmetic on the header, not a recorded number.
 */

import type { EngineToken } from "@lectern/core";
import { estimateTimings, splitWords } from "@lectern/core";
import { expect, test } from "vitest";
import { chunkIdFor } from "../chunk-id";
import { parseVoiceId, type TtsEngine, voiceIdFor } from "../engine";
import { createMockEngine } from "../mock-engine";
import { readMp3DurationMs } from "../mp3";
import { createEngineRegistry } from "../registry";
import { synthesizeChunk } from "../synthesize-chunk";
import { runTtsEngineConformance } from "../testing/engine-conformance";
import { encodeWavPcm16, readWavDurationMs } from "../wav";

/** The mock engine's own sample rate (F§6), so a test can size a tone in samples. */
const SAMPLE_RATE = 22050;

/** MPEG-1 Layer III, 128 kbps, 44 100 Hz: 417 bytes a frame, 1152 samples a frame (F§6's tables). */
const MPEG1_HEADER = [0xff, 0xfb, 0x90, 0x00] as const;
const MPEG1_PAYLOAD_BYTES = 413;

/** MPEG-2 Layer III, 64 kbps, 22 050 Hz: 208 bytes a frame, 576 samples a frame (F§6's tables). */
const MPEG2_HEADER = [0xff, 0xf3, 0x80, 0x00] as const;
const MPEG2_PAYLOAD_BYTES = 204;

/** The two golden chunk ids of F§6, verbatim. */
const MOCK_CHUNK_ID = "3bfbfd2ad841c9c08af4bcc1c7ccb8560d318c76";
const KOKORO_CHUNK_ID = "de77348a49abbad5c340cede3e9a7fdda8c05403";

/** The cases F§6's engine suite is made of, in the order they run. */
const ENGINE_CASES = [
  "lists at least one voice",
  "synthesizes non-empty audio with a positive duration",
  "duration scales inversely with synthSpeed within 25%",
  "an unknown voice rejects",
];

/** `count` frames of `header` followed by `payloadBytes` zero bytes each. */
function syntheticMp3(header: readonly number[], payloadBytes: number, count: number): Uint8Array {
  const frameBytes = header.length + payloadBytes;
  const bytes = new Uint8Array(frameBytes * count);
  for (let frame = 0; frame < count; frame += 1) {
    for (const [index, byte] of header.entries()) bytes[frame * frameBytes + index] = byte;
  }
  return bytes;
}

/** The four seven-bit bytes an ID3v2 tag stores its size in, most significant first. */
function synchsafe(value: number): readonly number[] {
  return [(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f];
}

/** `stream` with an ID3v2.3 tag of `tagBytes` bytes in front of it. */
function withId3Tag(stream: Uint8Array, tagBytes: number): Uint8Array {
  const bytes = new Uint8Array(10 + tagBytes + stream.byteLength);
  const view = new DataView(bytes.buffer);
  bytes.set([0x49, 0x44, 0x33], 0);
  view.setUint8(3, 3);
  bytes.set(synchsafe(tagBytes), 6);
  bytes.set(stream, 10 + tagBytes);
  return bytes;
}

/** The same WAV with an unknown chunk spliced in before `data`, word-aligned, its `RIFF` size corrected. */
function withExtraChunk(wav: Uint8Array, id: string, bodyBytes: number): Uint8Array {
  const extra = id.length + 4 + bodyBytes;
  const bytes = new Uint8Array(wav.byteLength + extra);
  const view = new DataView(bytes.buffer);
  bytes.set(wav.subarray(0, 36), 0);
  for (let index = 0; index < id.length; index += 1) bytes[36 + index] = id.charCodeAt(index);
  view.setUint32(40, bodyBytes, true);
  bytes.set(wav.subarray(36), 36 + extra);
  view.setUint32(4, bytes.byteLength - 8, true);
  return bytes;
}

/** An engine that reports the audio of a chunk but no tokens, or the empty token list an engine answers. */
function tokenlessEngine(engineTokens: EngineToken[] | null): TtsEngine {
  return {
    id: "silent",
    listVoices: async () => [{ id: "silent:silent", engine: "silent", engineVoiceId: "silent", name: "Silent", lang: "en" }],
    synthesize: async () => ({ audio: new Uint8Array([0, 1]), mime: "audio/mpeg", durationMs: 1000, engineTokens }),
  };
}

test("F§6 golden — the chunk id of a mock chunk", () => {
  expect(chunkIdFor("mock", "mock-a", 1, "Hello, world.")).toBe(MOCK_CHUNK_ID);
});

test("F§6 golden — the chunk id is the engine's, not the voice's alone", () => {
  expect(chunkIdFor("kokoro", "af_heart", 1, "Hello, world.")).toBe(KOKORO_CHUNK_ID);
});

test("a chunk id is forty characters and its speed is fixed to two decimals", () => {
  const base = chunkIdFor("mock", "mock-a", 1, "Hello, world.");
  expect(base).toHaveLength(40);
  expect(chunkIdFor("mock", "mock-a", 1.0, "Hello, world.")).toBe(base);
  expect(chunkIdFor("mock", "mock-a", 1.004, "Hello, world.")).toBe(base);
  expect(chunkIdFor("mock", "mock-a", 1.5, "Hello, world.")).not.toBe(base);
  expect(chunkIdFor("mock", "mock-b", 1, "Hello, world.")).not.toBe(base);
  expect(chunkIdFor("mock", "mock-a", 1, "Hello, world!")).not.toBe(base);
  expect(chunkIdFor("piper", "mock-a", 1, "Hello, world.")).not.toBe(base);
});

test("a WAV round trip reports the tone's own duration", () => {
  const samples = new Int16Array(SAMPLE_RATE / 2);
  const bytes = encodeWavPcm16(samples, SAMPLE_RATE);
  expect(bytes.byteLength).toBe(44 + samples.length * 2);
  expect(bytes.subarray(0, 4)).toEqual(new Uint8Array([0x52, 0x49, 0x46, 0x46]));
  expect(readWavDurationMs(bytes)).toBe(500);
});

test("readWavDurationMs steps over chunks it does not know", () => {
  const plain = encodeWavPcm16(new Int16Array(SAMPLE_RATE / 2), SAMPLE_RATE);
  const tagged = withExtraChunk(plain, "LIST", 8);
  expect(tagged.byteLength).toBe(plain.byteLength + 16);
  expect(readWavDurationMs(tagged)).toBe(500);
});

test("readMp3DurationMs sums MPEG-1 Layer III frames", () => {
  const stream = syntheticMp3(MPEG1_HEADER, MPEG1_PAYLOAD_BYTES, 100);
  expect(stream.byteLength).toBe(417 * 100);
  expect(readMp3DurationMs(stream)).toBe(2612);
});

test("readMp3DurationMs sums MPEG-2 Layer III frames", () => {
  const stream = syntheticMp3(MPEG2_HEADER, MPEG2_PAYLOAD_BYTES, 100);
  expect(stream.byteLength).toBe(208 * 100);
  expect(readMp3DurationMs(stream)).toBe(2612);
});

test("readMp3DurationMs skips an ID3v2 tag and stops at the end of the frames", () => {
  const stream = syntheticMp3(MPEG1_HEADER, MPEG1_PAYLOAD_BYTES, 100);
  expect(readMp3DurationMs(withId3Tag(stream, 200))).toBe(2612);
  expect(readMp3DurationMs(stream.subarray(0, 417 * 99))).toBe(2586);
});

test("the readers refuse bytes that are not audio", () => {
  expect(() => readWavDurationMs(new Uint8Array(64))).toThrow(/INVALID_WAV/);
  expect(() => readMp3DurationMs(new Uint8Array(64))).toThrow(/INVALID_MP3/);
});

test("parseVoiceId splits engine:voice at its first colon and refuses anything else", () => {
  expect(parseVoiceId("mock:mock-a")).toEqual({ engine: "mock", engineVoiceId: "mock-a" });
  expect(parseVoiceId("kokoro:af_heart")).toEqual({ engine: "kokoro", engineVoiceId: "af_heart" });
  expect(parseVoiceId("piper:en_US-amy:low")).toEqual({ engine: "piper", engineVoiceId: "en_US-amy:low" });
  expect(voiceIdFor("mock", "mock-a")).toBe("mock:mock-a");
  expect(parseVoiceId("mock-a")).toBeNull();
  expect(parseVoiceId(":mock-a")).toBeNull();
  expect(parseVoiceId("mock:")).toBeNull();
  expect(parseVoiceId("")).toBeNull();
});

test("the mock engine speaks F§6's duration law", async () => {
  const engine = createMockEngine();
  expect(engine.id).toBe("mock");
  expect((await engine.listVoices()).map((voice) => voice.id)).toEqual(["mock:mock-a", "mock:mock-b"]);

  const atSpeedOne = await engine.synthesize({ text: "Hello, world.", engineVoiceId: "mock-a", synthSpeed: 1 });
  expect(atSpeedOne.mime).toBe("audio/wav");
  expect(atSpeedOne.durationMs).toBe(600);
  expect(atSpeedOne.audio.byteLength).toBe(44 + Math.round((600 / 1000) * SAMPLE_RATE) * 2);
  expect(readWavDurationMs(atSpeedOne.audio)).toBe(atSpeedOne.durationMs);

  const atSpeedTwo = await engine.synthesize({ text: "Hello, world.", engineVoiceId: "mock-a", synthSpeed: 2 });
  expect(atSpeedTwo.durationMs).toBe(300);
  expect(readWavDurationMs(atSpeedTwo.audio)).toBe(atSpeedTwo.durationMs);

  const floored = await engine.synthesize({ text: "a", engineVoiceId: "mock-b", synthSpeed: 4 });
  expect(floored.durationMs).toBe(50);
  expect(readWavDurationMs(floored.audio)).toBe(floored.durationMs);
});

test("the mock engine passes every conformance case", async () => {
  const results = await runTtsEngineConformance(createMockEngine());
  expect(results.map((result) => result.name)).toEqual(ENGINE_CASES);
  expect(results.filter((result) => !result.ok)).toEqual([]);
});

test("synthesizeChunk returns one timing per word, aligned from the engine's own tokens", async () => {
  const chunk = await synthesizeChunk(createMockEngine(), { text: "Hello, world.", engineVoiceId: "mock-a", synthSpeed: 1 });
  expect(chunk.chunkId).toBe(MOCK_CHUNK_ID);
  expect(chunk.mime).toBe("audio/wav");
  expect(chunk.durationMs).toBe(600);
  expect(chunk.timingSource).toBe("engine");
  expect(chunk.timings.map((timing) => timing.i)).toEqual([0, 1]);
  expect(chunk.timings).toHaveLength(splitWords("Hello, world.").length);
  expect(chunk.timings).toEqual([
    { i: 0, s: 0, e: 200 },
    { i: 1, s: 280, e: 480 },
  ]);
});

test("synthesizeChunk estimates F§5.6(a)'s golden when the engine reports no usable tokens", async () => {
  for (const engineTokens of [null, []]) {
    const chunk = await synthesizeChunk(tokenlessEngine(engineTokens), { text: "Hello, world.", engineVoiceId: "silent", synthSpeed: 1 });
    expect(chunk.timingSource).toBe("estimated");
    expect(chunk.timings).toEqual(estimateTimings(["Hello,", "world."], 1000));
    expect(chunk.timings).toEqual([
      { i: 0, s: 0, e: 333 },
      { i: 1, s: 467, e: 800 },
    ]);
  }
});

test("the registry merges every engine's voices and resolves one by id", async () => {
  const registry = createEngineRegistry([createMockEngine()]);
  expect((await registry.listVoices()).map((voice) => voice.id)).toEqual(["mock:mock-a", "mock:mock-b"]);
  const voice = await registry.resolve("mock:mock-b");
  expect(voice).toEqual({ id: "mock:mock-b", engine: "mock", engineVoiceId: "mock-b", name: "Mock B", lang: "en" });
  await expect(registry.resolve("nope:x")).rejects.toThrow(/UNKNOWN_ENGINE/);
  await expect(registry.resolve("mock:mock-z")).rejects.toThrow(/UNKNOWN_VOICE/);
  await expect(registry.resolve("mock-a")).rejects.toThrow(/UNKNOWN_VOICE/);
});

test("an engine that cannot answer does not hide the voices of the others", async () => {
  const down: TtsEngine = {
    id: "down",
    listVoices: async () => {
      throw new Error("the engine is down");
    },
    synthesize: async () => {
      throw new Error("the engine is down");
    },
  };
  const registry = createEngineRegistry([down, createMockEngine()]);
  expect((await registry.listVoices()).map((voice) => voice.id)).toEqual(["mock:mock-a", "mock:mock-b"]);
  await expect(registry.resolve("down:any")).rejects.toThrow(/UNKNOWN_VOICE/);
});
