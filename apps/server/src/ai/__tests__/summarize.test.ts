/**
 * U-063's contract (F§9): the map-reduce itself, against the mock endpoint this package ships under
 * `@lectern/server/testing`, so no case here needs a model, a GPU or a network.
 *
 * The provider is U-062's real adapter pointed at the mock, so what a case measures is the whole path a
 * production call takes — the request F§9 describes, the envelope the endpoint answers with, and the text the
 * pipeline reads out of it. The mock's own reply rules are steered by the prompt, which is why the markers live
 * inside the *documents* below: a document's text is what the map and reduce prompts carry, so a marker in the
 * text is a marker in the prompt.
 */

import { SUMMARY_LIMITS, type SummaryMode, SummaryResultSchema } from "@lectern/api-contract";
import { buildDocument, type DocumentModel } from "@lectern/core";
import { expect, test } from "vitest";
import { z } from "zod";
import { type MockLlm, type MockLlmCall, startMockLlm } from "../../testing/mock-llm";
import { PROMPT_VERSION } from "../prompts";
import { createOpenAiCompatibleProvider, type LlmProvider } from "../provider";
import { LlmInvalidOutputError, summarize } from "../summarize";

/** The model name the provider is configured with; nothing here reaches a real endpoint. */
const MODEL = "lectern-summary-test-model";

/** The clock every case injects, so a result's `createdAt` is arithmetic rather than the wall clock. */
const NOW = 1_700_000_000_000;

/** What a caller supplies beside the provider, the document and the mode. */
const OPTIONS = { model: MODEL, now: () => NOW };

/** One short document: three sentences, so it fits in a single segment and the map step is skipped. */
const SHORT_TEXT = "Alpha beta gamma. Delta epsilon zeta. Eta theta iota.";

/** What marks a map prompt's JSON shape, and what marks the reduce prompt's. */
const MAP_SHAPE = '"notes"';
const REDUCE_SHAPE = "keyTakeaways";

/** F§9's map step's own ceiling, so a case can prove the prompt states it. */
const NOTES_CEILING = '"notes" array holds at most 8';

/** F§9's prompt requests, per mode, as the reduce prompt words them. */
const PROMPT_TAKEAWAYS: Record<SummaryMode, string> = {
  brief: "exactly 5 key takeaways",
  detailed: "between 8 and 10 key takeaways",
};

/** Run `body` against a freshly started mock, and stop the mock however the case ends. */
async function withMock(body: (mock: MockLlm) => Promise<void>): Promise<void> {
  const mock = await startMockLlm();
  try {
    await body(mock);
  } finally {
    await mock.close();
  }
}

/** U-062's adapter over the mock: the provider every case summarizes with. */
function providerFor(mock: MockLlm): LlmProvider {
  return createOpenAiCompatibleProvider({ baseUrl: mock.baseUrl, model: MODEL });
}

/** A document of one paragraph. */
function documentOf(text: string): DocumentModel {
  return buildDocument([{ kind: "paragraph", text }], { source: { kind: "txt" } });
}

/** A paragraph of exactly `chars` characters: whole words separated by single spaces, ending in a full stop. */
function paragraphOf(chars: number): string {
  const unit = "alpha ";
  const body = unit.repeat(Math.floor((chars - 1) / unit.length));
  const tail = "b".repeat(chars - 1 - body.length);
  return `${body}${tail}.`;
}

/** The request body the mock recorded, as far as a case reads it. */
const SentRequestSchema = z.object({ messages: z.array(z.object({ role: z.string(), content: z.string() })) });

/** The user message one recorded call carried, which is the text every reply rule is steered by. */
function userMessage(call: MockLlmCall | undefined): string {
  const parsed = SentRequestSchema.safeParse(call?.body);
  if (!parsed.success) return "";
  return parsed.data.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
}

/** Every prompt the mock was asked, in the order they arrived. */
function prompts(mock: MockLlm): string[] {
  return mock.requests.map((call) => userMessage(call));
}

test("a one-segment document skips the map step and makes exactly one call", async () => {
  await withMock(async (mock) => {
    const result = await summarize(providerFor(mock), documentOf(SHORT_TEXT), "brief", OPTIONS);

    expect(mock.requests).toHaveLength(1);
    const prompt = prompts(mock)[0] ?? "";
    expect(prompt).toContain(REDUCE_SHAPE);
    expect(prompt).not.toContain(MAP_SHAPE);
    expect(prompt).toContain(SHORT_TEXT);
    expect(SummaryResultSchema("brief").safeParse(result).success).toBe(true);
  });
});

test("a 40 000-character document is four segments: four map calls and one reduce call", async () => {
  await withMock(async (mock) => {
    const document = documentOf(paragraphOf(40000));
    const result = await summarize(providerFor(mock), document, "brief", OPTIONS);

    expect(mock.requests).toHaveLength(5);
    const sent = prompts(mock);
    for (const prompt of sent.slice(0, 4)) {
      expect(prompt).toContain(MAP_SHAPE);
      expect(prompt).not.toContain(REDUCE_SHAPE);
      expect(prompt).toContain(NOTES_CEILING);
    }
    expect(sent[4]).toContain(REDUCE_SHAPE);
    expect(sent[4]).toContain(PROMPT_TAKEAWAYS.brief);
    expect(SummaryResultSchema("brief").safeParse(result).success).toBe(true);
  });
});

test("FORCE_INVALID_ONCE succeeds on the retry, with the validation error appended to the prompt", async () => {
  await withMock(async (mock) => {
    const result = await summarize(providerFor(mock), documentOf(`${SHORT_TEXT} FORCE_INVALID_ONCE`), "brief", OPTIONS);

    expect(mock.requests).toHaveLength(2);
    const sent = prompts(mock);
    expect(sent[1]).toContain("Your previous reply was rejected:");
    expect(sent[1]).toContain(SHORT_TEXT);
    expect(SummaryResultSchema("brief").safeParse(result).success).toBe(true);
  });
});

test("FORCE_INVALID fails with LLM_INVALID_OUTPUT after three attempts", async () => {
  await withMock(async (mock) => {
    const refusal = await summarize(providerFor(mock), documentOf(`${SHORT_TEXT} FORCE_INVALID`), "brief", OPTIONS).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(refusal).toBeInstanceOf(LlmInvalidOutputError);
    if (!(refusal instanceof LlmInvalidOutputError)) throw new Error("expected the pipeline to refuse");
    expect(refusal.code).toBe("LLM_INVALID_OUTPUT");
    expect(mock.requests).toHaveLength(3);
    expect(prompts(mock)[2]).toContain("Your previous reply was rejected:");
  });
});

test("brief and detailed results satisfy their own mode's schema limits", async () => {
  await withMock(async (mock) => {
    const provider = providerFor(mock);
    const modes: SummaryMode[] = ["brief", "detailed"];
    const results = new Map<SummaryMode, unknown>();

    for (const mode of modes) {
      const result = await summarize(provider, documentOf(SHORT_TEXT), mode, OPTIONS);
      results.set(mode, result);

      const parsed = SummaryResultSchema(mode).safeParse(result);
      expect(parsed.success).toBe(true);
      const limits = SUMMARY_LIMITS[mode];
      expect(result.keyTakeaways.length).toBeGreaterThanOrEqual(limits.minTakeaways);
      expect(result.keyTakeaways.length).toBeLessThanOrEqual(limits.maxTakeaways);
      expect(result.summary.length).toBeGreaterThan(0);
      expect(result.summary.length).toBeLessThanOrEqual(limits.summaryChars);
      expect(result.model).toBe(MODEL);
      expect(result.promptVersion).toBe(PROMPT_VERSION);
      expect(result.createdAt).toBe(NOW);
    }

    expect(mock.requests).toHaveLength(2);
    expect(prompts(mock)[0]).toContain(PROMPT_TAKEAWAYS.brief);
    expect(prompts(mock)[1]).toContain(PROMPT_TAKEAWAYS.detailed);

    // The two modes are not interchangeable: each result is refused by the other mode's schema.
    for (const mode of modes) {
      const other: SummaryMode = mode === "brief" ? "detailed" : "brief";
      expect(SummaryResultSchema(other).safeParse(results.get(mode)).success).toBe(false);
    }
  });
});
