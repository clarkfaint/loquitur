/**
 * Importing a document into the library (F§10.1, F§7.2).
 *
 * Every import is the hub's reading, never the browser's: a file's bytes, an address, or a block of text is
 * sent to `POST /v1/parse`, and what comes back — F§5.1's document and, for a paged source, its anchors — is
 * what the library keeps. Parsing in the page would be a second implementation of F§5.4 and a second answer
 * to "what is this document", which is exactly what one dispatcher exists to prevent; the OCR engine, too,
 * belongs where the hub can cache it rather than in every reader's tab.
 *
 * A document's identity is its `docId`, a hash of its text (F§5.2), so importing the same document twice is
 * not a second library entry: the second answer carries the first `docId` and `duplicate: true`, and nothing
 * is written. What a document is made of is kept beside its records — the original bytes under
 * `orig/<docId>`, a paged source's anchors under `anchors/<docId>` — as F§5.9's `BlobCache` holds them, so a
 * later reading of the document does not have to ask the hub for what this device already has.
 */

import type { ParseResponse } from "@lectern/api-contract";
import type { DocumentMeta } from "@lectern/core";
import { getServices, getStorage } from "../services";

/** What an import answers: which document it is, and whether the library already held it. */
export interface ImportResult {
  /** The document's identity (F§5.2). */
  docId: string;
  /** True when the library already held a live document with that identity, so nothing was written. */
  duplicate: boolean;
}

/** The blob key a document's original bytes are kept under. */
export function originalKey(docId: string): string {
  return `orig/${docId}`;
}

/** The blob key a paged document's anchors are kept under (F§5.4). */
export function anchorsKey(docId: string): string {
  return `anchors/${docId}`;
}

/** The type the anchors are stored as: their own JSON, which is what a reader of the blob parses. */
const ANCHORS_MIME = "application/json";

/** The type a file with none of its own is sent and stored as. */
const FALLBACK_MIME = "application/octet-stream";

/** The type text a reader typed is sent and stored as. */
const TEXT_MIME = "text/plain";

/** The bytes a caller already holds for the document it just had parsed. */
interface OriginalBytes {
  bytes: Uint8Array;
  mime: string;
}

/** The metadata one parsed document becomes, with the fields the schema requires and no others. */
function metaFor(parsed: ParseResponse, addedAt: number): DocumentMeta {
  const { document } = parsed;
  const meta: DocumentMeta = {
    docId: document.docId,
    title: document.title,
    sourceKind: document.source.kind,
    folderId: null,
    addedAt,
    wordCount: document.wordCount,
    sentenceCount: document.sentenceCount,
    updatedAt: addedAt,
    deleted: false,
  };
  // An explicit `undefined` is refused by F§5.9's schema, so the field is added only when it holds a value.
  return document.source.uri === undefined ? meta : { ...meta, sourceUri: document.source.uri };
}

/**
 * Keep a document the hub just read: its metadata and its model through the store, its original bytes and
 * its anchors through the cache.
 *
 * The records are written first, because they are what makes the document exist — a document whose bytes
 * were cached but which no list holds would be invisible, while a document with no cached bytes is merely
 * one that has to be sent again. An import of a document the library already holds stops before any of it.
 */
async function keep(parsed: ParseResponse, original: OriginalBytes | null): Promise<ImportResult> {
  const { store, cache } = await getStorage();
  const { docId } = parsed.document;

  const existing = await store.getDocumentMeta(docId);
  if (existing !== null) return { docId, duplicate: true };

  await store.putDocument(metaFor(parsed, Date.now()), parsed.document);
  if (original !== null) await cache.put(originalKey(docId), original.bytes, original.mime);

  const anchors = parsed.anchors;
  if (anchors !== undefined && anchors.length > 0) {
    await cache.put(anchorsKey(docId), new TextEncoder().encode(JSON.stringify(anchors)), ANCHORS_MIME);
  }
  return { docId, duplicate: false };
}

/**
 * `importFile(file)` — a file the reader picked or dropped. Its bytes are the document, its name and its
 * declared type are hints; F§5.4 decides what they are, so a `.pdf` that is really text still reads as text.
 */
export async function importFile(file: File): Promise<ImportResult> {
  const { client } = await getServices();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = file.type === "" ? FALLBACK_MIME : file.type;
  return await keep(await client.parseFile(bytes, file.name, mime), { bytes, mime });
}

/**
 * `importUrl(url)` — an address the hub fetches and reads (F§7.2: `http` and `https` only, size-limited,
 * with private addresses refused unless the operator allows them). The page itself stays on the hub, so the
 * library keeps the model and the address rather than bytes this client never held.
 */
export async function importUrl(url: string): Promise<ImportResult> {
  const { client } = await getServices();
  return await keep(await client.parseUrl(url), null);
}

/**
 * `importText(text, title?)` — text the reader typed or pasted. The title is the caller's when it states
 * one, and F§5.1's own rule otherwise; the text's bytes are kept as the document's original, because they
 * are the document.
 */
export async function importText(text: string, title?: string): Promise<ImportResult> {
  const { client } = await getServices();
  return await keep(await client.parseText(text, title), { bytes: new TextEncoder().encode(text), mime: TEXT_MIME });
}
