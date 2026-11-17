/**
 * U-062's contract (F§9): the OpenAI-compatible adapter, one field at a time, against the mock endpoint this
 * package ships under `@lectern/server/testing`, so no case here needs a model, a GPU or a network.
 *
 * The cases that need a transport this host cannot produce — a socket that never settles, a connection that
 * is refused, an answer carrying no choices at all — inject their own `fetch`, which is the adapter's own
 * seam, and the mock's own reply rules are exercised through prompts that name them.
 */

import { SUMMARY_LIMITS, type SummaryMode, SummaryModeSchema } from "@lectern/api-contract";
import { expect, test } from "vitest";
import { z } from "zod";
import { type MockLlm, startMockLlm } from "../../testing/mock-llm";
import {
  createOpenAiCompatibleProvider,
  type LlmAnswer,
  type LlmCompletionRequest,
  LlmError,
  type LlmFetch,
  type LlmProvider,
} from "../provider";

/** The model name a case configures; nothing here reaches a real endpoint. */
const MODEL = "lectern-test-model";

/** The key a case configures. It is a test's own value and appears in one header assertion. */
const API_KEY = "lectern-test-key";

/** An address the injected transports never use, so nothing here can reach a socket it did not open. */
const UNUSED_BASE_URL = "http://127.0.0.1:1";

/** The system prompt every case sends, and the segment the user message carries. */
const SYSTEM = "You are a reader's assistant.";
const SEGMENT = "Alpha beta gamma delta epsilon zeta eta theta.";

/** The request a case starts from: F§9's four fields, asking for JSON. */
const MAP_REQUEST: LlmCompletionRequest = { system: SYSTEM, user: SEGMENT, json: true, maxTokens: 256 };

/** F§9's request body, as a case reads it back out of the mock's own record of the call. */
const SentRequestSchema = z.object({
  model: z.string(),
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
  max_tokens: z.number(),
  temperature: z.number(),
});

type SentRequest = z.infer<typeof SentRequestSchema>;

/** The keys F§9's body always carries, before the one only a JSON answer asks for. */
const BODY_KEYS = ["max_tokens", "messages", "model", "temperature"];
const JSON_BODY_KEYS = [...BODY_KEYS, "response_format"].sort();

/** Run `body` against a freshly started mock, and stop the mock however the case ends. */
async function withMock(body: (mock: MockLlm) => Promise<void>): Promise<void> {
  const mock = await startMockLlm();
  try {
    await body(mock);
  } finally {
    await mock.close();
  }
}

/** A provider pointed at a mock, which is what every case that needs an answer builds. */
function providerFor(mock: MockLlm, apiKey?: string): LlmProvider {
  return createOpenAiCompatibleProvider({ baseUrl: mock.baseUrl, model: MODEL, ...(apiKey === undefined ? {} : { apiKey }) });
}

/** What a completion refused with, or a failure when it answered at all. */
async function refusalOf(provider: LlmProvider, request: LlmCompletionRequest = MAP_REQUEST): Promise<LlmError> {
  const refusal = await provider.complete(request).then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(refusal).toBeInstanceOf(LlmError);
  if (!(refusal instanceof LlmError)) throw new Error("expected the provider to refuse");
  return refusal;
}

/** One recorded call's body, read through the schema above so a case names what it asserts. */
function sentBody(mock: MockLlm, index = 0): SentRequest {
  const body: unknown = mock.requests[index]?.body;
  const parsed = SentRequestSchema.safeParse(body);
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error(`call ${index} carried no readable request: ${parsed.error.message}`);
  return parsed.data;
}

/** A recorded call's body as it arrived, so a case can assert which keys it held. */
function bodyKeys(mock: MockLlm, index = 0): string[] {
  const body: unknown = mock.requests[index]?.body;
  return typeof body === "object" && body !== null ? Object.keys(body).sort() : [];
}

test("the request carries F§9's fields and nothing else, and the first choice's content is what comes back", async () => {
  await withMock(async (mock) => {
    const answer = await providerFor(mock).complete(MAP_REQUEST);

    expect(mock.requests).toHaveLength(1);
    const call = mock.requests[0];
    expect(call?.method).toBe("POST");
    expect(call?.path).toBe("/chat/completions");
    expect(call?.headers["content-type"]).toBe("application/json");

    const sent = sentBody(mock);
    expect(sent.model).toBe(MODEL);
    expect(sent.max_tokens).toBe(256);
    expect(sent.temperature).toBe(0.2);
    expect(sent.messages).toEqual([
      { role: "system", content: SYSTEM },
      { role: "user", content: SEGMENT },
    ]);
    expect(bodyKeys(mock)).toEqual(JSON_BODY_KEYS);

    const notes = JSON.parse(answer) as { notes: string[] };
    expect(notes.notes).toHaveLength(3);
    expect(notes.notes[0]).toContain("Alpha");
  });
});

test("response_format travels only when a JSON answer was asked for", async () => {
  await withMock(async (mock) => {
    const provider = providerFor(mock);
    await provider.complete({ ...MAP_REQUEST, json: true });
    await provider.complete({ ...MAP_REQUEST, json: false });

    const asked = mock.requests[0]?.body as Record<string, unknown>;
    const plain = mock.requests[1]?.body as Record<string, unknown>;
    expect(asked.response_format).toEqual({ type: "json_object" });
    expect("response_format" in plain).toBe(false);
    expect(bodyKeys(mock, 0)).toEqual(JSON_BODY_KEYS);
    expect(bodyKeys(mock, 1)).toEqual(BODY_KEYS);
  });
});

test("the authorization header travels only when a key is configured", async () => {
  await withMock(async (mock) => {
    await providerFor(mock).complete(MAP_REQUEST);
    await providerFor(mock, API_KEY).complete(MAP_REQUEST);

    expect(mock.requests).toHaveLength(2);
    expect(mock.requests[0]?.headers.authorization).toBeUndefined();
    expect(mock.requests[1]?.headers.authorization).toBe(`Bearer ${API_KEY}`);
  });
});

test("a map prompt answers three notes built from the segment's first words", async () => {
  await withMock(async (mock) => {
    const notes = JSON.parse(await providerFor(mock).complete(MAP_REQUEST)) as { notes: string[] };
    expect(notes.notes).toEqual([
      "Note 1 about Alpha beta gamma delta epsilon zeta.",
      "Note 2 about Alpha beta gamma delta epsilon zeta.",
      "Note 3 about Alpha beta gamma delta epsilon zeta.",
    ]);
  });
});

test("a reduce prompt answers a result that is valid for the mode it asked about", async () => {
  await withMock(async (mock) => {
    const provider = providerFor(mock);
    const modes: SummaryMode[] = ["brief", "detailed"];
    for (const mode of modes) {
      expect(SummaryModeSchema.safeParse(mode).success).toBe(true);
      const user = `The map notes are Alpha beta gamma delta. Write the summary and its key takeaways. Mode: ${mode}.`;
      const result = JSON.parse(await provider.complete({ ...MAP_REQUEST, user })) as {
        summary: string;
        keyTakeaways: string[];
      };
      const limits = SUMMARY_LIMITS[mode];
      expect(result.keyTakeaways.length).toBeGreaterThanOrEqual(limits.minTakeaways);
      expect(result.keyTakeaways.length).toBeLessThanOrEqual(limits.maxTakeaways);
      expect(result.summary.length).toBeGreaterThan(0);
      expect(result.summary.length).toBeLessThanOrEqual(limits.summaryChars);
    }
    expect(mock.requests).toHaveLength(modes.length);
  });
});

test("FORCE_INVALID answers text that is not JSON, and FORCE_INVALID_ONCE only the first time", async () => {
  await withMock(async (mock) => {
    const provider = providerFor(mock);

    const invalid = await provider.complete({ ...MAP_REQUEST, user: `${SEGMENT} FORCE_INVALID` });
    expect(() => JSON.parse(invalid) as unknown).toThrow();

    const once = { ...MAP_REQUEST, user: `${SEGMENT} FORCE_INVALID_ONCE` };
    const first = await provider.complete(once);
    expect(() => JSON.parse(first) as unknown).toThrow();
    const afterwards = JSON.parse(await provider.complete(once)) as { notes: string[] };
    expect(afterwards.notes).toHaveLength(3);
  });
});

test("an HTTP 500 is LLM_UNAVAILABLE, and the request it refused is still recorded", async () => {
  await withMock(async (mock) => {
    const refusal = await refusalOf(providerFor(mock), { ...MAP_REQUEST, user: `${SEGMENT} FORCE_ERROR` });
    expect(refusal.code).toBe("LLM_UNAVAILABLE");
    expect(refusal.message).toContain("HTTP 500");
    expect(mock.requests).toHaveLength(1);
  });
});

test("a transport that never settles is LLM_UNAVAILABLE at the deadline", async () => {
  const never: LlmFetch = () => new Promise<LlmAnswer>(() => undefined);
  const provider = createOpenAiCompatibleProvider({ baseUrl: UNUSED_BASE_URL, model: MODEL, fetch: never, timeoutMs: 20 });
  const refusal = await refusalOf(provider);
  expect(refusal.code).toBe("LLM_UNAVAILABLE");
  expect(refusal.message).toContain("did not answer within 20 ms");
});

test("a refused connection, and an answer carrying no choices, are both LLM_UNAVAILABLE", async () => {
  const refusing: LlmFetch = () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:1"));
  const choiceLess: LlmFetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ choices: [] }) });

  const broken = await refusalOf(createOpenAiCompatibleProvider({ baseUrl: UNUSED_BASE_URL, model: MODEL, fetch: refusing }));
  expect(broken.code).toBe("LLM_UNAVAILABLE");
  expect(broken.message).toContain("ECONNREFUSED");

  const empty = await refusalOf(createOpenAiCompatibleProvider({ baseUrl: UNUSED_BASE_URL, model: MODEL, fetch: choiceLess }));
  expect(empty.code).toBe("LLM_UNAVAILABLE");
  expect(empty.message).toContain("no completion choices");
});
