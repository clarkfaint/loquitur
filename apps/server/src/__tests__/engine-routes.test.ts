/**
 * U-019's contract (F§7.1–F§7.3): the hub end to end through `inject` — the health probe without a token, the
 * bearer check on every other route, the voice list, one synthesized chunk held to F§6's golden id, the shared
 * cache, the audio route with its immutable header and its byte ranges, and the four refusals.
 *
 * The engines are F§6's mock engine behind a counter, so a case can assert what the hub asked an engine for: a
 * second identical request, and ten concurrent ones, must reach it once (F§7.3). The data directory is a
 * temporary directory the case creates and removes; no server is started, and nothing here touches a network.
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorBodySchema, HealthResponseSchema, type TtsResponse, TtsResponseSchema, VoicesResponseSchema } from "@lectern/api-contract";
import { createMockEngine, type TtsEngine } from "@lectern/core-tts";
import type { FastifyInstance } from "fastify";
import { expect, test } from "vitest";
import { buildApp } from "../app";
import { loadConfig } from "../config";
import { createHubEngines } from "../context";

/** F§7.1's token floor is 32 characters; this one clears it and appears nowhere else. */
const TOKEN = "lectern-hub-test-token-0123456789";

/** F§6's golden chunk id for `['mock', 'mock-a', '1.00', 'Hello, world.']`, quoted verbatim. */
const GOLDEN_CHUNK_ID = "3bfbfd2ad841c9c08af4bcc1c7ccb8560d318c76";

/** The text every synthesis case uses, which is the text that golden id names. */
const TEXT = "Hello, world.";

const AUTHORIZATION = { authorization: `Bearer ${TOKEN}` };
const JSON_HEADERS = { ...AUTHORIZATION, "content-type": "application/json" };

/** The bodies a synthesis case accepts and refuses. */
const ACCEPTED_BODY = { text: TEXT, voiceId: "mock:mock-a" };

interface Hub {
  app: FastifyInstance;
  dataDir: string;
  engineCalls: () => number;
}

/** A response body as data, so every answer is read through the contract's own schema. */
function body(response: { json(): unknown }): unknown {
  return response.json() as unknown;
}

/** The one synthesis request every cache, audio and refusal case starts from. */
function ttsRequest(payload: unknown) {
  return { method: "POST" as const, url: "/v1/tts", headers: JSON_HEADERS, payload };
}

/** A mock engine behind a counter, so a case can see how often the hub reached for it (F§7.3). */
function countedMockEngine(): { engine: TtsEngine; calls: () => number } {
  const mock = createMockEngine();
  let calls = 0;
  return {
    engine: {
      id: mock.id,
      listVoices: () => mock.listVoices(),
      synthesize: async (request) => {
        calls += 1;
        return await mock.synthesize(request);
      },
    },
    calls: () => calls,
  };
}

/** Build the hub over a temporary data directory, then close it and remove the directory. */
async function withHub(run: (hub: Hub) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "lectern-hub-"));
  const counted = countedMockEngine();
  const config = loadConfig({ LECTERN_TOKEN: TOKEN, LECTERN_DATA_DIR: dataDir, LECTERN_ENABLE_MOCK: "1" });
  const app = await buildApp(config, { engines: createHubEngines([counted.engine]) });
  try {
    await run({ app, dataDir, engineCalls: counted.calls });
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** One accepted synthesis, as the route answered it. */
async function synthesizeOnce(app: FastifyInstance): Promise<TtsResponse> {
  const response = await app.inject(ttsRequest(ACCEPTED_BODY));
  expect(response.statusCode).toBe(200);
  return TtsResponseSchema.parse(body(response));
}

test("the health probe answers without a token and names the enabled engines", async () => {
  await withHub(async ({ app }) => {
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    const health = HealthResponseSchema.parse(body(response));
    expect(health.ok).toBe(true);
    expect(health.engines).toEqual(["mock"]);
    expect(health.version.length).toBeGreaterThan(0);
  });
});

test("every other route refuses a missing token and a wrong one", async () => {
  await withHub(async ({ app }) => {
    const requests = [
      { method: "GET" as const, url: "/v1/voices", headers: {} },
      { method: "POST" as const, url: "/v1/tts", headers: { "content-type": "application/json" }, payload: ACCEPTED_BODY },
      { method: "GET" as const, url: `/v1/tts/audio/${GOLDEN_CHUNK_ID}`, headers: {} },
    ];
    for (const request of requests) {
      const missing = await app.inject(request);
      expect(missing.statusCode).toBe(401);
      expect(ErrorBodySchema.parse(body(missing)).error.code).toBe("UNAUTHORIZED");
      const wrong = await app.inject({ ...request, headers: { ...request.headers, authorization: `Bearer ${"n".repeat(TOKEN.length)}` } });
      expect(wrong.statusCode).toBe(401);
      expect(ErrorBodySchema.parse(body(wrong)).error.code).toBe("UNAUTHORIZED");
    }
  });
});

test("the voice list carries both mock voices", async () => {
  await withHub(async ({ app }) => {
    const response = await app.inject({ method: "GET", url: "/v1/voices", headers: AUTHORIZATION });
    expect(response.statusCode).toBe(200);
    const voices = VoicesResponseSchema.parse(body(response));
    expect(voices.map((voice) => voice.id)).toEqual(["mock:mock-a", "mock:mock-b"]);
  });
});

test("synthesis answers F§6's golden chunk id with one timing per word", async () => {
  await withHub(async ({ app, engineCalls }) => {
    const tts = await synthesizeOnce(app);
    expect(tts.chunkId).toBe(GOLDEN_CHUNK_ID);
    expect(tts.mime).toBe("audio/wav");
    expect(tts.timings.map((timing) => timing.i)).toEqual([0, 1]);
    expect(tts.durationMs).toBeGreaterThan(0);
    expect(tts.audioPath).toBe(`/v1/tts/audio/${GOLDEN_CHUNK_ID}`);
    expect(tts.timingSource).toBe("engine");
    expect(engineCalls()).toBe(1);
  });
});

test("a second identical request is answered from the cache on disk", async () => {
  await withHub(async ({ app, dataDir, engineCalls }) => {
    await synthesizeOnce(app);
    await synthesizeOnce(app);
    expect(engineCalls()).toBe(1);
    const shard = join(dataDir, "tts-cache", GOLDEN_CHUNK_ID.slice(0, 2));
    expect((await readdir(shard)).sort()).toEqual([`${GOLDEN_CHUNK_ID}.json`, `${GOLDEN_CHUNK_ID}.wav`]);
  });
});

test("ten concurrent identical requests reach the engine once", async () => {
  await withHub(async ({ app, engineCalls }) => {
    const responses = await Promise.all(Array.from({ length: 10 }, async () => await app.inject(ttsRequest(ACCEPTED_BODY))));
    for (const response of responses) {
      expect(response.statusCode).toBe(200);
      expect(TtsResponseSchema.parse(body(response)).chunkId).toBe(GOLDEN_CHUNK_ID);
    }
    expect(engineCalls()).toBe(1);
  });
});

test("the audio route serves the bytes immutably and honours a byte range", async () => {
  await withHub(async ({ app }) => {
    const tts = await synthesizeOnce(app);
    const audio = await app.inject({ method: "GET", url: tts.audioPath, headers: AUTHORIZATION });
    expect(audio.statusCode).toBe(200);
    expect(audio.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(audio.headers["content-type"]).toBe(tts.mime);
    expect(audio.headers["accept-ranges"]).toBe("bytes");
    expect([...audio.rawPayload.subarray(0, 4)]).toEqual([0x52, 0x49, 0x46, 0x46]);
    const ranged = await app.inject({ method: "GET", url: tts.audioPath, headers: { ...AUTHORIZATION, range: "bytes=0-3" } });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers["content-range"]).toBe(`bytes 0-3/${audio.rawPayload.length}`);
    expect([...ranged.rawPayload]).toEqual([0x52, 0x49, 0x46, 0x46]);
  });
});

test("text longer than F§7.2's limit is refused without reaching an engine", async () => {
  await withHub(async ({ app, engineCalls }) => {
    const response = await app.inject(ttsRequest({ text: "a".repeat(1001), voiceId: "mock:mock-a" }));
    expect(response.statusCode).toBe(400);
    expect(ErrorBodySchema.parse(body(response)).error.code).toBe("BAD_REQUEST");
    expect(engineCalls()).toBe(0);
  });
});

test("a voice id this hub cannot serve is refused with UNKNOWN_VOICE", async () => {
  await withHub(async ({ app, engineCalls }) => {
    for (const voiceId of ["mock:mock-z", "elsewhere:voice", "not-a-voice"]) {
      const response = await app.inject(ttsRequest({ text: TEXT, voiceId }));
      expect(response.statusCode).toBe(404);
      expect(ErrorBodySchema.parse(body(response)).error.code).toBe("UNKNOWN_VOICE");
    }
    expect(engineCalls()).toBe(0);
  });
});

test("a chunk id that is not 40 hexadecimal characters is refused", async () => {
  await withHub(async ({ app }) => {
    for (const chunkId of ["..%2F..%2Fetc%2Fpasswd", "g".repeat(40), `${GOLDEN_CHUNK_ID.slice(0, 39)}z`]) {
      const response = await app.inject({ method: "GET", url: `/v1/tts/audio/${chunkId}`, headers: AUTHORIZATION });
      expect(response.statusCode).toBe(400);
      expect(ErrorBodySchema.parse(body(response)).error.code).toBe("BAD_REQUEST");
    }
    const unknown = await app.inject({ method: "GET", url: `/v1/tts/audio/${"0".repeat(40)}`, headers: AUTHORIZATION });
    expect(unknown.statusCode).toBe(404);
    expect(ErrorBodySchema.parse(body(unknown)).error.code).toBe("NOT_FOUND");
  });
});
