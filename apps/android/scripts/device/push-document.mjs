#!/usr/bin/env node
// Push a document to the local hub as a second device (U-061, F§8.2, F§7.2).
//
//   node apps/android/scripts/device/push-document.mjs [hubUrl] [token]
//
// What this writes is the *other* half of F§8.2's round trip from the one the phone performs: an original
// five-sentence text is parsed by the hub itself (`POST /v1/parse`, F§7.2's text form), the model that comes
// back is uploaded under its own `docId` (`PUT /v1/library/documents/:docId/model`, F§8.2's first round
// step, gzipped because that is the container F§7.2 carries a model in), and one `document` op is pushed
// under a device identifier of this script's own — so the record the phone receives is a record written by
// *another device*, which is the only shape that proves the pull half of the round.
//
// The op's record is F§5.9's `DocumentMeta`, built from the parse answer's own fields: the title the builder
// gave the document, its counts, and the source kind the hub read. Nothing is invented — a meta that
// disagrees with the model the hub holds would be a bug this script put in the reader's library.
//
// stdout carries the document's title and nothing else, because the check that runs this reads it from
// there; everything else — progress, failures — goes to stderr.
//
// Zero dependencies: Node built-ins only (AGENTS.md §7), like every other script in this directory.

import { gzipSync } from "node:zlib";

/** F§7.1's default port and the token this repository's own device harness starts its hub with. */
const HUB_URL = process.argv[2] ?? process.env.LECTERN_DEVICE_HUB_URL ?? "http://127.0.0.1:8787";
const TOKEN = process.argv[3] ?? process.env.LECTERN_DEVICE_HUB_TOKEN ?? "lectern-hub-test-token-0123456789";

/** The device this push is made under: not the phone, which is the whole point of the check. */
const DEVICE_ID = "u061-push";

/** An original five-sentence probe, in Lectern's own words (AGENTS.md §4.6). The sentences are separate
 * paragraphs — `parseText` makes one block per blank-line-separated paragraph — because the builder titles a
 * document from its opening block (F§5.4's `titleOf`, which keeps the first 60 characters) and the library row
 * draws that title: a first block that fits one line is a title the harness can read back off the screen
 * unbroken. */
const TEXT = [
  "A probe document pushed from another device.",
  "The hub is the meeting point of a reader's library rather than the owner of it, so every device keeps its own copy of the records it holds.",
  "A device pushes the operations its outbox has collected and pulls the changes it has not seen yet, one revision at a time.",
  "Last writer wins on the pair of a timestamp and a device identifier, which is what lets two devices edit the same folder without a conflict to resolve.",
  "A document's text travels beside its record, so a device that learns of a document it has never held waits for the model until somebody opens it.",
].join("\n\n");

/** One request, with F§11's token in a header and never in a URL, and the hub's own refusal reported. */
async function call(method, path, body, contentType = "application/json") {
  const init = {
    method,
    headers: { authorization: `Bearer ${TOKEN}` },
  };
  if (body !== undefined) {
    init.headers["content-type"] = contentType;
    init.body = typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body);
  }
  const response = await fetch(new URL(path, HUB_URL), init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${text}`);
  return text === "" ? undefined : JSON.parse(text);
}

/** F§5.9's `DocumentMeta` for a model the hub just parsed: every field read off the model itself. */
function metaFor(document, now) {
  return {
    docId: document.docId,
    title: document.title,
    sourceKind: document.source.kind,
    folderId: null,
    addedAt: now,
    wordCount: document.wordCount,
    sentenceCount: document.sentenceCount,
    updatedAt: now,
    deleted: false,
  };
}

async function main() {
  process.stderr.write(`push-document: parsing five sentences through ${HUB_URL}\n`);
  const parsed = await call("POST", "/v1/parse", { text: TEXT });
  const document = parsed.document;
  if (typeof document?.docId !== "string" || document.docId === "") {
    throw new Error("the hub's parse answer carries no document");
  }

  process.stderr.write(`push-document: uploading the model for ${document.docId}\n`);
  await call("PUT", `/v1/library/documents/${document.docId}/model`, gzipSync(JSON.stringify(document)), "application/gzip");

  // A unique op id per run: the hub ignores an op it has already seen (F§8.2), and a repeat run has to be a
  // change the phone can see rather than one it has already applied.
  const now = Date.now();
  const op = {
    opId: `${DEVICE_ID}-${now}`,
    deviceId: DEVICE_ID,
    entity: "document",
    entityId: document.docId,
    kind: "put",
    ts: now,
    record: metaFor(document, now),
  };

  process.stderr.write(`push-document: pushing one document op as ${DEVICE_ID}\n`);
  const answer = await call("POST", "/v1/sync/push", { deviceId: DEVICE_ID, ops: [op] });
  if (!Array.isArray(answer?.accepted) || !answer.accepted.includes(op.opId)) {
    throw new Error(`the hub did not accept the op: ${JSON.stringify(answer)}`);
  }

  process.stderr.write(`push-document: accepted at rev ${answer.rev}\n`);
  process.stdout.write(`${document.title}\n`);
}

main().catch((error) => {
  process.stderr.write(`push-document: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
