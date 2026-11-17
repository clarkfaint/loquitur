/**
 * U-064's contract (F§7.2, F§9): the AI client, driven end to end against a real hub whose LLM endpoint is
 * F§9's own mock — a request and a wait reach a finished summary, and a second request answers the cached one —
 * plus the three behaviours a real job cannot be made to show: the ten-minute polling schedule, an abandoned
 * wait, and the refusal a hub with no LLM endpoint configured answers with.
 *
 * The hub is U-019's app over a temporary data directory, reached through U-021's `fetchFromFastify`, so no
 * socket is opened for it. The mock LLM is `@lectern/server/testing`'s own server on a loopback port, which is
 * the endpoint F§7.1's `LLM_BASE_URL` names.
 *
 * **The schedule and the abandonment are pinned over a stub transport, on purpose.** F§9's job finishes in
 * milliseconds against the mock, so a real one can never show the ten-minute ladder — a case that waited for it
 * would be asserting its own clock. A stub that answers `running` for ever is what makes the delays, the
 * deadline and the stop observable, and the two cases above it keep the real path covered.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as tick } from "node:timers/promises";
import { buildDocument, type Clock, type DocumentModel } from "@lectern/core";
import { FakeClock } from "@lectern/core/testing";
import { buildApp, loadConfig } from "@lectern/server";
import { type MockLlm, startMockLlm } from "@lectern/server/testing";
import { expect, test } from "vitest";
import { type AiClient, AiClientError, createAiClient } from "../ai-client";
import { fetchFromFastify } from "../testing/fastify-fetch";

/** F§7.1's token floor is 32 characters; this one clears it and appears nowhere else. */
const TOKEN = "lectern-ai-client-token-0123456789";

/** The address the client is pointed at. The adapter routes on the path, so the host is only a name. */
const BASE_URL = "http://127.0.0.1:8787";

/** The model F§7.1's `LLM_MODEL` names, which every result of this file records. */
const MODEL = "lectern-mock-model";

/** The prose every case summarizes: two sentences, written for this test, with none of F§9's reply markers. */
const PROSE = "The harbour wakes before the town does. Gulls walk the empty quay in ones and twos.";

/** A valid document id no document here is built from, for the cases that never reach a hub. */
const OTHER_DOC_ID = "0123456789abcdef0123456789abcdef";

/** A clock a case moves by hand, recording every delay anything asked it for. */
interface TestClock {
  clock: Clock;
  /** The delays requested, in order: F§9's polling schedule is read from this list. */
  delays: number[];
  advance(ms: number): void;
}

function testClock(): TestClock {
  const inner = new FakeClock();
  const delays: number[] = [];
  return {
    delays,
    advance: (ms) => inner.advance(ms),
    clock: {
      now: () => inner.now(),
      setTimeout: (callback, delayMs) => {
        delays.push(delayMs);
        return inner.setTimeout(callback, delayMs);
      },
      clearTimeout: (handle) => inner.clearTimeout(handle),
    },
  };
}

/**
 * Let everything in flight settle.
 *
 * A fake clock fires its timers synchronously, and the wait's poll chain resumes on microtasks — so a step of
 * the clock has to be followed by enough turns of the microtask queue for the next poll to be scheduled, and by
 * one real turn of the event loop, because the poll itself reaches a hub through `inject`.
 */
async function flush(turns = 8): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
  await tick(0);
}

/** Move the timeline forward and let the poll chain catch up. */
async function advance(clock: TestClock, ms: number): Promise<void> {
  clock.advance(ms);
  await flush();
}

/** A document of this test's own prose, built the way every document is (F§5.4). */
function document(title: string, text: string): DocumentModel {
  return buildDocument(
    [
      { kind: "heading", level: 1, text: title },
      { kind: "paragraph", text },
    ],
    {
      source: { kind: "txt" },
    },
  );
}

/** A client over one hub app, with F§7.1's token. */
function clientFor(app: Parameters<typeof fetchFromFastify>[0]): AiClient {
  return createAiClient({ baseUrl: BASE_URL, token: TOKEN, fetch: fetchFromFastify(app) });
}

/** Build a hub over a temporary data directory, then close it and remove the directory. */
async function withHub(run: (client: AiClient) => Promise<void>, env: Record<string, string> = {}): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "lectern-ai-client-"));
  const config = loadConfig({ LECTERN_TOKEN: TOKEN, LECTERN_DATA_DIR: dataDir, LECTERN_ENABLE_MOCK: "1", ...env });
  const app = await buildApp(config);
  try {
    await run(clientFor(app));
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** Build a hub pointed at F§9's mock LLM, and hand the mock over beside the client. */
async function withMockHub(run: (client: AiClient, llm: MockLlm) => Promise<void>): Promise<void> {
  const llm = await startMockLlm();
  try {
    await withHub(
      async (client) => {
        await run(client, llm);
      },
      { LLM_BASE_URL: llm.baseUrl, LLM_MODEL: MODEL },
    );
  } finally {
    await llm.close();
  }
}

/** The failure a call raised, or a failure of this test when the call raised none. */
async function failureOf(call: () => Promise<unknown>): Promise<Error> {
  try {
    await call();
  } catch (cause) {
    if (cause instanceof Error) return cause;
    throw cause;
  }
  throw new Error("the call was expected to fail");
}

/** The AI failure a call raised: F§9's refusals come back as this module's own error type and nothing else. */
async function aiFailureOf(call: () => Promise<unknown>): Promise<AiClientError> {
  const failure = await failureOf(call);
  if (!(failure instanceof AiClientError)) throw new Error(`the call failed with something else — ${failure.message}`);
  return failure;
}

/** Walk a wait to its end: each step of the clock gives the hub's own work a real chance to finish. */
async function walk(clock: TestClock, steps = 40): Promise<void> {
  for (let step = 0; step < steps; step += 1) await advance(clock, 5000);
}

/** A transport that always answers the same body, for the two cases that never reach a hub. */
function stubFetch(body: unknown, calls: string[]): typeof fetch {
  return async (input) => {
    calls.push(input.toString());
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("a request and a wait reach a finished summary", async () => {
  await withMockHub(async (client, llm) => {
    const doc = document("A morning on the quay", PROSE);

    const requested = await client.requestSummary(doc.docId, "brief", doc);
    expect(requested.status).toBe("running");

    const clock = testClock();
    const seen: string[] = [];
    const waiting = client.waitForSummary(doc.docId, "brief", {
      clock: clock.clock,
      onStatus: (status) => seen.push(status.status),
    });
    await walk(clock);
    const finished = await waiting;

    expect(finished.status).toBe("done");
    expect(finished.result?.summary.length ?? 0).toBeGreaterThan(0);
    expect(finished.result?.keyTakeaways.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(finished.result?.model).toBe(MODEL);
    expect(finished.result?.promptVersion.length ?? 0).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe("done");
    // The prompt the hub built reached F§9's endpoint, which is what makes this a real summary and not a stub.
    expect(llm.requests.length).toBeGreaterThan(0);
  });
});

test("a second request for the same document and mode answers the cached result", async () => {
  await withMockHub(async (client) => {
    const doc = document("A cached morning", PROSE);

    await client.requestSummary(doc.docId, "brief", doc);
    const clock = testClock();
    const waiting = client.waitForSummary(doc.docId, "brief", { clock: clock.clock });
    await walk(clock);
    const finished = await waiting;
    expect(finished.status).toBe("done");

    // F§9's cache key is `(docId, mode, model, promptVersion)`, and both halves of it still hold.
    const again = await client.requestSummary(doc.docId, "brief", doc);
    expect(again.status).toBe("done");
    expect(again.result).toEqual(finished.result);

    // The mode is half of that key: the other one has never been asked for, so it is a new job.
    const detailed = await client.requestSummary(doc.docId, "detailed", doc);
    expect(detailed.status).toBe("running");
  });
});

test("a hub with no LLM endpoint refuses with the AI code", async () => {
  await withHub(async (client) => {
    const doc = document("Nothing to summarize", PROSE);

    const asking = await aiFailureOf(async () => await client.requestSummary(doc.docId, "brief", doc));
    expect(asking.code).toBe("AI_DISABLED");
    expect(asking.status).toBe(503);
    expect(asking.offline).toBe(false);

    const reading = await aiFailureOf(async () => await client.getSummary(doc.docId, "brief"));
    expect(reading.code).toBe("AI_DISABLED");
    expect(reading.status).toBe(503);
  });
});

test("the wait polls at one, two and three seconds and then every five", async () => {
  const calls: string[] = [];
  const client = createAiClient({ baseUrl: BASE_URL, token: TOKEN, fetch: stubFetch({ status: "running" }, calls) });
  const clock = testClock();
  const waiting = client.waitForSummary(OTHER_DOC_ID, "detailed", { clock: clock.clock });

  // F§9's three opening delays, then the steady one, each asked for once the poll before it has answered.
  expect(clock.delays).toEqual([1000]);
  await advance(clock, 1000);
  expect(clock.delays).toEqual([1000, 2000]);
  await advance(clock, 2000);
  expect(clock.delays).toEqual([1000, 2000, 3000]);
  await advance(clock, 3000);
  expect(clock.delays).toEqual([1000, 2000, 3000, 5000]);
  await advance(clock, 5000);
  expect(clock.delays).toEqual([1000, 2000, 3000, 5000, 5000]);
  expect(calls.length).toBe(4);

  // Ten minutes are the whole of it: past them the wait answers what it has rather than asking again.
  await walk(clock, 130);
  expect(await waiting).toEqual({ status: "running" });
  expect(calls.length).toBeLessThanOrEqual(Math.ceil(600_000 / 5000) + 3);
});

test("an abandoned wait stops polling and rejects", async () => {
  const calls: string[] = [];
  const client = createAiClient({ baseUrl: BASE_URL, token: TOKEN, fetch: stubFetch({ status: "running" }, calls) });
  const clock = testClock();
  const controller = new AbortController();
  const waiting = client.waitForSummary(OTHER_DOC_ID, "brief", { clock: clock.clock, signal: controller.signal });

  await advance(clock, 1000);
  expect(calls.length).toBe(1);

  controller.abort();
  const abandoned = await failureOf(async () => await waiting);
  expect(abandoned.name).toBe("AbortError");

  // The timer the wait had pending went with it: nothing more is asked of the hub.
  await walk(clock);
  expect(calls.length).toBe(1);
});
