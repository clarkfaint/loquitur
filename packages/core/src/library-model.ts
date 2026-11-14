/**
 * The library's own shape (F§5.9, F§10.1): the folder tree a reader moves through, the filter and the sorts a
 * document list offers, and the progress a row shows.
 *
 * Every function here is a function of the records it is handed — no store, no clock, no DOM — because the
 * same library is drawn by the web app (F§10.1) and, later, by the Android app (F§10.4), and a list that
 * sorted or filtered itself differently on two platforms would be two libraries. The store answers records;
 * this module decides what a screen does with them.
 */

import type { DocumentMeta, Folder, Progress } from "./store/types";

/** One folder with the folders inside it, as a tree drawn from the top down. */
export interface FolderNode {
  /** The folder itself, exactly as the store handed it over. */
  folder: Folder;
  /** The folders whose `parentId` is this folder's id, in the same order as the roots. */
  children: FolderNode[];
}

/** What a document list is asked to show (F§5.9's own list query, kept in one place). */
export interface DocumentFilter {
  /** The folder to show, or `null` for the documents filed in none. Absent shows every folder. */
  folderId?: string | null;
  /** A fragment of the title, matched without case. Blank or absent shows every title. */
  text?: string;
}

/** The orders a document list can be sorted in (F§10.1). */
export type DocumentSortOrder = "addedAt" | "title" | "progress";

/**
 * The folders as a tree: a folder is a child of the folder its `parentId` names, and a root when that folder
 * is not one this list holds — an orphan whose parent was deleted, and equally a folder whose parent is not
 * in the list at all, which is what a filtered or paginated read of the store produces. A folder marked
 * deleted is left out, and its children then have no parent and become roots, so nothing is ever lost from
 * the tree by deleting something above it.
 *
 * A folder whose parent chain loops back to itself cannot be a child of anything — following the chain
 * never reaches a root — so it is drawn as a root rather than recursed into forever.
 *
 * Roots and siblings are ordered by name, without case, so the tree reads the same on every platform.
 */
export function buildFolderTree(folders: readonly Folder[]): FolderNode[] {
  const byId = new Map<string, FolderNode>();
  for (const folder of folders) {
    if (folder.deleted) continue;
    byId.set(folder.id, { folder, children: [] });
  }

  /** Whether following the parent chain upward from `id` comes back to `id`. */
  const loops = (id: string): boolean => {
    const seen = new Set<string>([id]);
    let current = byId.get(id)?.folder.parentId ?? null;
    while (current !== null) {
      if (seen.has(current)) return true;
      seen.add(current);
      current = byId.get(current)?.folder.parentId ?? null;
    }
    return false;
  };

  const roots: FolderNode[] = [];
  for (const node of byId.values()) {
    const parentId = node.folder.parentId;
    const parent = parentId === null ? undefined : byId.get(parentId);
    if (parent === undefined || parent === node || loops(node.folder.id)) roots.push(node);
    else parent.children.push(node);
  }

  return order(roots);
}

/** A tree in name order, at every level, in place. */
function order(nodes: FolderNode[]): FolderNode[] {
  nodes.sort((a, b) => a.folder.name.localeCompare(b.folder.name, undefined, { sensitivity: "base" }));
  for (const node of nodes) order(node.children);
  return nodes;
}

/**
 * The documents a filter asks for: live ones only (a tombstone is not a document a list shows), filed in the
 * named folder when the filter names one — `null` being the documents filed in none, which is a different
 * question from "every folder" — and carrying the text fragment in their title when the filter names one.
 *
 * The rule is F§5.9's own list query, so a screen that keeps its library in memory and a screen that reads it
 * back from a store answer the same list for the same question.
 */
export function filterDocuments(documents: readonly DocumentMeta[], filter: DocumentFilter = {}): DocumentMeta[] {
  const wanted = filter.text?.trim().toLowerCase() ?? "";
  return documents.filter((document) => {
    if (document.deleted) return false;
    if (filter.folderId !== undefined && document.folderId !== filter.folderId) return false;
    return wanted === "" || document.title.toLowerCase().includes(wanted);
  });
}

/**
 * The documents in the order a reader asked for, as a new list — the caller's own order is never touched.
 *
 * `addedAt` puts the newest document first, which is the order a library is filled in; `title` sorts by name
 * without case; `progress` puts the document the reader is furthest through first, and needs the fractions
 * to hand (there is no room for a reading position in `DocumentMeta`). Two documents that agree on the sort
 * key keep a stable, meaningful order — a title and an addition date respectively — so the list does not
 * shuffle between two reads of the same records.
 */
export function sortDocuments(
  documents: readonly DocumentMeta[],
  order: DocumentSortOrder,
  progress: Readonly<Record<string, number>> = {},
): DocumentMeta[] {
  const fractionOf = (document: DocumentMeta): number => progress[document.docId] ?? 0;
  const compare = (a: DocumentMeta, b: DocumentMeta): number => {
    if (order === "addedAt") return b.addedAt - a.addedAt || compareTitles(a, b);
    if (order === "title") return compareTitles(a, b) || a.docId.localeCompare(b.docId);
    return fractionOf(b) - fractionOf(a) || b.addedAt - a.addedAt;
  };
  return [...documents].sort(compare);
}

/** Two titles in the order a reader expects them, without case. */
function compareTitles(a: DocumentMeta, b: DocumentMeta): number {
  return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
}

/**
 * `documentProgress(meta, progress)` — how far the reader is through a document, as the fraction F§5.6(f)
 * reports.
 *
 * F§5.6(f) counts the words before the position, and only the model knows how many words each sentence
 * holds. A list of a whole library cannot load every document's text to draw a percentage beside its title,
 * so the words before the position are estimated from the document's own average sentence length — the two
 * counts `DocumentMeta` carries. The figure is exactly right at a document's start and at its end and within
 * one sentence's length in between, which is what a progress bar in a list is for; a reader screen that
 * holds the model reports F§5.6(f)'s own number.
 */
export function documentProgress(meta: DocumentMeta, progress: Progress | null): number {
  if (progress === null || meta.wordCount === 0) return 0;
  const wordsPerSentence = meta.sentenceCount === 0 ? 0 : meta.wordCount / meta.sentenceCount;
  const read = progress.sentenceIndex * wordsPerSentence + progress.wordIndex;
  return Math.min(1, Math.max(0, read / meta.wordCount));
}
