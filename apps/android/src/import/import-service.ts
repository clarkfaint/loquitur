/**
 * Importing a document into the library (F§10.4, F§7.2).
 *
 * Every import ends in the same two writes — F§5.9's records through the store, and the bytes a document was
 * made from through the blob cache — and every import begins by asking the library whether it already holds the
 * document. In between there are four doors:
 *
 * - `importPickedFile` — a file the reader chose. Its bytes are read from the URI the system picker answered
 *   with, sent to the hub at `POST /v1/parse`, and kept as the document's original.
 * - `importUrl` — an address. The hub fetches and reads it (F§7.2: `http` and `https` only, size-limited, with
 *   private addresses refused unless the operator allows them), so this device never holds those bytes.
 * - `importTextLocal` — text the reader typed or pasted. F§10.4 builds it on the device with `parseText` →
 *   `buildDocument`, so this door opens with the hub unreachable and never touches the network at all.
 * - `importDocumentModel` — a model a caller already holds, from a door that produces documents itself (a scan,
 *   a summary). Nothing is re-parsed.
 *
 * Nothing but plain text is parsed here. PDF, EPUB, DOCX, HTML and images all go to the hub, because a second
 * implementation of F§5.4 in the app would be a second answer to "what is this document", and the OCR engine
 * belongs where the hub can cache it rather than in every phone.
 *
 * A document's identity is its `docId`, a hash of its normalized block texts (F§5.2), so importing the same
 * document twice is not a second library entry: the second import answers `{ docId, duplicate: true }` and
 * writes nothing at all. The store answers `null` for a document whose record is a tombstone, so a document the
 * reader deleted can be imported again — the same rule the web app's import follows.
 */

import type { ParseResponse } from "@lectern/api-contract";
import { buildDocument, type DocumentMeta, type DocumentModel, parseText, type Source } from "@lectern/core";
import { createClient } from "../connection";
import { getStores } from "../stores";

/** What an import answers: which document it is, and whether the library already held it. */
export interface ImportResult {
  /** The document's identity (F§5.2). */
  docId: string;
  /** True when the library already held a live document with that identity, so nothing was written. */
  duplicate: boolean;
}

/** A file the reader picked: where its bytes are, the name it has, and the type it claims. */
export interface PickedFile {
  /** The URI the system picker answered with, which the app may read. */
  uri: string;
  /** The file's own name, which F§5.4 reads as a hint. */
  name: string;
  /** The declared MIME type, or an empty string when the picker reported none. */
  mime: string;
}

/**
 * The types the picker offers (F§5.4): the six formats the hub reads as documents, and nothing else. Declared
 * here rather than read from `@lectern/core/parsers`, because that entry is the Node-only parser entry and
 * reaching it from the app would pull Node-only parsers into the bundle; the strings are the ones
 * `apps/desktop`'s watcher hands over, and the DOCX type is written out in full.
 */
export const SUPPORTED_IMPORT_MIME_TYPES: readonly string[] = [
  "application/pdf",
  "application/epub+zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/html",
  "text/plain",
  "text/markdown",
];

/** The blob key a document's original bytes are kept under — the web app's own key, so the caches match. */
export function originalKey(docId: string): string {
  return `orig/${docId}`;
}

/** The blob key a paged document's anchors are kept under (F§5.4) — the web app's own key as well. */
export function anchorsKey(docId: string): string {
  return `anchors/${docId}`;
}

/** The type the anchors are stored as: their own JSON, which is what a reader of the blob parses. */
const ANCHORS_MIME = "application/json";

/** The type a file with none of its own is sent and stored as. */
const FALLBACK_MIME = "application/octet-stream";

/** The type text a reader typed is sent and stored as. */
const TEXT_MIME = "text/plain";

/** F§5.1's source for text this device read itself: the plain-text kind, and no address. */
const TEXT_SOURCE: Source = { kind: "txt" };

/** The bytes a caller already holds for the document it just had read. */
interface OriginalBytes {
  bytes: Uint8Array;
  mime: string;
}

/**
 * The metadata one parsed document becomes, with the fields F§5.9's schema requires and no others. The address
 * is the model's own when it carries one — the hub records the URL a page came from — and the caller's
 * otherwise, which is how a document built from a scan or a paste keeps the place it came from.
 */
function metaFor(document: DocumentModel, sourceUri: string | undefined, addedAt: number): DocumentMeta {
  const uri = document.source.uri ?? sourceUri;
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
  return uri === undefined ? meta : { ...meta, sourceUri: uri };
}

/**
 * Keep a document the library does not already hold: its metadata and its model through the store, its original
 * bytes and its anchors through the cache.
 *
 * The records are written first, because they are what makes the document exist — a document whose bytes were
 * cached but which no list holds would be invisible, while a document with no cached bytes is merely one whose
 * bytes are still on the hub. A document the library already holds stops before any of it.
 */
async function keep(parsed: ParseResponse, original: OriginalBytes | null, sourceUri?: string): Promise<ImportResult> {
  const { store, cache } = await getStores();
  const { document } = parsed;
  const { docId } = document;

  const existing = await store.getDocumentMeta(docId);
  if (existing !== null) return { docId, duplicate: true };

  await store.putDocument(metaFor(document, sourceUri, Date.now()), document);
  if (original !== null) await cache.put(originalKey(docId), original.bytes, original.mime);

  const anchors = parsed.anchors;
  if (anchors !== undefined && anchors.length > 0) {
    await cache.put(anchorsKey(docId), new TextEncoder().encode(JSON.stringify(anchors)), ANCHORS_MIME);
  }
  return { docId, duplicate: false };
}

/**
 * The bytes a picked file's URI holds, read through the platform's own file system. The module is loaded when a
 * file is actually read rather than when this module is imported, which is the rule every platform module in
 * this app follows: `react-native` cannot be parsed by the Node test program that reaches this package.
 */
async function readPickedBytes(uri: string): Promise<Uint8Array> {
  const fileSystem: typeof import("expo-file-system") = await import("expo-file-system");
  const file = new fileSystem.File(uri);
  return await file.bytes();
}

/**
 * `importPickedFile({ uri, name, mime })` — a file the reader chose. Its bytes are read from the URI the system
 * picker answered with, handed to the hub, and kept beside the document; the name and the type are hints, and
 * F§5.4 decides what the bytes are, so a `.pdf` that is really text still reads as text.
 */
export async function importPickedFile(file: PickedFile): Promise<ImportResult> {
  const bytes = await readPickedBytes(file.uri);
  const mime = file.mime === "" ? FALLBACK_MIME : file.mime;
  const client = await createClient();
  const parsed = await client.parseFile(bytes, file.name, mime);
  return await keep(parsed, { bytes, mime });
}

/**
 * `importUrl(url)` — an address the hub fetches and reads (F§7.2). The page itself stays on the hub, so the
 * library keeps the model and the address rather than bytes this device never held.
 */
export async function importUrl(url: string): Promise<ImportResult> {
  const client = await createClient();
  return await keep(await client.parseUrl(url), null);
}

/**
 * `importTextLocal(text, title?)` — text the reader typed or pasted, read on the device: `parseText` produces
 * F§5.4's raw blocks and `buildDocument` makes F§5.1's model from them, with no client and no network, so this
 * door works with the hub unreachable (F§10.4). The title is the caller's when it states one and F§5.1's own
 * rule otherwise; the text's bytes are kept as the document's original, because they are the document.
 */
export async function importTextLocal(text: string, title?: string): Promise<ImportResult> {
  const document = buildDocument(parseText(text), title === undefined ? { source: TEXT_SOURCE } : { title, source: TEXT_SOURCE });
  return await keep({ document }, { bytes: new TextEncoder().encode(text), mime: TEXT_MIME });
}

/**
 * `importDocumentModel(model, sourceUri?)` — a document a caller already holds a model for, which is what a
 * scanner or a summary produces. Nothing is re-read: the model is stored as it stands, and `sourceUri` records
 * where the text came from when the model itself does not already say.
 */
export async function importDocumentModel(model: DocumentModel, sourceUri?: string): Promise<ImportResult> {
  return await keep({ document: model }, null, sourceUri);
}
