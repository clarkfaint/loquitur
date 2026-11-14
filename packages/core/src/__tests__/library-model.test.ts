/**
 * The library's own shape (F§5.9, F§10.1). Every case here is a record in and a list out: the tree of
 * folders, what a filter keeps, and the three orders a document list can be shown in.
 */

import { expect, test } from "vitest";
import { buildFolderTree, documentProgress, filterDocuments, sortDocuments } from "../library-model";
import type { DocumentMeta, Folder, Progress } from "../store/types";

/** A folder with everything the schema requires, and whatever the case is about. */
function folder(id: string, name: string, parentId: string | null = null, deleted = false): Folder {
  return { id, name, parentId, updatedAt: 1, deleted };
}

/** A document with everything the schema requires, and whatever the case is about. */
function document(docId: string, title: string, extra: Partial<DocumentMeta> = {}): DocumentMeta {
  return {
    docId,
    title,
    sourceKind: "txt",
    folderId: null,
    addedAt: 1,
    wordCount: 100,
    sentenceCount: 10,
    updatedAt: 1,
    deleted: false,
    ...extra,
  };
}

/** A reading position inside a document. */
function position(docId: string, sentenceIndex: number, wordIndex: number): Progress {
  return { docId, sentenceIndex, wordIndex, updatedAt: 1 };
}

/** The tree as `name(depth)` lines, which is what nesting and orphan handling look like from outside. */
function outline(nodes: ReturnType<typeof buildFolderTree>, depth = 0): string[] {
  return nodes.flatMap((node) => [`${node.folder.name}(${depth})`, ...outline(node.children, depth + 1)]);
}

test("buildFolderTree nests children under their parent", () => {
  const folders = [folder("b", "Bravo", "a"), folder("a", "Alpha"), folder("c", "Charlie", "b")];

  expect(outline(buildFolderTree(folders))).toEqual(["Alpha(0)", "Bravo(1)", "Charlie(2)"]);
});

test("buildFolderTree makes an orphan, and a deleted folder's child, a root", () => {
  const folders = [
    folder("a", "Alpha"),
    folder("gone", "Gone", null, true),
    folder("b", "Bravo", "gone"),
    folder("c", "Charlie", "absent"),
  ];

  // `Bravo`'s parent is a tombstone and `Charlie`'s was never in the list: both are drawn at the top.
  expect(outline(buildFolderTree(folders))).toEqual(["Alpha(0)", "Bravo(0)", "Charlie(0)"]);
});

test("buildFolderTree orders roots and siblings by name", () => {
  const folders = [folder("b", "beta", "root"), folder("a", "Alpha"), folder("root", "root"), folder("c", "Gamma", "root")];

  expect(outline(buildFolderTree(folders))).toEqual(["Alpha(0)", "root(0)", "beta(1)", "Gamma(1)"]);
});

test("buildFolderTree answers a parent loop with roots rather than recursing forever", () => {
  const folders = [folder("a", "Alpha", "b"), folder("b", "Bravo", "a"), folder("self", "Self", "self")];

  expect(outline(buildFolderTree(folders))).toEqual(["Alpha(0)", "Bravo(0)", "Self(0)"]);
});

test("filterDocuments keeps only live documents carrying the fragment in the title", () => {
  const documents = [document("a", "Lighthouse Notes"), document("b", "Kitchen Notes"), document("c", "Burned Notes", { deleted: true })];

  expect(filterDocuments(documents, { text: "note" }).map((entry) => entry.docId)).toEqual(["a", "b"]);
  expect(filterDocuments(documents, { text: "  KITCHEN  " }).map((entry) => entry.docId)).toEqual(["b"]);
  expect(filterDocuments(documents, { text: "" }).map((entry) => entry.docId)).toEqual(["a", "b"]);
  expect(filterDocuments(documents, { text: "harbour" })).toEqual([]);
});

test("filterDocuments tells a folder, no folder, and every folder apart", () => {
  const documents = [
    document("a", "Alpha", { folderId: "f1" }),
    document("b", "Bravo", { folderId: null }),
    document("c", "Charlie", { folderId: "f2" }),
  ];

  expect(filterDocuments(documents, { folderId: "f1" }).map((entry) => entry.docId)).toEqual(["a"]);
  expect(filterDocuments(documents, { folderId: null }).map((entry) => entry.docId)).toEqual(["b"]);
  expect(filterDocuments(documents).map((entry) => entry.docId)).toEqual(["a", "b", "c"]);
});

test("filterDocuments keeps a filter's two questions together", () => {
  const documents = [
    document("a", "Lighthouse Notes", { folderId: "f1" }),
    document("b", "Lighthouse Meals", { folderId: "f2" }),
    document("c", "Harbour Notes", { folderId: "f1" }),
  ];

  expect(filterDocuments(documents, { folderId: "f1", text: "lighthouse" }).map((entry) => entry.docId)).toEqual(["a"]);
});

test("sortDocuments by addedAt puts the newest first, and a tie in title order", () => {
  const documents = [
    document("a", "Alpha", { addedAt: 10 }),
    document("b", "Bravo", { addedAt: 30 }),
    document("c", "Charlie", { addedAt: 10 }),
  ];

  expect(sortDocuments(documents, "addedAt").map((entry) => entry.docId)).toEqual(["b", "a", "c"]);
  expect(documents.map((entry) => entry.docId)).toEqual(["a", "b", "c"]);
});

test("sortDocuments by title ignores case and orders alike titles by id", () => {
  const documents = [document("z", "banana"), document("a", "Apple"), document("b", "apple")];

  expect(sortDocuments(documents, "title").map((entry) => entry.docId)).toEqual(["a", "b", "z"]);
});

test("sortDocuments by progress puts the furthest-read document first", () => {
  const documents = [document("a", "Alpha"), document("b", "Bravo"), document("c", "Charlie")];
  const progress = { a: 0.25, c: 0.9 };

  // `bravo` has no fraction at all, which is where a document nobody has opened sits.
  expect(sortDocuments(documents, "progress", progress).map((entry) => entry.docId)).toEqual(["c", "a", "b"]);
});

test("documentProgress reports F§5.6(f)'s fraction from the counts a list carries", () => {
  const meta = document("a", "Alpha", { wordCount: 100, sentenceCount: 10 });

  expect(documentProgress(meta, null)).toBe(0);
  expect(documentProgress(meta, position("a", 0, 0))).toBe(0);
  expect(documentProgress(meta, position("a", 5, 0))).toBeCloseTo(0.5, 10);
  expect(documentProgress(meta, position("a", 10, 0))).toBe(1);
  // A position past the end of the document cannot report more than a finished document.
  expect(documentProgress(meta, position("a", 20, 4))).toBe(1);
  expect(documentProgress(document("b", "Empty", { wordCount: 0, sentenceCount: 0 }), position("b", 0, 0))).toBe(0);
});
