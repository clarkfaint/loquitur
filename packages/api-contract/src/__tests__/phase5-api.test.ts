/**
 * U-054's contract (F§7.2, F§8, F§9): the phase-5 route schemas, each pinned from both sides — one body the
 * shape accepts and two it refuses — plus the rules the contract states in words: a push carries at most 200
 * ops, a brief result carries at most six takeaways, and a `docId` is 32 lower-case hexadecimal characters.
 *
 * The op the sync shapes carry is `@lectern/core`'s own `OpSchema` (F§5.9), exercised with a real outbox
 * entry rather than a re-spelled shape, so a schema that accepted something the store cannot produce would
 * fail here instead of in the hub. The document id and the document are F§5.2's own golden pair.
 */

import type { DocumentModel, Op } from "@lectern/core";
import { expect, test } from "vitest";
import {
  AiErrorCodeSchema,
  AnySummaryResultSchema,
  DocIdParamSchema,
  MAX_MODEL_UPLOAD_BYTES,
  MAX_ORIGINAL_UPLOAD_BYTES,
  MAX_PULL_LIMIT,
  MAX_PUSH_OPS,
  PullQuerySchema,
  PullResponseSchema,
  PushRequestSchema,
  PushResponseSchema,
  SummaryErrorSchema,
  SummaryModeSchema,
  SummaryRequestSchema,
  SummaryResultSchema,
  SummaryStatusSchema,
  SyncErrorCodeSchema,
  SyncErrorSchema,
  WsClientMessageSchema,
  WsServerMessageSchema,
} from "../index";

/** F§5.2's golden identifier for one block reading `Hello, world.` */
const DOC_ID = "f8c3bf62a9aa3e6fc1619c250e48abe7";

/** A minimal but complete F§5.1 document: one paragraph, one sentence, two words. */
const DOCUMENT: DocumentModel = {
  schemaVersion: 1,
  tokenizerVersion: 1,
  docId: DOC_ID,
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

/** One outbox entry (F§5.9), as a device hands it to `POST /v1/sync/push`. */
const OP: Op = {
  opId: "op-1",
  deviceId: "device-a",
  entity: "progress",
  entityId: DOC_ID,
  kind: "put",
  ts: 1_700_000_000_000,
  record: { docId: DOC_ID, sentenceIndex: 0, wordIndex: 0, updatedAt: 1_700_000_000_000 },
};

/** A brief result inside F§9's ceilings: three takeaways, a short summary. */
const BRIEF_RESULT = {
  summary: "The probe document greets the world and stops.",
  keyTakeaways: ["It is one sentence long.", "It is a probe.", "It greets the world."],
  model: "a-local-model",
  promptVersion: "1",
  createdAt: 1_700_000_000_000,
};

/** `n` distinct takeaways, for pinning a mode's count ceiling. */
function takeaways(n: number): string[] {
  return Array.from({ length: n }, (_, index) => `Takeaway ${index + 1}.`);
}

test("SyncErrorCodeSchema carries exactly the two codes F§8.2 names", () => {
  expect(SyncErrorCodeSchema.options).toEqual(["MODEL_MISSING", "TOO_MANY_OPS"]);
});

test("AiErrorCodeSchema carries exactly the five codes F§9 names", () => {
  expect(AiErrorCodeSchema.options).toEqual(["AI_DISABLED", "LLM_UNAVAILABLE", "LLM_INVALID_OUTPUT", "INTERRUPTED", "MODEL_MISSING"]);
});

test("PushRequestSchema accepts a device's pending ops", () => {
  const body = { deviceId: "device-a", ops: [OP] };
  const result = PushRequestSchema.safeParse(body);
  expect(result.success).toBe(true);
  expect(result.data).toEqual(body);
});

test("PushRequestSchema rejects 201 ops, one past the ceiling F§8.2 sets", () => {
  expect(MAX_PUSH_OPS).toBe(200);
  const result = PushRequestSchema.safeParse({ deviceId: "device-a", ops: takeaways(MAX_PUSH_OPS + 1).map(() => OP) });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["ops"]);
});

test("PushRequestSchema refuses a push carrying no ops at all", () => {
  const result = PushRequestSchema.safeParse({ deviceId: "device-a", ops: [] });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["ops"]);
});

test("PushRequestSchema refuses a device id that is not a string", () => {
  const result = PushRequestSchema.safeParse({ deviceId: 7, ops: [OP] });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["deviceId"]);
});

test("PushResponseSchema accepts the accepted ids and the rev the batch left", () => {
  const body = { accepted: ["op-1", "op-2"], rev: 12 };
  const result = PushResponseSchema.safeParse(body);
  expect(result.success).toBe(true);
  expect(result.data).toEqual(body);
});

test("PushResponseSchema refuses a negative rev", () => {
  const result = PushResponseSchema.safeParse({ accepted: [], rev: -1 });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["rev"]);
});

test("PushResponseSchema refuses an accepted list that is not made of ids", () => {
  const result = PushResponseSchema.safeParse({ accepted: [1], rev: 1 });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["accepted", 0]);
});

test("PullQuerySchema accepts a cursor and defaults the page to 500", () => {
  expect(MAX_PULL_LIMIT).toBe(500);
  const result = PullQuerySchema.safeParse({ since: 0 });
  expect(result.success).toBe(true);
  expect(result.data).toEqual({ since: 0, limit: MAX_PULL_LIMIT });
});

test("PullQuerySchema accepts both ends of the page range", () => {
  for (const limit of [1, MAX_PULL_LIMIT]) {
    const result = PullQuerySchema.safeParse({ since: 3, limit });
    expect(result.success).toBe(true);
    expect(result.data?.limit).toBe(limit);
  }
});

test("PullQuerySchema refuses a negative cursor", () => {
  const result = PullQuerySchema.safeParse({ since: -1 });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["since"]);
});

test("PullQuerySchema refuses a page larger than the 500 F§8.2 allows", () => {
  const result = PullQuerySchema.safeParse({ since: 0, limit: MAX_PULL_LIMIT + 1 });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["limit"]);
});

test("PullResponseSchema accepts changes, the next cursor and the more flag", () => {
  const body = { changes: [OP], nextRev: 9, more: false };
  const result = PullResponseSchema.safeParse(body);
  expect(result.success).toBe(true);
  expect(result.data).toEqual(body);
});

test("PullResponseSchema refuses a flag that is not a boolean", () => {
  const result = PullResponseSchema.safeParse({ changes: [], nextRev: 0, more: "no" });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["more"]);
});

test("PullResponseSchema refuses a change that is not an op", () => {
  const result = PullResponseSchema.safeParse({ changes: [{ ...OP, kind: "merge" }], nextRev: 1, more: false });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["changes", 0, "kind"]);
});

test("WsClientMessageSchema accepts the two messages a client sends", () => {
  for (const message of [{ type: "auth" }, { type: "pong" }]) {
    const result = WsClientMessageSchema.safeParse(message);
    expect(result.success).toBe(true);
    expect(result.data?.type).toBe(message.type);
  }
});

test("WsClientMessageSchema accepts an auth envelope carrying the credential beside it", () => {
  const result = WsClientMessageSchema.safeParse({ type: "auth", token: "an opaque credential" });
  expect(result.success).toBe(true);
  expect(result.data?.type).toBe("auth");
});

test("WsClientMessageSchema refuses a message only the hub sends", () => {
  const result = WsClientMessageSchema.safeParse({ type: "ready", rev: 1 });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["type"]);
});

test("WsClientMessageSchema refuses a pong that carries a rev", () => {
  const result = WsClientMessageSchema.safeParse({ type: "pong", rev: 1 });
  expect(result.success).toBe(false);
});

test("WsServerMessageSchema accepts the three messages the hub sends", () => {
  for (const message of [{ type: "ready", rev: 0 }, { type: "changed", rev: 7 }, { type: "ping" }]) {
    const result = WsServerMessageSchema.safeParse(message);
    expect(result.success).toBe(true);
  }
});

test("WsServerMessageSchema refuses a changed message with no rev", () => {
  const result = WsServerMessageSchema.safeParse({ type: "changed" });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["rev"]);
});

test("WsServerMessageSchema refuses a message only a client sends", () => {
  const result = WsServerMessageSchema.safeParse({ type: "pong" });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["type"]);
});

test("SyncErrorSchema accepts F§8.2's codes with a message", () => {
  const result = SyncErrorSchema.safeParse({ code: "TOO_MANY_OPS", message: "A push carries at most 200 ops." });
  expect(result.success).toBe(true);
});

test("SyncErrorSchema refuses a code outside F§8.2's set", () => {
  const result = SyncErrorSchema.safeParse({ code: "TEAPOT", message: "No." });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["code"]);
});

test("SyncErrorSchema refuses an error with no message", () => {
  const result = SyncErrorSchema.safeParse({ code: "MODEL_MISSING" });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["message"]);
});

test("DocIdParamSchema accepts F§5.2's own golden identifier", () => {
  const result = DocIdParamSchema.safeParse(DOC_ID);
  expect(result.success).toBe(true);
});

test("DocIdParamSchema refuses an identifier that is not 32 characters", () => {
  const result = DocIdParamSchema.safeParse(DOC_ID.slice(0, 31));
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual([]);
});

test("DocIdParamSchema refuses an upper-case identifier a file system could fold onto another", () => {
  const result = DocIdParamSchema.safeParse(DOC_ID.toUpperCase());
  expect(result.success).toBe(false);
});

test("DocIdParamSchema refuses a path that would climb out of the document's directory", () => {
  const result = DocIdParamSchema.safeParse("../../etc/passwd");
  expect(result.success).toBe(false);
});

test("the two upload ceilings are F§7.1's own 100 MiB default", () => {
  expect(MAX_MODEL_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
  expect(MAX_ORIGINAL_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
});

test("SummaryModeSchema accepts F§9's two modes", () => {
  expect(SummaryModeSchema.options).toEqual(["brief", "detailed"]);
  for (const mode of ["brief", "detailed"]) {
    expect(SummaryModeSchema.safeParse(mode).success).toBe(true);
  }
});

test("SummaryModeSchema refuses a mode F§9 does not define", () => {
  const result = SummaryModeSchema.safeParse("verbose");
  expect(result.success).toBe(false);
});

test("SummaryRequestSchema accepts a document id, a mode and an inline model", () => {
  const body = { docId: DOC_ID, mode: "brief", document: DOCUMENT };
  const result = SummaryRequestSchema.safeParse(body);
  expect(result.success).toBe(true);
  expect(result.data).toEqual(body);
});

test("SummaryRequestSchema accepts a request that leaves the model to the hub", () => {
  const result = SummaryRequestSchema.safeParse({ docId: DOC_ID, mode: "detailed" });
  expect(result.success).toBe(true);
  expect(result.data?.document).toBeUndefined();
});

test("SummaryRequestSchema refuses a document id that is not 32 hex characters", () => {
  const result = SummaryRequestSchema.safeParse({ docId: "not-an-id", mode: "brief" });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["docId"]);
});

test("SummaryRequestSchema refuses a mode F§9 does not define", () => {
  const result = SummaryRequestSchema.safeParse({ docId: DOC_ID, mode: "verbose" });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["mode"]);
});

test("SummaryResultSchema('brief') accepts a brief result inside F§9's ceilings", () => {
  const result = SummaryResultSchema("brief").safeParse(BRIEF_RESULT);
  expect(result.success).toBe(true);
  expect(result.data).toEqual(BRIEF_RESULT);
});

test("SummaryResultSchema('brief') rejects a brief result with seven takeaways", () => {
  const result = SummaryResultSchema("brief").safeParse({ ...BRIEF_RESULT, keyTakeaways: takeaways(7) });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["keyTakeaways"]);
});

test("SummaryResultSchema('brief') rejects a brief result with two takeaways", () => {
  const result = SummaryResultSchema("brief").safeParse({ ...BRIEF_RESULT, keyTakeaways: takeaways(2) });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["keyTakeaways"]);
});

test("SummaryResultSchema('brief') rejects a summary past 1 200 characters", () => {
  const result = SummaryResultSchema("brief").safeParse({ ...BRIEF_RESULT, summary: "a".repeat(1201) });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["summary"]);
});

test("SummaryResultSchema('detailed') accepts a result at F§9's own ceilings", () => {
  const result = SummaryResultSchema("detailed").safeParse({
    ...BRIEF_RESULT,
    summary: "a".repeat(4000),
    keyTakeaways: takeaways(12),
  });
  expect(result.success).toBe(true);
});

test("SummaryResultSchema('detailed') rejects a summary past 4 000 characters", () => {
  const result = SummaryResultSchema("detailed").safeParse({
    ...BRIEF_RESULT,
    summary: "a".repeat(4001),
    keyTakeaways: takeaways(6),
  });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["summary"]);
});

test("SummaryResultSchema('detailed') rejects a detailed result with five takeaways", () => {
  const result = SummaryResultSchema("detailed").safeParse({ ...BRIEF_RESULT, keyTakeaways: takeaways(5) });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["keyTakeaways"]);
});

test("the mode decides: seven takeaways satisfy detailed and not brief", () => {
  const seven = { ...BRIEF_RESULT, keyTakeaways: takeaways(7) };
  expect(SummaryResultSchema("brief").safeParse(seven).success).toBe(false);
  expect(SummaryResultSchema("detailed").safeParse(seven).success).toBe(true);
});

test("AnySummaryResultSchema accepts either mode's result", () => {
  expect(AnySummaryResultSchema.safeParse(BRIEF_RESULT).success).toBe(true);
  expect(AnySummaryResultSchema.safeParse({ ...BRIEF_RESULT, keyTakeaways: takeaways(10) }).success).toBe(true);
});

test("AnySummaryResultSchema refuses a result outside both modes", () => {
  const result = AnySummaryResultSchema.safeParse({ ...BRIEF_RESULT, keyTakeaways: takeaways(2) });
  expect(result.success).toBe(false);
});

test("SummaryStatusSchema accepts a document no one has summarized", () => {
  const result = SummaryStatusSchema.safeParse({ status: "none" });
  expect(result.success).toBe(true);
});

test("SummaryStatusSchema accepts a done status carrying its result", () => {
  const body = { status: "done", result: BRIEF_RESULT };
  const result = SummaryStatusSchema.safeParse(body);
  expect(result.success).toBe(true);
  expect(result.data).toEqual(body);
});

test("SummaryStatusSchema accepts an error status carrying F§9's code", () => {
  const body = { status: "error", error: { code: "INTERRUPTED", message: "The hub restarted while this job ran." } };
  const result = SummaryStatusSchema.safeParse(body);
  expect(result.success).toBe(true);
});

test("SummaryStatusSchema refuses a status F§9 does not define", () => {
  const result = SummaryStatusSchema.safeParse({ status: "queued" });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["status"]);
});

test("SummaryStatusSchema refuses an error code outside F§9's set", () => {
  const result = SummaryStatusSchema.safeParse({ status: "error", error: { code: "TEAPOT", message: "No." } });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["error", "code"]);
});

test("SummaryErrorSchema accepts F§9's codes with a message", () => {
  const result = SummaryErrorSchema.safeParse({ code: "LLM_UNAVAILABLE", message: "The model endpoint did not answer." });
  expect(result.success).toBe(true);
});

test("SummaryErrorSchema refuses a code outside F§9's set", () => {
  const result = SummaryErrorSchema.safeParse({ code: "TOO_MANY_OPS", message: "No." });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["code"]);
});

test("SummaryErrorSchema refuses an error with no message", () => {
  const result = SummaryErrorSchema.safeParse({ code: "AI_DISABLED" });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["message"]);
});
