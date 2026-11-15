/**
 * The desktop shell's half of the web app (F§10.3).
 *
 * The shell never parses anything and never writes to the library itself: it hands the app text or files and
 * the app's ordinary import pipeline — the hub's `POST /v1/parse`, F§5.2's `docId`, the stores F§5.9 defines —
 * does the rest. That is why a selection read from another application and a file dropped on the import screen
 * behave the same way, and why the folder rules below are the app's own (`putFolder`, `putDocument`,
 * `deleteDocument`) rather than a second bookkeeping of the same library.
 *
 * Two hand-offs are F§10.3's:
 *
 * - **files** (a watched folder, the region reader's PNG) land in the folder the shell named, or in `Inbox`
 *   when it named none, and the last of them is opened playing when the shell asked for that;
 * - **text** (a selection, a screen region's OCR) lands in `Quick reads` and is opened playing at once. That
 *   folder is a scratch pad rather than an archive, so it keeps its newest `QUICK_READS_LIMIT` documents and
 *   the fifty-first falls off the end — which is what F§10.3 means by keeping only the newest 50.
 *
 * The feature is inert in a browser: `getDesktopBridge()` answers `null` unless the shell really is there, so
 * nothing below runs in the web app's own tabs or in its browser tests.
 */

import type { Folder, LibraryStore } from "@lectern/core";
import { type DesktopImportRequest, type DesktopReadRequest, getDesktopBridge } from "@lectern/ui-web";
import { importFile, importText } from "../import/import-service";
import { navigate } from "../router";
import type { Services } from "../services";

/** The folder a selection or a screen region is kept in (F§10.3). */
export const QUICK_READS_FOLDER = "Quick reads";

/** How many documents that folder keeps (F§10.3). */
export const QUICK_READS_LIMIT = 50;

/** Where files the shell read on its own — a watched folder, the region reader — are kept (F§10.3). */
export const INBOX_FOLDER = "Inbox";

/** The location that opens a document playing (F§10.1's reader route). */
export function readerLocation(docId: string): string {
  return `#/read/${encodeURIComponent(docId)}?autoplay=1`;
}

/** The root folder with this name, made if the library has none — F§5.9 has no unique names, so the first
 * match is the one a previous hand-off made. */
async function folderNamed(store: LibraryStore, name: string): Promise<Folder> {
  const existing = (await store.listFolders()).find((folder) => folder.deleted === false && folder.name === name);
  if (existing !== undefined) return existing;
  const created: Folder = { id: crypto.randomUUID(), name, parentId: null, updatedAt: Date.now(), deleted: false };
  await store.putFolder(created);
  return created;
}

/** File a document into a folder: one ordinary store write, so the move replicates like any other change. */
async function fileInto(store: LibraryStore, docId: string, folderId: string): Promise<void> {
  const meta = await store.getDocumentMeta(docId);
  if (meta === null || meta.folderId === folderId) return;
  const model = await store.getDocumentModel(docId);
  if (model === null) return;
  await store.putDocument({ ...meta, folderId, updatedAt: Date.now() }, model);
}

/** Keep at most `QUICK_READS_LIMIT` documents in a folder, newest first by the time they were added. */
async function trimFolder(store: LibraryStore, folderId: string, limit: number): Promise<string[]> {
  const held = await store.listDocuments({ folderId });
  const newestFirst = [...held].sort((left, right) => right.addedAt - left.addedAt);
  const dropped = newestFirst.slice(limit);
  for (const document of dropped) await store.deleteDocument(document.docId);
  return dropped.map((document) => document.docId);
}

/**
 * `handleImportRequest(store, request)` — import every file the shell read, file them, and answer the document
 * that was opened (or `null` when nothing was imported or the shell asked for no playback).
 *
 * The bytes are already in memory, which is why they arrive as a `File` here rather than as a path: F§5.4
 * decides what a document is from its bytes and its name, and nothing about that decision needs the disk.
 */
export async function handleImportRequest(store: LibraryStore, request: DesktopImportRequest): Promise<string | null> {
  if (request.files.length === 0) return null;

  const imported: string[] = [];
  for (const file of request.files) {
    const payload = new File([new Uint8Array(file.bytes)], file.name, { type: file.mime });
    imported.push((await importFile(payload)).docId);
  }

  const folder = await folderNamed(store, request.folderName ?? INBOX_FOLDER);
  for (const docId of imported) await fileInto(store, docId, folder.id);

  const last = imported[imported.length - 1];
  if (last === undefined || !request.play) return null;
  navigate(readerLocation(last));
  return last;
}

/**
 * `handleReadText(store, request)` — import text the shell read and open it playing, keeping `Quick reads` to
 * its newest fifty.
 *
 * The document is opened even when the library already held it: the reader asked to hear this text, and a
 * second reading of a document it already has is the reading it wants.
 */
export async function handleReadText(store: LibraryStore, request: DesktopReadRequest): Promise<string> {
  const { docId } = await importText(request.text, request.title);
  const folder = await folderNamed(store, QUICK_READS_FOLDER);
  await fileInto(store, docId, folder.id);
  await trimFolder(store, folder.id, QUICK_READS_LIMIT);
  navigate(readerLocation(docId));
  return docId;
}

/**
 * `desktopIntegration(services)` — the start-up feature (see `../boot`).
 *
 * It subscribes to the shell's two hand-offs and does nothing else, so a browser — where there is no bridge —
 * pays one property read and the shell's requests are the only thing that can make it work.
 */
export function desktopIntegration(services: Services): void {
  const bridge = getDesktopBridge();
  if (bridge === null) return;

  bridge.onImportRequest((request) => {
    void handleImportRequest(services.store, request).catch(report);
  });
  bridge.onReadText((request) => {
    void handleReadText(services.store, request).catch(report);
  });
}

/** A hand-off that failed has nowhere to be shown — the shell asked for it, not the reader — so it is logged
 * with what it was doing. */
function report(cause: unknown): void {
  console.error(`a desktop hand-off failed: ${cause instanceof Error ? cause.message : String(cause)}`);
}
