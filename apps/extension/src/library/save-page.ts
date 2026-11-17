/**
 * Saving a page to the library (F§10.2, Phase 5): the widget's Save button, and the reader's place in a page
 * that is in the library.
 *
 * The extension is a reader with a library like every other Lectern client (F§8.1), and the library it keeps
 * is the same one the web app keeps: F§5.9's records in the `lectern` IndexedDB database, written through the
 * same `LibraryStore`, synced by the same engine (F§8.2). Two things are this file's whole job.
 *
 * **A save is a user action and nothing else.** F§10.2's rule is that the widget's Save button stores the
 * extracted document and that *nothing* is saved automatically, so this module has one entry point a caller
 * presses and no hook anywhere that could run on its own. What is stored is the `DocumentModel` the content
 * script already extracted and the metadata that lists it — never the page's markup, its cookies or a picture
 * of it, because the model is what the reader is read from and the rest would be somebody else's page copied
 * into the reader's library.
 *
 * **A saved document is what progress belongs to.** F§5.9's `Progress` is where the reader stopped *in a
 * document the library holds*; a page that was merely listened to once has no place to remember. So the write
 * is gated on the metadata being there, and the throttle is the document's own record: the timestamp the store
 * stamped on the last write is what says whether five seconds have passed, which means the throttle survives a
 * reload of the offscreen document rather than living in a variable that dies with it.
 *
 * The clock arrives as an argument where the contract names one (`savePage`'s `now`) and is read from the host
 * where the contract does not (`recordProgress`'s signature is fixed at three arguments); a test drives the
 * second one with a faked clock, which is what keeps these functions deterministic.
 */

import type { SyncEngine } from "@lectern/api-client";
import type { DocumentMeta, DocumentModel, LibraryStore, PlayerSnapshot, PlayerState } from "@lectern/core";

/** How often a moving player's place is written down: the contract's own ceiling, in milliseconds. */
export const PROGRESS_INTERVAL_MS = 5_000;

/** What one save answered. */
export interface SaveResult {
  /** The document's own identifier (F§5.2), which is what the hub's records and files are keyed by. */
  docId: string;
  /** True when the library already held this document, in which case nothing was written and nothing synced. */
  duplicate: boolean;
}

/** What a save is built from. */
export interface SavePageOptions {
  /** F§5.9's records. */
  store: LibraryStore;
  /** F§8.2's round, asked for once the record is on disk. */
  engine: SyncEngine;
  /** The document the content script extracted from the page (F§5.1). */
  document: DocumentModel;
  /** When the reader pressed Save. */
  now: number;
}

/**
 * The metadata a saved page is listed under (F§5.9).
 *
 * A page read out of a tab is an `html` document whatever the extraction said its source was — F§10.2 saves
 * *pages*, and the widget's button is offered on a page, not on a selection — while the address it was read
 * from travels as `sourceUri` when the model carries one. The counts are the model's own, so a library row
 * cannot disagree with the document it names.
 */
function metaForPage(document: DocumentModel, addedAt: number): DocumentMeta {
  const uri = document.source.uri;
  const meta: DocumentMeta = {
    docId: document.docId,
    title: document.title,
    sourceKind: "html",
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
 * `savePage({ store, engine, document, now })` — keep this page in the library, and tell the hub about it.
 *
 * The duplicate test is F§5.9's own question — does the library hold a record for this `docId` — asked before
 * either write, so pressing Save twice is a second answer and not a second document. The sync is what makes
 * the save visible on the reader's other devices: F§8.2's round uploads the model and pushes the record, and
 * a hub nobody can reach leaves both in the outbox for the next round rather than losing them.
 */
export async function savePage(options: SavePageOptions): Promise<SaveResult> {
  const { store, engine, document, now } = options;
  const { docId } = document;
  const existing = await store.getDocumentMeta(docId);
  if (existing !== null) return { docId, duplicate: true };
  await store.putDocument(metaForPage(document, now), document);
  await engine.syncNow();
  return { docId, duplicate: false };
}

/**
 * Whether the player is on the move (F§5.7's three transient states).
 *
 * The throttle below exists for these: a place that is about to change is not worth a write every 50 ms. A
 * player that has settled — `paused`, `ended`, `error`, `ready` — is written at once, which is what makes a
 * pause land even when the last write was a moment ago.
 */
function moving(state: PlayerState): boolean {
  return state === "playing" || state === "buffering" || state === "loading";
}

/**
 * `recordProgress(store, engine, snapshot)` — remember where the reader is in a document the library holds.
 *
 * Answers whether it wrote. Three things can stop it, and each is a fact rather than a failure: there is no
 * document (`idle`), the library does not hold this one (an unsaved page has nowhere to remember a place), or
 * the player is moving and the last write was less than `PROGRESS_INTERVAL_MS` ago.
 *
 * The engine is told a local record changed, because that is what F§8.2's debounce is for: a place written
 * every few seconds must not become a push every few seconds, so the round it schedules is the one round a
 * burst of writes shares.
 */
export async function recordProgress(store: LibraryStore, engine: SyncEngine, snapshot: PlayerSnapshot): Promise<boolean> {
  const { docId } = snapshot;
  if (docId === null) return false;
  const meta = await store.getDocumentMeta(docId);
  if (meta === null) return false;
  const at = Date.now();
  if (moving(snapshot.state)) {
    const written = await store.getProgress(docId);
    if (written !== null && at - written.updatedAt < PROGRESS_INTERVAL_MS) return false;
  }
  // The store stamps `updatedAt` with its own clock (F§5.9), so the value here is only the record's shape.
  await store.setProgress({
    docId,
    sentenceIndex: snapshot.sentenceIndex,
    wordIndex: snapshot.wordIndex,
    updatedAt: at,
  });
  engine.notifyLocalChange();
  return true;
}
