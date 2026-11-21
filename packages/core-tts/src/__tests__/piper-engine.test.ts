/**
 * U-017's contract (F§6): the Piper adapter against a local stub of the only two endpoints it may call.
 *
 * The stub is a real `node:http` server on a free port — no test here touches a Piper service. Its audio is
 * built rather than recorded: the sample count follows the `length_scale` the adapter asks for, so the duration
 * the adapter reads out of the WAV header is the arithmetic its own request implies and the conformance suite's
 * speed case can hold. Every voice the adapter answers with came out of the stub's own voice response; this
 * file never tells the adapter what a voice list is.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createPiperEngine, PiperEngineError, type PiperEngineOptions, type PiperFetch } from "../piper-engine";
import { runTtsEngineConformance } from "../testing/engine-conformance";
import { encodeWavPcm16, readWavDurationMs } from "../wav";

/** The voices the stub offers: a bare id, one carried by an object, and a third language. */
const STUB_VOICES: readonly (string | { name: string })[] = [
  "en_US-lessac-medium",
  { name: "de_DE-thorsten-medium" },
  "fr_FR-siwis-medium",
];

/** The ids those entries name, which is what the stub recognizes on a synthesis request. */
const STUB_VOICE_IDS = ["en_US-lessac-medium", "de_DE-thorsten-medium", "fr_FR-siwis-medium"];

/** The stub's WAV format: 22 050 Hz mono 16-bit PCM, the format F§6's mock engine emits as well. */
const SAMPLE_RATE = 22050;
/** The samples one second of audio holds at `length_scale` 1, so a duration is `1000 ms × length_scale`. */
const BASE_SAMPLES = SAMPLE_RATE;
const BASE_DURATION_MS = 1000;
const HALF_DURATION_MS = 500;

/** Two voices only the stub knows: one whose backend fails, one whose answer is not audio at all. */
const FAILING_VOICE = "server-error";
const BROKEN_AUDIO_VOICE = "broken-audio";

/** Four bytes that are no RIFF/WAVE container, for the voice whose answer the adapter cannot read. */
const NOT_A_WAV = new Uint8Array([1, 2, 3, 4]);

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

/** The stub's audio for one request: a whole number of samples for the `length_scale` it asked for. */
function wavFor(lengthScale: number): Uint8Array {
  return encodeWavPcm16(new Int16Array(Math.max(1, Math.round(BASE_SAMPLES * lengthScale))), SAMPLE_RATE);
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

/** Answer one request with bytes, as a speech service answers audio. */
function sendBytes(response: ServerResponse, status: number, bytes: Uint8Array): void {
  response.writeHead(status, { "content-type": "audio/wav", "content-length": String(bytes.byteLength) });
  response.end(Buffer.from(bytes));
}

/** The two endpoints F§6 allows, and a 404 for everything else. */
function handle(request: IncomingMessage, response: ServerResponse): void {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({ method: request.method, url: request.url, contentType: request.headers["content-type"], body });

    if (request.method === "GET" && request.url === "/voices") {
      sendJson(response, 200, { voices: STUB_VOICES });
      return;
    }

    if (request.method === "POST" && request.url === "/synthesize") {
      const asked = JSON.parse(body) as { voice: string; length_scale: number };
      if (asked.voice === FAILING_VOICE) {
        sendJson(response, 500, { detail: "the model is not loaded" });
        return;
      }
      if (asked.voice === BROKEN_AUDIO_VOICE) {
        sendBytes(response, 200, NOT_A_WAV);
        return;
      }
      if (!STUB_VOICE_IDS.includes(asked.voice)) {
        sendJson(response, 404, { detail: `no voice ${asked.voice}` });
        return;
      }
      sendBytes(response, 200, wavFor(asked.length_scale));
      return;
    }

    sendJson(response, 404, { detail: `no route ${String(request.method)} ${String(request.url)}` });
  });
}

/** The engine under test, reaching the stub with the host's own `fetch` unless a case says otherwise. */
function stubEngine(options: Partial<PiperEngineOptions> = {}) {
  return createPiperEngine({ baseUrl, fetch: globalThis.fetch as PiperFetch, ...options });
}

/** A transport that accepts a request and never answers it. */
const neverAnswers: PiperFetch = () => new Promise(() => undefined);

/** A transport that answers one JSON value whatever the URL: a service whose shape this adapter has to refuse. */
function answersJson(value: unknown): PiperFetch {
  return async () => ({ ok: true, status: 200, json: async () => value, arrayBuffer: async () => new ArrayBuffer(0) });
}

/** The refusal `call` produced, so a test can read its code rather than only see that it threw. */
async function refusalOf(call: Promise<unknown>): Promise<PiperEngineError | null> {
  const caught = await call.then(
    () => null,
    (cause: unknown) => cause,
  );
  return caught instanceof PiperEngineError ? caught : null;
}

/** The `length_scale` the adapter last asked the service for. */
function lastLengthScale(): number {
  return (JSON.parse(requests.at(-1)?.body ?? "") as { length_scale: number }).length_scale;
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

test("the adapter answers F§6's engine id and maps each service voice to piper:<name>", async () => {
  const engine = stubEngine();
  expect(engine.id).toBe("piper");

  const voices = await engine.listVoices();
  expect(voices).toEqual([
    { id: "piper:en_US-lessac-medium", engine: "piper", engineVoiceId: "en_US-lessac-medium", name: "en_US-lessac-medium", lang: "en" },
    {
      id: "piper:de_DE-thorsten-medium",
      engine: "piper",
      engineVoiceId: "de_DE-thorsten-medium",
      name: "de_DE-thorsten-medium",
      lang: "de",
    },
    { id: "piper:fr_FR-siwis-medium", engine: "piper", engineVoiceId: "fr_FR-siwis-medium", name: "fr_FR-siwis-medium", lang: "fr" },
  ]);

  expect(requests.at(-1)?.method).toBe("GET");
  expect(requests.at(-1)?.url).toBe("/voices");
  expect(requests.at(-1)?.contentType).toBeUndefined();
  expect(requests.at(-1)?.body).toBe("");
});

test("synthesis posts F§6's three fields to F§6's endpoint and nothing else", async () => {
  const engine = stubEngine();
  await engine.synthesize({ text: "Hello, dear world.", engineVoiceId: "en_US-lessac-medium", synthSpeed: 1 });

  const sent = requests.at(-1);
  expect(sent?.method).toBe("POST");
  expect(sent?.url).toBe("/synthesize");
  expect(sent?.contentType).toBe("application/json");
  expect(JSON.parse(sent?.body ?? "")).toEqual({ text: "Hello, dear world.", voice: "en_US-lessac-medium", length_scale: 1 });
});

test("length_scale is the inverse of synthSpeed and the duration comes out of the WAV header", async () => {
  const engine = stubEngine();
  const slow = await engine.synthesize({ text: "Lectern reads this text aloud.", engineVoiceId: "en_US-lessac-medium", synthSpeed: 1 });

  expect(lastLengthScale()).toBe(1);
  expect(slow.mime).toBe("audio/wav");
  expect(slow.audio.byteLength).toBe(44 + BASE_SAMPLES * 2);
  expect(readWavDurationMs(slow.audio)).toBe(BASE_DURATION_MS);
  expect(slow.durationMs).toBe(BASE_DURATION_MS);
  expect(slow.engineTokens).toBeNull();

  const fast = await engine.synthesize({ text: "Lectern reads this text aloud.", engineVoiceId: "en_US-lessac-medium", synthSpeed: 2 });
  expect(lastLengthScale()).toBe(0.5);
  expect(fast.durationMs).toBe(HALF_DURATION_MS);
  expect(fast.engineTokens).toBeNull();
});

test("a faster speed is a shorter answer, which is what the conformance speed case measures", async () => {
  const engine = stubEngine();
  const slow = await engine.synthesize({ text: "Lectern reads this text aloud.", engineVoiceId: "en_US-lessac-medium", synthSpeed: 1 });
  const fast = await engine.synthesize({ text: "Lectern reads this text aloud.", engineVoiceId: "en_US-lessac-medium", synthSpeed: 2 });

  expect(slow.durationMs).toBe(BASE_DURATION_MS);
  expect(fast.durationMs).toBe(HALF_DURATION_MS);
});

test("an HTTP failure, an unknown voice and an unreachable service are all ENGINE_UNAVAILABLE", async () => {
  const engine = stubEngine();

  const failed = await refusalOf(engine.synthesize({ text: "Hello.", engineVoiceId: FAILING_VOICE, synthSpeed: 1 }));
  expect(failed?.code).toBe("ENGINE_UNAVAILABLE");
  expect(failed?.message).toContain("500");

  const unknown = await refusalOf(engine.synthesize({ text: "Hello.", engineVoiceId: "no-such-voice", synthSpeed: 1 }));
  expect(unknown?.code).toBe("ENGINE_UNAVAILABLE");
  expect(unknown?.message).toContain("404");

  const unreachable = await refusalOf(
    createPiperEngine({ baseUrl: "http://127.0.0.1:1", fetch: globalThis.fetch as PiperFetch }).listVoices(),
  );
  expect(unreachable?.code).toBe("ENGINE_UNAVAILABLE");
});

test("audio the adapter cannot read is ENGINE_UNAVAILABLE rather than a duration of zero", async () => {
  const engine = stubEngine();

  const refused = await refusalOf(engine.synthesize({ text: "Hello.", engineVoiceId: BROKEN_AUDIO_VOICE, synthSpeed: 1 }));
  expect(refused?.code).toBe("ENGINE_UNAVAILABLE");
  expect(refused?.message).toContain("no readable duration");
});

test("a service that never answers is ENGINE_UNAVAILABLE rather than a hang", async () => {
  const engine = createPiperEngine({ baseUrl, fetch: neverAnswers, timeoutMs: 20 });

  const refused = await refusalOf(engine.synthesize({ text: "Hello.", engineVoiceId: "en_US-lessac-medium", synthSpeed: 1 }));
  expect(refused?.code).toBe("ENGINE_UNAVAILABLE");
  expect(refused?.message).toContain("20 ms");

  const unlisted = await refusalOf(engine.listVoices());
  expect(unlisted?.code).toBe("ENGINE_UNAVAILABLE");
  expect(unlisted?.message).toContain("/voices");
});

test("piper-tts 1.8.0's own answer, an object keyed by voice name, is read as that service's voices", async () => {
  const answer = {
    "en_US-lessac-medium": { audio: { quality: "medium", sample_rate: 22050 }, language: { code: "en_US" } },
    "de_DE-thorsten-medium": { audio: { quality: "medium", sample_rate: 22050 }, language: { code: "de_DE" } },
  };
  const engine = createPiperEngine({ baseUrl, fetch: answersJson(answer) });
  const voices = await engine.listVoices();
  expect(voices.map((voice) => voice.id)).toEqual(["piper:en_US-lessac-medium", "piper:de_DE-thorsten-medium"]);
  expect(voices.map((voice) => voice.lang)).toEqual(["en", "de"]);
});

test("a voice list this adapter cannot read is ENGINE_UNAVAILABLE rather than an empty list", async () => {
  for (const value of [
    { nope: true },
    "not a list",
    ["", "en_US-lessac-medium"],
    { voices: "en_US-lessac-medium" },
    { "en_US-lessac-medium": "not a config" },
  ]) {
    const engine = createPiperEngine({ baseUrl, fetch: answersJson(value) });
    const refused = await refusalOf(engine.listVoices());
    expect(refused?.code).toBe("ENGINE_UNAVAILABLE");
    expect(refused?.message).toContain("voice list");
  }
});

test("a base URL with a trailing slash still addresses the two paths", async () => {
  const engine = stubEngine({ baseUrl: `${baseUrl}/` });
  await engine.listVoices();
  expect(requests.at(-1)?.url).toBe("/voices");
  await engine.synthesize({ text: "Hello.", engineVoiceId: "en_US-lessac-medium", synthSpeed: 1 });
  expect(requests.at(-1)?.url).toBe("/synthesize");
});

test("the adapter reaches the service with the host's own fetch when none is injected", async () => {
  const engine = createPiperEngine({ baseUrl });
  const voices = await engine.listVoices();
  expect(voices.map((voice) => voice.id)).toContain("piper:en_US-lessac-medium");
  const result = await engine.synthesize({ text: "Hello.", engineVoiceId: "en_US-lessac-medium", synthSpeed: 1 });
  expect(result.durationMs).toBe(BASE_DURATION_MS);
});

test("the adapter passes every case of F§6's engine conformance suite", async () => {
  const results = await runTtsEngineConformance(stubEngine());
  expect(results.map((result) => result.name)).toEqual(ENGINE_CASES);
  expect(results.filter((result) => !result.ok)).toEqual([]);
});
