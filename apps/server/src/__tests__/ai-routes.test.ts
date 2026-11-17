/**
 * U-063's contract (F§9, F§7.2): the hub's AI routes end to end through `inject`, over the real hub — U-055's
 * SQLite file and U-056's document files under a temporary data directory — and U-062's mock endpoint as the
 * model.
 *
 * What these cases are for is the *state machine* rather than the summary: a request answers `running` and the
 * row behind it moves to `done` or to `error`, a second request answers the cache rather than the model, and a
 * row left `running` by a restart is an interruption rather than a job. The document's own text is the only
 * thing a case can steer the mock with, so a marker lives inside the document a case summarizes.
 *
 * Reading and writing gzip needs `node:zlib`, so this file stays outside the package's type-check program (its
 * test directories are excluded): vitest erases types instead of checking them and runs it as written.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { ErrorBodySchema, SummaryErrorSchema, type SummaryMode, type SummaryStatus, SummaryStatusSchema } from "@lectern/api-contract";
import { buildDocument, type DocumentModel } from "@lectern/core";
import type { FastifyInstance, InjectOptions } from "fastify";
import { expect, test } from "vitest";
import { z } from "zod";
import type { LlmCompletionRequest, LlmProvider } from "../ai/provider";
import { type BuildAppOptions, buildApp } from "../app";
import { loadConfig } from "../config";
import { type MockLlm, startMockLlm } from "../testing/mock-llm";

/** F§7.1's token floor is 32 characters; this one clears it and appears nowhere else. */
const TOKEN = "lectern-hub-test-token-0123456789";

/** The model F§7.1 names for the mock endpoint. */
const MODEL = "lectern-summary-test-model";

const AUTHORIZATION = { authorization: `Bearer ${TOKEN}` };
const JSON_HEADERS = { ...AUTHORIZATION, "content-type": "application/json" };

/** A valid document id that no document in this file is built from, for the not-found cases. */
const UNKNOWN_DOC_ID = "0123456789abcdef0123456789abcdef";

/** One short document: a single segment, so a case reaches the reduce step in one call. */
const SHORT_TEXT = "Alpha beta gamma. Delta epsilon zeta. Eta theta iota.";

/** F§7.2's error envelope: the shared one, or F§9's own code set beside it. */
const ErrorEnvelopeSchema = z.strictObject({ error: z.union([ErrorBodySchema.shape.error, SummaryErrorSchema]) });

/** What a case needs of an injected answer: its status, its parsed body and its raw bytes. */
interface Answer {
  statusCode: number;
  json(): unknown;
  rawPayload: Uint8Array;
}

interface Hub {
  app: FastifyInstance;
  dataDir: string;
}

/** A pause on the event loop, so a case can let a queued job run. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** A document of one paragraph, built the way F§5.1–F§5.4 build one. */
function documentOf(text: string): DocumentModel {
  return buildDocument([{ kind: "paragraph", text }], { source: { kind: "txt" } });
}

/** A model as F§7.2's upload carries it: the `DocumentModel` JSON, gzipped. */
function gzipped(model: DocumentModel): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(model)));
}

/** Build the hub over a temporary data directory, then close it and remove the directory. */
async function withHub(
  run: (hub: Hub) => Promise<void>,
  env: Readonly<Record<string, string>> = {},
  overrides: BuildAppOptions = {},
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "lectern-ai-"));
  const config = loadConfig({ LECTERN_TOKEN: TOKEN, LECTERN_DATA_DIR: dataDir, ...env });
  const app = await buildApp(config, overrides);
  try {
    await run({ app, dataDir });
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** The hub over a running mock endpoint: the two AI routes need a provider, and the mock is one. */
async function withMockHub(run: (hub: Hub, mock: MockLlm) => Promise<void>): Promise<void> {
  const mock = await startMockLlm();
  try {
    await withHub((hub) => run(hub, mock), { LLM_BASE_URL: mock.baseUrl, LLM_MODEL: MODEL });
  } finally {
    await mock.close();
  }
}

function postSummary(app: FastifyInstance, payload: InjectOptions["payload"]): Promise<Answer> {
  return app.inject({ method: "POST", url: "/v1/ai/summary", headers: JSON_HEADERS, payload });
}

function getSummary(app: FastifyInstance, docId: string, mode?: SummaryMode): Promise<Answer> {
  const query = mode === undefined ? "" : `?mode=${mode}`;
  return app.inject({ method: "GET", url: `/v1/ai/summary/${docId}${query}`, headers: AUTHORIZATION });
}

/** The AI code a refusal answered with, read through F§7.2's envelope. */
function refusalCode(answer: Answer): string {
  return ErrorEnvelopeSchema.parse(answer.json()).error.code;
}

/** The status one answer carries, read through the contract's own schema. */
function statusOf(answer: Answer): SummaryStatus {
  return SummaryStatusSchema.parse(answer.json());
}

/** Poll the status route until it reports `expected`, and answer what it reported there. */
async function waitForStatus(
  app: FastifyInstance,
  docId: string,
  mode: SummaryMode,
  expected: SummaryStatus["status"],
): Promise<SummaryStatus> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const status = statusOf(await getSummary(app, docId, mode));
    if (status.status === expected) return status;
    await sleep(10);
  }
  throw new Error(`the summary of ${docId} never reached ${expected}`);
}

/** A provider that answers F§9's reduce step itself, recording when each call starts and when it ends. */
function recordingProvider(events: string[]): LlmProvider {
  return {
    complete: async (request: LlmCompletionRequest): Promise<string> => {
      const name = request.user.includes("Alpha") ? "A" : "B";
      events.push(`start:${name}`);
      await sleep(10);
      events.push(`end:${name}`);
      return JSON.stringify({ summary: `A summary of ${name}.`, keyTakeaways: ["one", "two", "three", "four", "five"] });
    },
  };
}

test("a hub with no LLM configured refuses both AI routes with AI_DISABLED", async () => {
  await withHub(async ({ app }) => {
    const posted = await postSummary(app, { docId: UNKNOWN_DOC_ID, mode: "brief" });
    expect(posted.statusCode).toBe(503);
    expect(refusalCode(posted)).toBe("AI_DISABLED");

    const fetched = await getSummary(app, UNKNOWN_DOC_ID, "brief");
    expect(fetched.statusCode).toBe(503);
    expect(refusalCode(fetched)).toBe("AI_DISABLED");
  });
});

test("a document the hub holds no model for is MODEL_MISSING, and nothing is asked of the model", async () => {
  await withMockHub(async ({ app }, mock) => {
    const answer = await postSummary(app, { docId: UNKNOWN_DOC_ID, mode: "brief" });
    expect(answer.statusCode).toBe(404);
    expect(refusalCode(answer)).toBe("MODEL_MISSING");
    expect(mock.requests).toHaveLength(0);

    const missing = await getSummary(app, UNKNOWN_DOC_ID, "brief");
    expect(missing.statusCode).toBe(200);
    expect(statusOf(missing).status).toBe("none");
  });
});

test("a request answers 202 running, and polling reaches done with a result", async () => {
  await withMockHub(async ({ app }, mock) => {
    const document = documentOf(SHORT_TEXT);
    const uploaded = await app.inject({
      method: "PUT",
      url: `/v1/library/documents/${document.docId}/model`,
      headers: { ...AUTHORIZATION, "content-type": "application/gzip" },
      payload: gzipped(document),
    });
    expect(uploaded.statusCode).toBe(204);

    const started = await postSummary(app, { docId: document.docId, mode: "brief" });
    expect(started.statusCode).toBe(202);
    expect(statusOf(started).status).toBe("running");

    const finished = await waitForStatus(app, document.docId, "brief", "done");
    expect(finished.result?.model).toBe(MODEL);
    expect(finished.result?.summary.length).toBeGreaterThan(0);
    expect(finished.result?.keyTakeaways.length).toBeGreaterThan(0);
    expect(finished.error).toBeUndefined();
    expect(mock.requests.length).toBeGreaterThan(0);
  });
});

test("a second request answers the cached result without calling the model again", async () => {
  await withMockHub(async ({ app }, mock) => {
    const document = documentOf(SHORT_TEXT);
    await postSummary(app, { docId: document.docId, mode: "brief", document });
    const first = await waitForStatus(app, document.docId, "brief", "done");
    const calls = mock.requests.length;
    expect(calls).toBeGreaterThan(0);

    const again = await postSummary(app, { docId: document.docId, mode: "brief" });
    expect(again.statusCode).toBe(202);
    const cached = statusOf(again);
    expect(cached.status).toBe("done");
    expect(cached.result).toEqual(first.result);
    expect(mock.requests).toHaveLength(calls);
  });
});

test("an inline document is stored as the document's model", async () => {
  await withMockHub(async ({ app }) => {
    const document = documentOf(SHORT_TEXT);
    const started = await postSummary(app, { docId: document.docId, mode: "brief", document });
    expect(started.statusCode).toBe(202);

    const stored = await app.inject({ method: "GET", url: `/v1/library/documents/${document.docId}/model`, headers: AUTHORIZATION });
    expect(stored.statusCode).toBe(200);
    expect(JSON.parse(gunzipSync(stored.rawPayload).toString("utf8"))).toEqual(document);

    // The job the request started reads the model this case just read back, so let it finish before the hub closes.
    expect((await waitForStatus(app, document.docId, "brief", "done")).status).toBe("done");
  });
});

test("an inline document that describes another document is refused", async () => {
  await withMockHub(async ({ app }) => {
    const document = documentOf(SHORT_TEXT);
    const answer = await postSummary(app, { docId: UNKNOWN_DOC_ID, mode: "brief", document });
    expect(answer.statusCode).toBe(400);
    expect(refusalCode(answer)).toBe("BAD_REQUEST");
  });
});

test("a model endpoint that fails reaches an error with LLM_UNAVAILABLE", async () => {
  await withMockHub(async ({ app }) => {
    const document = documentOf(`${SHORT_TEXT} FORCE_ERROR`);
    await postSummary(app, { docId: document.docId, mode: "brief", document });

    const failed = await waitForStatus(app, document.docId, "brief", "error");
    expect(failed.error?.code).toBe("LLM_UNAVAILABLE");
    expect(failed.result).toBeUndefined();
  });
});

test("a running row present at start-up becomes an error with INTERRUPTED", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "lectern-ai-"));
  const mock = await startMockLlm();
  const env = { LECTERN_TOKEN: TOKEN, LECTERN_DATA_DIR: dataDir, LLM_BASE_URL: mock.baseUrl, LLM_MODEL: MODEL };
  const document = documentOf(SHORT_TEXT);

  try {
    // A hub whose provider never answers leaves its row `running`, which is exactly what a restart finds.
    const stalled = await buildApp(loadConfig(env), { llm: { complete: () => new Promise<string>(() => undefined) } });
    try {
      const started = await postSummary(stalled, { docId: document.docId, mode: "brief", document });
      expect(started.statusCode).toBe(202);
      expect(statusOf(started).status).toBe("running");
    } finally {
      await stalled.close();
    }

    const restarted = await buildApp(loadConfig(env));
    try {
      const recovered = statusOf(await getSummary(restarted, document.docId, "brief"));
      expect(recovered.status).toBe("error");
      expect(recovered.error?.code).toBe("INTERRUPTED");

      // A fresh request after the interruption starts a new job rather than answering the dead row.
      const again = await postSummary(restarted, { docId: document.docId, mode: "brief" });
      expect(again.statusCode).toBe(202);
      expect(statusOf(again).status).toBe("running");
      const finished = await waitForStatus(restarted, document.docId, "brief", "done");
      expect(finished.result?.model).toBe(MODEL);
    } finally {
      await restarted.close();
    }
  } finally {
    await mock.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("two documents requested together are processed one after the other", async () => {
  const events: string[] = [];
  await withHub(
    async ({ app }) => {
      const first = documentOf("Alpha alpha alpha alpha.");
      const second = documentOf("Bravo bravo bravo bravo.");

      const one = await postSummary(app, { docId: first.docId, mode: "brief", document: first });
      const two = await postSummary(app, { docId: second.docId, mode: "brief", document: second });
      expect(statusOf(one).status).toBe("running");
      expect(statusOf(two).status).toBe("running");

      await waitForStatus(app, first.docId, "brief", "done");
      await waitForStatus(app, second.docId, "brief", "done");
    },
    { LLM_MODEL: MODEL },
    { llm: recordingProvider(events) },
  );

  // One model slot: the second document's call starts only after the first document's has finished.
  expect(events).toEqual(["start:A", "end:A", "start:B", "end:B"]);
});
