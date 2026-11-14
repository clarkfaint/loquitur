/**
 * U-016's contract (F§6): the Kokoro adapter against a local stub of the only two endpoints it may call.
 *
 * The stub is a real `node:http` server on a free port — no test here touches a Kokoro container. Its audio
 * is built rather than recorded: frames of one fixed Layer III header whose count follows the requested
 * speed, so the duration the adapter reads back is the arithmetic F§6's MP3 tables predict and the
 * conformance suite's speed case can hold. Every voice the adapter answers with came out of the stub's own
 * voice response; this file never tells the adapter what a voice list is.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createKokoroEngine, KokoroEngineError, type KokoroEngineOptions, type KokoroFetch } from "../kokoro-engine";
import { readMp3DurationMs } from "../mp3";
import { runTtsEngineConformance } from "../testing/engine-conformance";

/** The voices the stub offers: the adapter must answer `kokoro:<id>` for each and hold no list of its own. */
const STUB_VOICES = ["af_heart", "am_michael", "bf_emma"];

/** The stub's three word timestamps, in the seconds the service reports them. */
const STUB_TIMESTAMPS = [
  { word: "Hello,", start_time: 0, end_time: 0.4 },
  { word: "dear", start_time: 0.4, end_time: 0.8 },
  { word: "world.", start_time: 0.8, end_time: 1.2 },
];

/** MPEG-1 Layer III, 128 kbps, 44 100 Hz: 417 bytes a frame, 1152 samples a frame (F§6's tables). */
const MPEG1_HEADER = [0xff, 0xfb, 0x90, 0x00];
const MPEG1_PAYLOAD_BYTES = 413;
/** The frames the stub's audio is made of at speed 1, divided by the speed it is asked for. */
const BASE_FRAMES = 100;
/** A frame lasts 1152/44 100 s, so 100 frames are 2612 ms and 50 frames 1306 ms (F§6's tables). */
const BASE_DURATION_MS = 2612;
const HALF_DURATION_MS = 1306;

/** The three voices only the stub knows: one it cannot time, one whose backend fails, one whose tokens outlast its audio. */
const UNTIMED_VOICE = "untimed";
const FAILING_VOICE = "server-error";
const LATE_TOKEN_VOICE = "late-token";
const LATE_TOKEN_FRAMES = 25;
const LATE_TOKEN_AUDIO_MS = 653;

/** The cases F§6's engine suite is made of, in the order they run. */
const ENGINE_CASES = [
  "lists at least one voice",
  "synthesizes non-empty audio with a positive duration",
  "duration scales inversely with synthSpeed within 25%",
  "an unknown voice rejects",
];

/** One request the stub received, as the adapter sent it. */
interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  contentType: string | undefined;
  body: string;
}

/** `count` frames of the stub's header, each followed by a payload of zeros. */
function syntheticMp3(count: number): Uint8Array {
  const frameBytes = MPEG1_HEADER.length + MPEG1_PAYLOAD_BYTES;
  const bytes = new Uint8Array(frameBytes * count);
  for (let frame = 0; frame < count; frame += 1) {
    for (const [index, byte] of MPEG1_HEADER.entries()) bytes[frame * frameBytes + index] = byte;
  }
  return bytes;
}

/** The audio of `count` frames, base64-encoded as the service answers it. */
function encodedAudio(count: number): string {
  return Buffer.from(syntheticMp3(count)).toString("base64");
}

/**
 * The stub's canned speech answer for one request: a whole number of frames for the speed asked for, and
 * timestamps that shrink with it, so a faster request is a shorter answer on both counts.
 */
function speechAnswer(speed: number): unknown {
  return {
    audio: encodedAudio(Math.max(1, Math.round(BASE_FRAMES / speed))),
    timestamps: STUB_TIMESTAMPS.map((timestamp) => ({
      word: timestamp.word,
      start_time: timestamp.start_time / speed,
      end_time: timestamp.end_time / speed,
    })),
  };
}

const requests: CapturedRequest[] = [];
let server: ReturnType<typeof createServer>;
let baseUrl = "";

/** Answer one request with `body` as JSON. */
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) });
  response.end(text);
}

/** The two endpoints F§6 allows, and a 404 for everything else. */
function handle(request: IncomingMessage, response: ServerResponse): void {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({ method: request.method, url: request.url, contentType: request.headers["content-type"], body });

    if (request.method === "GET" && request.url === "/v1/audio/voices") {
      sendJson(response, 200, { voices: STUB_VOICES });
      return;
    }

    if (request.method === "POST" && request.url === "/dev/captioned_speech") {
      const asked = JSON.parse(body) as { voice: string; speed: number };
      if (asked.voice === FAILING_VOICE) {
        sendJson(response, 500, { detail: "the model is not loaded" });
        return;
      }
      if (asked.voice === UNTIMED_VOICE) {
        sendJson(response, 200, { audio: encodedAudio(BASE_FRAMES), timestamps: [] });
        return;
      }
      if (asked.voice === LATE_TOKEN_VOICE) {
        sendJson(response, 200, { audio: encodedAudio(LATE_TOKEN_FRAMES), timestamps: STUB_TIMESTAMPS });
        return;
      }
      if (!STUB_VOICES.includes(asked.voice)) {
        sendJson(response, 404, { detail: `no voice ${asked.voice}` });
        return;
      }
      sendJson(response, 200, speechAnswer(asked.speed));
      return;
    }

    sendJson(response, 404, { detail: `no route ${String(request.method)} ${String(request.url)}` });
  });
}

/** The engine under test, reaching the stub with the host's own `fetch` unless a case says otherwise. */
function stubEngine(options: Partial<KokoroEngineOptions> = {}) {
  return createKokoroEngine({ baseUrl, fetch: globalThis.fetch as KokoroFetch, ...options });
}

/** A transport that accepts a request and never answers it. */
const neverAnswers: KokoroFetch = () => new Promise(() => undefined);

/** The refusal `call` produced, so a test can read its code rather than only see that it threw. */
async function refusalOf(call: Promise<unknown>): Promise<KokoroEngineError | null> {
  const caught = await call.then(
    () => null,
    (cause: unknown) => cause,
  );
  return caught instanceof KokoroEngineError ? caught : null;
}

/** The speed the adapter last asked the service for. */
function lastSpeedAsked(): number {
  return (JSON.parse(requests.at(-1)?.body ?? "") as { speed: number }).speed;
}

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  // The host's fetch keeps its sockets open, so the server drops them before it is closed.
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

test("the adapter answers F§6's engine id and the voices the service lists, as kokoro:<id>", async () => {
  const engine = stubEngine();
  expect(engine.id).toBe("kokoro");

  const voices = await engine.listVoices();
  expect(voices).toEqual([
    { id: "kokoro:af_heart", engine: "kokoro", engineVoiceId: "af_heart", name: "af_heart", lang: "af" },
    { id: "kokoro:am_michael", engine: "kokoro", engineVoiceId: "am_michael", name: "am_michael", lang: "am" },
    { id: "kokoro:bf_emma", engine: "kokoro", engineVoiceId: "bf_emma", name: "bf_emma", lang: "bf" },
  ]);

  expect(requests.at(-1)?.method).toBe("GET");
  expect(requests.at(-1)?.url).toBe("/v1/audio/voices");
});

test("synthesis posts F§6's six fields to F§6's endpoint and nothing else", async () => {
  const engine = stubEngine();
  await engine.synthesize({ text: "Hello, dear world.", engineVoiceId: "af_heart", synthSpeed: 1 });

  const sent = requests.at(-1);
  expect(sent?.method).toBe("POST");
  expect(sent?.url).toBe("/dev/captioned_speech");
  expect(sent?.contentType).toBe("application/json");
  expect(JSON.parse(sent?.body ?? "")).toEqual({
    model: "kokoro",
    input: "Hello, dear world.",
    voice: "af_heart",
    speed: 1,
    response_format: "mp3",
    stream: false,
  });
});

test("the timestamps become integer milliseconds and the audio's own length is the duration", async () => {
  const engine = stubEngine();
  const result = await engine.synthesize({ text: "Hello, dear world.", engineVoiceId: "af_heart", synthSpeed: 1 });

  expect(result.mime).toBe("audio/mpeg");
  expect(result.audio.byteLength).toBe(417 * BASE_FRAMES);
  expect(readMp3DurationMs(result.audio)).toBe(BASE_DURATION_MS);
  expect(result.durationMs).toBe(BASE_DURATION_MS);
  expect(result.engineTokens).toEqual([
    { text: "Hello,", s: 0, e: 400 },
    { text: "dear", s: 400, e: 800 },
    { text: "world.", s: 800, e: 1200 },
  ]);
});

test("the duration is the later of the audio's own length and the last token's end", async () => {
  const engine = stubEngine();
  const result = await engine.synthesize({ text: "Hello, dear world.", engineVoiceId: LATE_TOKEN_VOICE, synthSpeed: 1 });

  expect(readMp3DurationMs(result.audio)).toBe(LATE_TOKEN_AUDIO_MS);
  expect(result.durationMs).toBe(1200);
});

test("an empty timestamps array means the engine timed nothing", async () => {
  const engine = stubEngine();
  const result = await engine.synthesize({ text: "Hello.", engineVoiceId: UNTIMED_VOICE, synthSpeed: 1 });

  expect(result.engineTokens).toBeNull();
  expect(result.durationMs).toBe(BASE_DURATION_MS);
});

test("the engine speed is clamped into F§6's 0.25 to 4.0", async () => {
  const engine = stubEngine();
  await engine.synthesize({ text: "Hello.", engineVoiceId: "af_heart", synthSpeed: 9 });
  expect(lastSpeedAsked()).toBe(4);
  await engine.synthesize({ text: "Hello.", engineVoiceId: "af_heart", synthSpeed: 0.1 });
  expect(lastSpeedAsked()).toBe(0.25);
  await engine.synthesize({ text: "Hello.", engineVoiceId: "af_heart", synthSpeed: 1.5 });
  expect(lastSpeedAsked()).toBe(1.5);
});

test("an HTTP failure and a voice the service does not have are both ENGINE_UNAVAILABLE", async () => {
  const engine = stubEngine();

  const failed = await refusalOf(engine.synthesize({ text: "Hello.", engineVoiceId: FAILING_VOICE, synthSpeed: 1 }));
  expect(failed?.code).toBe("ENGINE_UNAVAILABLE");
  expect(failed?.message).toContain("500");

  const unknown = await refusalOf(engine.synthesize({ text: "Hello.", engineVoiceId: "no-such-voice", synthSpeed: 1 }));
  expect(unknown?.code).toBe("ENGINE_UNAVAILABLE");
  expect(unknown?.message).toContain("404");

  const unreachable = await refusalOf(
    createKokoroEngine({ baseUrl: "http://127.0.0.1:1", fetch: globalThis.fetch as KokoroFetch }).listVoices(),
  );
  expect(unreachable?.code).toBe("ENGINE_UNAVAILABLE");
});

test("an engine that never answers is ENGINE_UNAVAILABLE rather than a hang", async () => {
  const engine = createKokoroEngine({ baseUrl, fetch: neverAnswers, timeoutMs: 20 });

  const refused = await refusalOf(engine.synthesize({ text: "Hello.", engineVoiceId: "af_heart", synthSpeed: 1 }));
  expect(refused?.code).toBe("ENGINE_UNAVAILABLE");
  expect(refused?.message).toContain("20 ms");

  const unlisted = await refusalOf(engine.listVoices());
  expect(unlisted?.code).toBe("ENGINE_UNAVAILABLE");
  expect(unlisted?.message).toContain("/v1/audio/voices");
});

test("a base URL with a trailing slash still addresses the two paths", async () => {
  const engine = stubEngine({ baseUrl: `${baseUrl}/` });
  await engine.listVoices();
  expect(requests.at(-1)?.url).toBe("/v1/audio/voices");
  await engine.synthesize({ text: "Hello.", engineVoiceId: "af_heart", synthSpeed: 1 });
  expect(requests.at(-1)?.url).toBe("/dev/captioned_speech");
});

test("the adapter reaches the service with the host's own fetch when none is injected", async () => {
  const engine = createKokoroEngine({ baseUrl });
  const voices = await engine.listVoices();
  expect(voices.map((voice) => voice.id)).toContain("kokoro:af_heart");
  const result = await engine.synthesize({ text: "Hello.", engineVoiceId: "af_heart", synthSpeed: 1 });
  expect(result.durationMs).toBe(BASE_DURATION_MS);
});

test("a faster speed is a shorter answer, which is what the conformance speed case measures", async () => {
  const engine = stubEngine();
  const slow = await engine.synthesize({ text: "Lectern reads this text aloud.", engineVoiceId: "af_heart", synthSpeed: 1 });
  const fast = await engine.synthesize({ text: "Lectern reads this text aloud.", engineVoiceId: "af_heart", synthSpeed: 2 });

  expect(slow.durationMs).toBe(BASE_DURATION_MS);
  expect(fast.durationMs).toBe(HALF_DURATION_MS);
});

test("the adapter passes every case of F§6's engine conformance suite", async () => {
  const results = await runTtsEngineConformance(stubEngine());
  expect(results.map((result) => result.name)).toEqual(ENGINE_CASES);
  expect(results.filter((result) => !result.ok)).toEqual([]);
});
