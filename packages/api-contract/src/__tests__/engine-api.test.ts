/**
 * U-018's contract (F§7.2): the phase-1 route schemas, each pinned from both sides — one body the shape
 * accepts, and two it refuses — plus the rules the contract states in words: `synthSpeed` defaults to 1, the
 * voice list is a bare array, and a parse body carries exactly one of `url` or `text`.
 *
 * Two of the values are other units' published goldens, quoted verbatim (F§6's chunk id for
 * `['mock','mock-a','1.00','Hello, world.']` and F§5.6(a)'s timings for `Hello,` `world.` at 1000 ms), so a
 * schema that accepts a shape the rest of Lectern cannot produce fails here rather than in the hub.
 */

import type { DocumentModel } from "@lectern/core";
import { expect, test } from "vitest";
import {
  ErrorBodySchema,
  ErrorCodeSchema,
  FILENAME_HEADER,
  HealthResponseSchema,
  ParseJsonRequestSchema,
  ParseResponseSchema,
  TtsRequestSchema,
  TtsResponseSchema,
  VoicesResponseSchema,
} from "../index";

/** A minimal but complete F§5.1 document: one paragraph, one sentence, two words. */
const DOCUMENT: DocumentModel = {
  schemaVersion: 1,
  tokenizerVersion: 1,
  docId: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
  title: "Probe article",
  lang: "en",
  source: { kind: "html", mime: "text/html" },
  blocks: [
    {
      index: 0,
      kind: "paragraph",
      skip: false,
      text: "Hello, world.",
      sentences: [
        {
          index: 0,
          blockIndex: 0,
          charStart: 0,
          charEnd: 13,
          text: "Hello, world.",
          words: [
            { index: 0, charStart: 0, charEnd: 6, text: "Hello," },
            { index: 1, charStart: 7, charEnd: 13, text: "world." },
          ],
        },
      ],
    },
  ],
  sentenceCount: 1,
  wordCount: 2,
};

/** F§6's golden chunk id, and the body `POST /v1/tts` answers with for the text it names. */
const CHUNK_ID = "3bfbfd2ad841c9c08af4bcc1c7ccb8560d318c76";
const TTS_RESPONSE = {
  chunkId: CHUNK_ID,
  mime: "audio/wav",
  durationMs: 800,
  timings: [
    { i: 0, s: 0, e: 333 },
    { i: 1, s: 467, e: 800 },
  ],
  timingSource: "estimated",
  audioPath: `/v1/tts/audio/${CHUNK_ID}`,
};

test("FILENAME_HEADER names the header that carries a file's own name beside the raw bytes", () => {
  expect(FILENAME_HEADER).toBe("x-lectern-filename");
});

test("ErrorCodeSchema carries exactly the thirteen codes F§7.2 lists", () => {
  expect(ErrorCodeSchema.options).toEqual([
    "UNAUTHORIZED",
    "BAD_REQUEST",
    "NOT_FOUND",
    "PAYLOAD_TOO_LARGE",
    "UNSUPPORTED_FORMAT",
    "INVALID_EPUB",
    "DRM_PROTECTED",
    "PARSE_FAILED",
    "EMPTY_DOCUMENT",
    "FETCH_REFUSED",
    "ENGINE_UNAVAILABLE",
    "UNKNOWN_VOICE",
    "INTERNAL",
  ]);
});

test("ErrorBodySchema accepts an error with a code from the set and a message", () => {
  const body = { error: { code: "NOT_FOUND", message: "No document with that id." } };
  const result = ErrorBodySchema.safeParse(body);
  expect(result.success).toBe(true);
  expect(result.data).toEqual(body);
});

test("ErrorBodySchema refuses a code outside F§7.2's set", () => {
  const result = ErrorBodySchema.safeParse({ error: { code: "TEAPOT", message: "No." } });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["error", "code"]);
});

test("ErrorBodySchema refuses an error with no message", () => {
  const result = ErrorBodySchema.safeParse({ error: { code: "INTERNAL" } });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["error", "message"]);
});

test("HealthResponseSchema accepts the three fields the health probe answers with", () => {
  const body = { ok: true, version: "0.0.0", engines: ["kokoro", "piper", "mock"] };
  const result = HealthResponseSchema.safeParse(body);
  expect(result.success).toBe(true);
  expect(result.data).toEqual(body);
});

test("HealthResponseSchema refuses a status that is not a boolean", () => {
  const result = HealthResponseSchema.safeParse({ ok: "true", version: "0.0.0", engines: [] });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["ok"]);
});

test("HealthResponseSchema refuses an answer with no engine list", () => {
  const result = HealthResponseSchema.safeParse({ ok: true, version: "0.0.0" });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["engines"]);
});

test("VoicesResponseSchema accepts the voices of several engines as one array", () => {
  const voices = [
    { id: "kokoro:af_heart", engine: "kokoro", engineVoiceId: "af_heart", name: "Heart", lang: "en-us" },
    { id: "mock:mock-a", engine: "mock", engineVoiceId: "mock-a", name: "Mock A", lang: "en" },
  ];
  const result = VoicesResponseSchema.safeParse(voices);
  expect(result.success).toBe(true);
  expect(result.data).toEqual(voices);
});

test("VoicesResponseSchema refuses a voice list wrapped in an envelope", () => {
  const result = VoicesResponseSchema.safeParse({ voices: [] });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual([]);
});

test("VoicesResponseSchema refuses a voice with no language tag", () => {
  const result = VoicesResponseSchema.safeParse([{ id: "mock:mock-a", engine: "mock", engineVoiceId: "mock-a", name: "Mock A" }]);
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual([0, "lang"]);
});

test("TtsRequestSchema accepts text and a voice, and defaults the engine speed to 1", () => {
  const result = TtsRequestSchema.safeParse({ text: "Hello, world.", voiceId: "mock:mock-a" });
  expect(result.success).toBe(true);
  expect(result.data).toEqual({ text: "Hello, world.", voiceId: "mock:mock-a", synthSpeed: 1 });
});

test("TtsRequestSchema accepts both ends of the engine speed range F§5.6(e) clamps to", () => {
  for (const synthSpeed of [1, 4]) {
    const result = TtsRequestSchema.safeParse({ text: "Hello.", voiceId: "mock:mock-a", synthSpeed });
    expect(result.success).toBe(true);
    expect(result.data?.synthSpeed).toBe(synthSpeed);
  }
});

test("TtsRequestSchema accepts a thousand characters and refuses a thousand and one", () => {
  const atLimit = TtsRequestSchema.safeParse({ text: "a".repeat(1000), voiceId: "mock:mock-a" });
  expect(atLimit.success).toBe(true);
  const overLimit = TtsRequestSchema.safeParse({ text: "a".repeat(1001), voiceId: "mock:mock-a" });
  expect(overLimit.success).toBe(false);
  expect(overLimit.error?.issues[0]?.path).toEqual(["text"]);
});

test("TtsRequestSchema refuses an engine speed above the range", () => {
  const result = TtsRequestSchema.safeParse({ text: "Hello.", voiceId: "mock:mock-a", synthSpeed: 4.5 });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["synthSpeed"]);
});

test("TtsRequestSchema refuses an empty voice identifier", () => {
  const result = TtsRequestSchema.safeParse({ text: "Hello.", voiceId: "" });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["voiceId"]);
});

test("TtsResponseSchema accepts a chunk carrying the golden id and the golden timings", () => {
  const result = TtsResponseSchema.safeParse(TTS_RESPONSE);
  expect(result.success).toBe(true);
  expect(result.data).toEqual(TTS_RESPONSE);
});

test("TtsResponseSchema refuses a timing source that is neither the engine's nor the estimate's", () => {
  const result = TtsResponseSchema.safeParse({ ...TTS_RESPONSE, timingSource: "machine" });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["timingSource"]);
});

test("TtsResponseSchema refuses an audio container F§6 does not define", () => {
  const result = TtsResponseSchema.safeParse({ ...TTS_RESPONSE, mime: "audio/ogg" });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["mime"]);
});

test("TtsResponseSchema refuses a timing that is not a whole millisecond", () => {
  const result = TtsResponseSchema.safeParse({ ...TTS_RESPONSE, timings: [{ i: 0, s: 0, e: 333.5 }] });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["timings", 0, "e"]);
});

test("ParseJsonRequestSchema accepts a URL to fetch, with the text form absent", () => {
  const result = ParseJsonRequestSchema.safeParse({ url: "https://example.com/article" });
  expect(result.success).toBe(true);
  expect(result.data).toEqual({ url: "https://example.com/article" });
});

test("ParseJsonRequestSchema accepts text with a display title", () => {
  const body = { text: "Hello, world.", title: "Hello" };
  const result = ParseJsonRequestSchema.safeParse(body);
  expect(result.success).toBe(true);
  expect(result.data).toEqual(body);
});

test("ParseJsonRequestSchema refuses a body that names neither a URL nor text", () => {
  const result = ParseJsonRequestSchema.safeParse({});
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["url"]);
});

test("ParseJsonRequestSchema rejects a body carrying both url and text", () => {
  const result = ParseJsonRequestSchema.safeParse({ url: "https://example.com/article", text: "Hello, world." });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.message).toContain("exactly one of `url` or `text`");
  expect(result.error?.issues[0]?.path).toEqual(["url"]);
});

test("ParseResponseSchema accepts a document with no anchors, as every pageless source is", () => {
  const result = ParseResponseSchema.safeParse({ document: DOCUMENT });
  expect(result.success).toBe(true);
  expect(result.data?.document.docId).toBe(DOCUMENT.docId);
  expect(result.data?.anchors).toBeUndefined();
});

test("ParseResponseSchema accepts F§5.1's anchors beside the document", () => {
  const anchors = [{ sentenceIndex: 0, wordIndex: 0, page: 1, itemIndex: 3, charStart: 0, charEnd: 6 }];
  const result = ParseResponseSchema.safeParse({ document: DOCUMENT, anchors });
  expect(result.success).toBe(true);
  expect(result.data).toEqual({ document: DOCUMENT, anchors });
});

test("ParseResponseSchema refuses a document with no word count", () => {
  const truncated: Partial<DocumentModel> = { ...DOCUMENT };
  delete truncated.wordCount;
  const result = ParseResponseSchema.safeParse({ document: truncated });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["document", "wordCount"]);
});

test("ParseResponseSchema refuses an anchor with no end offset", () => {
  const result = ParseResponseSchema.safeParse({
    document: DOCUMENT,
    anchors: [{ sentenceIndex: 0, wordIndex: 0, page: 1, itemIndex: 3, charStart: 0 }],
  });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["anchors", 0, "charEnd"]);
});
