/**
 * U-021's contract (F§7.2): the typed client against a real hub app running F§6's mock engine — every phase-1
 * route round-trips, a wrong token is refused with the hub's own code, a transport that rejects reports the hub
 * as offline, and an answer that is not the contract's shape is reported as the client's own failure.
 *
 * No socket is opened for the hub: it is built by `buildApp` and reached through `fetchFromFastify`, so the
 * client exercises the hub's routes, its authentication, its TTS cache and its parsers. The one address really
 * fetched is a loopback stub serving one page, which is what the `{ url }` form of the parse route needs.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ParseResponseSchema } from "@lectern/api-contract";
import { buildApp, loadConfig } from "@lectern/server";
import { expect, test } from "vitest";
import { createHubClient, type HubClient } from "../client";
import { HubClientError } from "../errors";
import { fetchFromFastify, type InjectingApp } from "../testing/fastify-fetch";

/** F§7.1's token floor is 32 characters; this one clears it and appears nowhere else. */
const TOKEN = "lectern-api-client-token-0123456789";

/** F§6's golden chunk id for `['mock', 'mock-a', '1.00', 'Hello, world.']`, quoted verbatim. */
const GOLDEN_CHUNK_ID = "3bfbfd2ad841c9c08af4bcc1c7ccb8560d318c76";

/** The address the client is pointed at. The adapter routes on the path, so the host is only a name. */
const BASE_URL = "http://127.0.0.1:8787";

/** The text every synthesis case uses, which is the text the golden id names. */
const TEXT = "Hello, world.";

/** The voice F§6's mock engine offers first. */
const VOICE = "mock:mock-a";

/** The prose the parse cases read: two sentences, written for this test. */
const PROSE = "Lectern reads a document aloud. Every sentence is spoken in order.";

/** A hub app plus a client pointed at it. */
interface Hub {
  client: HubClient;
  app: InjectingApp;
}

/** A client over one hub app, with the token a case wants it to present. */
function clientFor(app: InjectingApp, token: string): HubClient {
  return createHubClient({ baseUrl: BASE_URL, token, fetch: fetchFromFastify(app) });
}

/** The failure a call raised, or a failure of this test when the call raised none. */
async function failureOf(call: () => Promise<unknown>): Promise<HubClientError> {
  try {
    await call();
  } catch (cause) {
    if (cause instanceof HubClientError) return cause;
    throw cause;
  }
  throw new Error("the call was expected to fail");
}

/** Build the hub over a temporary data directory, then close it and remove the directory. */
async function withHub(run: (hub: Hub) => Promise<void>, env: Record<string, string> = {}): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "lectern-api-client-"));
  const config = loadConfig({ LECTERN_TOKEN: TOKEN, LECTERN_DATA_DIR: dataDir, LECTERN_ENABLE_MOCK: "1", ...env });
  const app = await buildApp(config);
  try {
    await run({ app, client: clientFor(app, TOKEN) });
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** One loopback page, served on a port the operating system picks: the address a `{ url }` parse fetches. */
async function servePage(html: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the stub page has no address");
  return {
    url: `http://127.0.0.1:${address.port}/article.html`,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

test("the health probe, the voice list, one chunk and its audio round-trip", async () => {
  await withHub(async ({ client }) => {
    const health = await client.health();
    expect(health.ok).toBe(true);
    expect(health.engines).toEqual(["mock"]);
    expect(health.version.length).toBeGreaterThan(0);

    const voices = await client.voices();
    expect(voices.map((voice) => voice.id)).toEqual(["mock:mock-a", "mock:mock-b"]);

    const tts = await client.tts({ text: TEXT, voiceId: VOICE });
    expect(tts.chunkId).toBe(GOLDEN_CHUNK_ID);
    expect(tts.mime).toBe("audio/wav");
    expect(tts.durationMs).toBeGreaterThan(0);
    expect(tts.timings.map((timing) => timing.i)).toEqual([0, 1]);
    expect(tts.timingSource).toBe("engine");
    expect(tts.audioPath).toBe(`/v1/tts/audio/${GOLDEN_CHUNK_ID}`);

    const audio = await client.ttsAudio(tts.chunkId);
    expect(audio.length).toBeGreaterThan(44);
    expect([...audio.subarray(0, 4)]).toEqual([0x52, 0x49, 0x46, 0x46]);
  });
});

test("the raw-bytes and the text forms of the parse route round-trip", async () => {
  await withHub(async ({ client }) => {
    const uploaded = await client.parseFile(new TextEncoder().encode(PROSE), "note.txt", "text/plain");
    expect(uploaded.document.source.kind).toBe("txt");
    expect(uploaded.document.source.mime).toBe("text/plain");
    expect(uploaded.document.sentenceCount).toBe(2);
    expect(uploaded.anchors).toBeUndefined();

    const stated = await client.parseText(PROSE, "A stated title");
    expect(stated.document.title).toBe("A stated title");
    expect(stated.document.sentenceCount).toBe(2);
    expect(ParseResponseSchema.parse(stated).document.docId).toBe(uploaded.document.docId);
  });
});

test("the url form of the parse route reads a page the hub fetches", async () => {
  const page = await servePage(
    `<!doctype html><html lang="en"><head><title>Loopback page</title></head><body><p>${PROSE}</p></body></html>`,
  );
  try {
    await withHub(
      async ({ client }) => {
        const parsed = await client.parseUrl(page.url);
        expect(parsed.document.source.kind).toBe("url");
        expect(parsed.document.source.uri).toBe(page.url);
        expect(parsed.document.title).toBe("Loopback page");
        expect(parsed.document.sentenceCount).toBe(2);
      },
      { LECTERN_ALLOW_PRIVATE_FETCH: "1" },
    );
  } finally {
    await page.close();
  }
});

test("the token travels in the header and never in the URL", async () => {
  await withHub(async ({ app }) => {
    const adapter = fetchFromFastify(app);
    const seen: string[] = [];
    const recording: typeof fetch = async (input, init) => {
      seen.push(input.toString());
      return await adapter(input, init);
    };
    const client = createHubClient({ baseUrl: BASE_URL, token: TOKEN, fetch: recording });
    const voices = await client.voices();
    expect(voices.length).toBe(2);
    expect(seen).toEqual([`${BASE_URL}/v1/voices`]);
    expect(seen.every((url) => !url.includes(TOKEN))).toBe(true);
  });
});

test("a wrong token is refused with the hub's own code", async () => {
  await withHub(async ({ app }) => {
    const client = clientFor(app, "n".repeat(TOKEN.length));
    const error = await failureOf(async () => await client.voices());
    expect(error.code).toBe("UNAUTHORIZED");
    expect(error.status).toBe(401);
    expect(error.offline).toBe(false);
  });
});

test("a voice this hub cannot serve is refused with the hub's own code", async () => {
  await withHub(async ({ client }) => {
    const error = await failureOf(async () => await client.tts({ text: TEXT, voiceId: "mock:mock-z" }));
    expect(error.code).toBe("UNKNOWN_VOICE");
    expect(error.status).toBe(404);
    expect(error.offline).toBe(false);
  });
});

test("a transport that rejects reports the hub as offline", async () => {
  const down: typeof fetch = async () => {
    throw new TypeError("the hub is unreachable");
  };
  const client = createHubClient({ baseUrl: BASE_URL, token: TOKEN, fetch: down });
  const error = await failureOf(async () => await client.health());
  expect(error.offline).toBe(true);
  expect(error.status).toBe(0);
  expect(error.code).toBe("ENGINE_UNAVAILABLE");
  expect(error.message).toContain("the hub is unreachable");
});

test("an answer that is not the contract's shape is reported as the client's own failure", async () => {
  const junk: typeof fetch = async () => new Response("not json", { status: 200, headers: { "content-type": "text/plain" } });
  const client = createHubClient({ baseUrl: BASE_URL, token: TOKEN, fetch: junk });
  const error = await failureOf(async () => await client.health());
  expect(error.code).toBe("INTERNAL");
  expect(error.status).toBe(200);
  expect(error.offline).toBe(false);
});
