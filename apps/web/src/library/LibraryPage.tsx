/**
 * The library screen (F§10.1): the folders a reader keeps documents in, the documents themselves, and what
 * can be done to either.
 *
 * The screen is a view of F§5.9's records and nothing more. It reads them from the store, draws the list the
 * reader's search, folder and sort ask for — through `@lectern/core`'s library model, which is the same code
 * the Android app will draw its library with — and every action is a store write: a folder is put, renamed
 * or tombstoned, a document is filed or tombstoned. Nothing here holds a second copy of the library that a
 * reload would contradict, which is why each action ends by reading the records back.
 *
 * Two decisions worth naming. Deleting is two steps, because F§5.9's deletes are tombstones that travel to
 * the reader's other devices: the first press asks, and the second writes. And deleting a folder moves what
 * was filed in it — its documents and its child folders — up to its parent, because a folder is a place and
 * emptying a place is not the same as deleting what it held.
 *
 * The screen's own rules are injected as a `<style>` element rather than added to `app.css`, whose owning
 * unit is frozen; they use the tokens `@lectern/ui-web/styles.css` declares, so the screen follows the
 * reader's theme like every other one.
 */

import {
  buildFolderTree,
  type DocumentFilter,
  type DocumentMeta,
  type DocumentSortOrder,
  documentProgress,
  type Folder,
  type FolderNode,
  filterDocuments,
  sortDocuments,
} from "@lectern/core";
import { type ReactElement, useEffect, useState } from "react";
import { anchorsKey, originalKey } from "../import/import-service";
import { getStorage, type Storage } from "../services";

/** The orders the list offers, and the guard that keeps a `<select>` from inventing a fourth. */
const SORT_ORDERS: readonly DocumentSortOrder[] = ["addedAt", "title", "progress"];

/** The label each order is offered under. */
const ORDER_LABELS: Readonly<Record<DocumentSortOrder, string>> = { addedAt: "Added", title: "Title", progress: "Progress" };

/** The ids the labels point at. */
const SEARCH_ID = "lectern-library-search";
const SORT_ID = "lectern-library-sort";
const NEW_FOLDER_ID = "lectern-library-new-folder";

/** The id of the `<style>` element this screen's rules live in. */
const STYLE_ID = "lectern-library-styles";

/** How far one level of nesting is indented, in the stylesheet's own spacing token. */
const INDENT = "var(--lectern-space-4)";

/** The screen's layout, in the design tokens the stylesheet declares. */
const RULES = [
  ".lectern-library { display: flex; flex-direction: column; gap: var(--lectern-space-5); }",
  ".lectern-library__columns { display: grid; gap: var(--lectern-space-4); grid-template-columns: minmax(14rem, 1fr) 2fr; }",
  ".lectern-library__panel { background: var(--lectern-surface); border: 1px solid var(--lectern-line);",
  "  border-radius: var(--lectern-radius-3); padding: var(--lectern-space-4); }",
  ".lectern-library__panel h2 { font-size: 1rem; margin: 0 0 var(--lectern-space-3); }",
  ".lectern-library__tree { display: flex; flex-direction: column; gap: var(--lectern-space-1);",
  "  list-style: none; margin: 0; padding: 0; }",
  ".lectern-library__folder-row { align-items: center; display: flex; flex-wrap: wrap; gap: var(--lectern-space-1); }",
  ".lectern-library__folder-name { background: transparent; border: 1px solid transparent;",
  "  border-radius: var(--lectern-radius-1); color: var(--lectern-ink); cursor: pointer; font: inherit;",
  "  padding: var(--lectern-space-1) var(--lectern-space-2); text-align: start; }",
  '.lectern-library__folder-name[aria-pressed="true"] { background: var(--lectern-accent-soft); }',
  ".lectern-library__folder-row button { background: transparent; border: 1px solid var(--lectern-line);",
  "  border-radius: var(--lectern-radius-1); color: var(--lectern-ink-muted); cursor: pointer; font: inherit;",
  "  padding: var(--lectern-space-1) var(--lectern-space-2); }",
  ".lectern-library__field { display: flex; flex-direction: column; gap: var(--lectern-space-1);",
  "  margin-block-end: var(--lectern-space-3); }",
  ".lectern-library__field label { color: var(--lectern-ink-muted); font-size: 0.875rem; }",
  ".lectern-library__field input, .lectern-library__field select { background: var(--lectern-paper);",
  "  border: 1px solid var(--lectern-line); border-radius: var(--lectern-radius-2); color: var(--lectern-ink);",
  "  font: inherit; padding: var(--lectern-space-2); }",
  ".lectern-library__controls { display: flex; flex-wrap: wrap; gap: var(--lectern-space-4); }",
  ".lectern-library__new-folder button { background: var(--lectern-accent); border: 1px solid var(--lectern-accent);",
  "  border-radius: var(--lectern-radius-2); color: var(--lectern-accent-ink); cursor: pointer; font: inherit;",
  "  padding: var(--lectern-space-2) var(--lectern-space-3); }",
  ".lectern-library__hint, .lectern-library__empty { color: var(--lectern-ink-muted); }",
  ".lectern-library__documents { display: flex; flex-direction: column; gap: var(--lectern-space-2);",
  "  list-style: none; margin: 0; padding: 0; }",
  ".lectern-library__document { align-items: start; border: 1px solid var(--lectern-line);",
  "  border-radius: var(--lectern-radius-2); display: flex; flex-wrap: wrap; gap: var(--lectern-space-2);",
  "  justify-content: space-between; padding: var(--lectern-space-3); }",
  ".lectern-library__document-title { color: var(--lectern-ink); font-weight: 600; }",
  ".lectern-library__document-meta { color: var(--lectern-ink-muted); display: flex; flex-wrap: wrap;",
  "  font-size: 0.875rem; gap: var(--lectern-space-3); margin: var(--lectern-space-1) 0 0; }",
  ".lectern-library__document-actions { align-items: center; display: flex; gap: var(--lectern-space-2); }",
  ".lectern-library__document-actions select { background: var(--lectern-paper); border: 1px solid var(--lectern-line);",
  "  border-radius: var(--lectern-radius-1); color: var(--lectern-ink); font: inherit; padding: var(--lectern-space-1); }",
  ".lectern-library__document-actions button { background: transparent; border: 1px solid var(--lectern-line);",
  "  border-radius: var(--lectern-radius-1); color: var(--lectern-ink); cursor: pointer; font: inherit;",
  "  padding: var(--lectern-space-1) var(--lectern-space-2); }",
].join("\n");

/** The records the screen draws: every live document, every live folder, and how far each document is read. */
interface LibrarySnapshot {
  documents: DocumentMeta[];
  folders: Folder[];
  progress: Readonly<Record<string, number>>;
}

/** The empty library a screen starts on, before the first read of the store answers. */
const EMPTY: LibrarySnapshot = { documents: [], folders: [], progress: {} };

/** What the document list is filtered by: everything, or one folder — `null` being the unfiled documents. */
type FolderFilter = { kind: "all" } | { kind: "folder"; id: string | null };

/** One folder the tree is drawn as, with how deep it sits. */
interface FolderRow {
  folder: Folder;
  depth: number;
}

/**
 * Read the whole library: the live documents, the live folders, and each document's progress as the fraction
 * a row shows (F§5.6(f), worked out from the counts the metadata carries — see `documentProgress`).
 */
async function readLibrary(): Promise<LibrarySnapshot> {
  const { store } = await getStorage();
  const [documents, folders] = await Promise.all([store.listDocuments(), store.listFolders()]);
  const entries = await Promise.all(
    documents.map(async (document): Promise<[string, number]> => {
      const progress = await store.getProgress(document.docId);
      return [document.docId, documentProgress(document, progress)];
    }),
  );
  return { documents, folders, progress: Object.fromEntries(entries) };
}

/** A tree flattened into the rows it is drawn as, parents before their children. */
function flattenFolderTree(nodes: readonly FolderNode[], depth = 0): FolderRow[] {
  return nodes.flatMap((node) => [{ folder: node.folder, depth }, ...flattenFolderTree(node.children, depth + 1)]);
}

/** Whether a `<select>`'s value is one of the orders the list offers. */
function isSortOrder(value: string): value is DocumentSortOrder {
  return (SORT_ORDERS as readonly string[]).includes(value);
}

/** A fraction as the percentage a row shows. */
function asPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** A document's addition date as the day it was added. */
function asDate(addedAt: number): string {
  return new Date(addedAt).toLocaleDateString();
}

/** The calendar value of a date, which is what a `<time>` element carries beside its text. */
function asInstant(addedAt: number): string {
  return new Date(addedAt).toISOString();
}

export function LibraryPage(): ReactElement {
  const [snapshot, setSnapshot] = useState<LibrarySnapshot>(EMPTY);
  const [problem, setProblem] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [order, setOrder] = useState<DocumentSortOrder>("addedAt");
  const [filter, setFilter] = useState<FolderFilter>({ kind: "all" });
  const [newFolderName, setNewFolderName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmingFolder, setConfirmingFolder] = useState<string | null>(null);
  const [confirmingDocument, setConfirmingDocument] = useState<string | null>(null);

  useEffect(() => {
    if (document.getElementById(STYLE_ID) !== null) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = RULES;
    document.head.append(style);
  }, []);

  // The library is read once when the screen appears. Every later read is an action's own, because a record
  // the screen holds is only ever as old as the last write it made.
  useEffect(() => {
    let live = true;
    void readLibrary()
      .then((read) => {
        if (live) setSnapshot(read);
      })
      .catch((cause: unknown) => {
        if (live) setProblem(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      live = false;
    };
  }, []);

  const refresh = async (): Promise<void> => setSnapshot(await readLibrary());

  /** Run a store action, and read the library back so the screen shows what was written. */
  const act = async (work: (storage: Storage) => Promise<void>): Promise<void> => {
    try {
      await work(await getStorage());
      setProblem(null);
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause));
    }
    await refresh();
  };

  /** The folder a new folder is created inside: the selected one, or the root. */
  const parentFolderId = (): string | null => (filter.kind === "folder" ? filter.id : null);

  const createFolder = (): Promise<void> =>
    act(async ({ store }) => {
      const name = newFolderName.trim();
      if (name === "") return;
      await store.putFolder({ id: crypto.randomUUID(), name, parentId: parentFolderId(), updatedAt: Date.now(), deleted: false });
      setNewFolderName("");
    });

  const renameFolder = (folder: Folder, name: string): Promise<void> =>
    act(async ({ store }) => {
      const trimmed = name.trim();
      if (trimmed === "") return;
      await store.putFolder({ ...folder, name: trimmed });
      setRenamingId(null);
    });

  /**
   * File a document in another folder. A move is an ordinary write (F§5.9): the record is stamped again and
   * an op carries it to the reader's other devices, which is why the document's model travels with the write
   * rather than the folder being patched in place.
   */
  const moveDocument = (document: DocumentMeta, folderId: string | null): Promise<void> =>
    act(async ({ store }) => {
      const model = await store.getDocumentModel(document.docId);
      if (model === null) return;
      await store.putDocument({ ...document, folderId }, model);
    });

  /**
   * Delete a document: F§5.9's tombstone through the store, and with it the two blobs that belong to the
   * document alone — its original bytes and its anchors, which are keyed by `docId` and mean nothing once the
   * document is gone. The model goes with the tombstone, which is the store's own business.
   */
  const removeDocument = (document: DocumentMeta): Promise<void> =>
    act(async ({ store, cache }) => {
      await store.deleteDocument(document.docId);
      await cache.delete(originalKey(document.docId));
      await cache.delete(anchorsKey(document.docId));
      setConfirmingDocument(null);
    });

  /** Delete a folder, moving what was filed in it up to its parent. */
  const removeFolder = (folder: Folder): Promise<void> =>
    act(async ({ store }) => {
      for (const child of snapshot.folders) {
        if (child.parentId === folder.id) await store.putFolder({ ...child, parentId: folder.parentId });
      }
      for (const document of snapshot.documents) {
        if (document.folderId !== folder.id) continue;
        const model = await store.getDocumentModel(document.docId);
        if (model !== null) await store.putDocument({ ...document, folderId: folder.parentId }, model);
      }
      await store.deleteFolder(folder.id);
      setConfirmingFolder(null);
      if (filter.kind === "folder" && filter.id === folder.id) setFilter({ kind: "all" });
    });

  /** What the list is filtered by right now, in F§5.9's own query shape. */
  const activeQuery = (): DocumentFilter => {
    const query: DocumentFilter = {};
    if (filter.kind === "folder") query.folderId = filter.id;
    if (search.trim() !== "") query.text = search;
    return query;
  };

  const folderRows = flattenFolderTree(buildFolderTree(snapshot.folders));
  const listed = sortDocuments(filterDocuments(snapshot.documents, activeQuery()), order, snapshot.progress);
  const unfiledSelected = filter.kind === "folder" && filter.id === null;

  return (
    <main className="lectern-library">
      <h1>Library</h1>
      {problem === null ? null : (
        <p className="lectern-library__empty" role="status" data-status="error">
          {problem}
        </p>
      )}

      <div className="lectern-library__columns">
        <section className="lectern-library__panel" aria-labelledby="lectern-folders-heading">
          <h2 id="lectern-folders-heading">Folders</h2>
          <ul className="lectern-library__tree">
            <li className="lectern-library__folder-row">
              <button
                type="button"
                className="lectern-library__folder-name"
                aria-pressed={filter.kind === "all"}
                onClick={() => setFilter({ kind: "all" })}
              >
                All documents
              </button>
            </li>
            <li className="lectern-library__folder-row">
              <button
                type="button"
                className="lectern-library__folder-name"
                aria-pressed={unfiledSelected}
                onClick={() => setFilter({ kind: "folder", id: null })}
              >
                No folder
              </button>
            </li>
            {folderRows.map((row) => (
              <li
                key={row.folder.id}
                className="lectern-library__folder-row"
                data-folder-id={row.folder.id}
                data-depth={row.depth}
                style={{ paddingInlineStart: `calc(${INDENT} * ${row.depth})` }}
              >
                <button
                  type="button"
                  className="lectern-library__folder-name"
                  aria-pressed={filter.kind === "folder" && filter.id === row.folder.id}
                  onClick={() => setFilter({ kind: "folder", id: row.folder.id })}
                >
                  {row.folder.name}
                </button>
                {renamingId === row.folder.id ? (
                  <>
                    <input
                      aria-label={`New name for ${row.folder.name}`}
                      value={renameDraft}
                      onChange={(event) => setRenameDraft(event.target.value)}
                    />
                    <button
                      type="button"
                      aria-label={`Save name for ${row.folder.name}`}
                      onClick={() => void renameFolder(row.folder, renameDraft)}
                    >
                      Save
                    </button>
                    <button type="button" onClick={() => setRenamingId(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      aria-label={`Rename ${row.folder.name}`}
                      onClick={() => {
                        setRenamingId(row.folder.id);
                        setRenameDraft(row.folder.name);
                      }}
                    >
                      Rename
                    </button>
                    {confirmingFolder === row.folder.id ? (
                      <>
                        <button
                          type="button"
                          aria-label={`Confirm delete ${row.folder.name}`}
                          onClick={() => void removeFolder(row.folder)}
                        >
                          Delete folder
                        </button>
                        <button type="button" onClick={() => setConfirmingFolder(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button type="button" aria-label={`Delete ${row.folder.name}`} onClick={() => setConfirmingFolder(row.folder.id)}>
                        Delete
                      </button>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>

          <form
            className="lectern-library__new-folder"
            onSubmit={(event) => {
              event.preventDefault();
              void createFolder();
            }}
          >
            <div className="lectern-library__field">
              <label htmlFor={NEW_FOLDER_ID}>New folder</label>
              <input
                id={NEW_FOLDER_ID}
                name="folder"
                type="text"
                autoComplete="off"
                value={newFolderName}
                onChange={(event) => setNewFolderName(event.target.value)}
              />
            </div>
            <button type="submit">Create folder</button>
          </form>
          <p className="lectern-library__hint">A folder is created inside the folder you have selected.</p>
        </section>

        <section className="lectern-library__panel" aria-labelledby="lectern-documents-heading">
          <h2 id="lectern-documents-heading">Documents</h2>
          <div className="lectern-library__controls">
            <div className="lectern-library__field">
              <label htmlFor={SEARCH_ID}>Search</label>
              <input
                id={SEARCH_ID}
                name="search"
                type="search"
                autoComplete="off"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <div className="lectern-library__field">
              <label htmlFor={SORT_ID}>Sort</label>
              <select
                id={SORT_ID}
                name="sort"
                value={order}
                onChange={(event) => {
                  const chosen = event.target.value;
                  if (isSortOrder(chosen)) setOrder(chosen);
                }}
              >
                {SORT_ORDERS.map((value) => (
                  <option key={value} value={value}>
                    {ORDER_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {snapshot.documents.length === 0 ? (
            <p className="lectern-library__empty" role="status">
              No documents yet — <a href="#/import">import one</a> and it will appear here.
            </p>
          ) : listed.length === 0 ? (
            <p className="lectern-library__empty" role="status">
              Nothing here matches this search and folder.
            </p>
          ) : (
            <ul className="lectern-library__documents">
              {listed.map((document) => (
                <li key={document.docId} className="lectern-library__document" data-doc-id={document.docId}>
                  <div className="lectern-library__document-main">
                    <a className="lectern-library__document-title" href={`#/read/${encodeURIComponent(document.docId)}`}>
                      {document.title}
                    </a>
                    <p className="lectern-library__document-meta">
                      <span>{asPercent(snapshot.progress[document.docId] ?? 0)} read</span>
                      <time dateTime={asInstant(document.addedAt)}>Added {asDate(document.addedAt)}</time>
                      <span>{`${document.wordCount} words`}</span>
                      <span>{`${document.sentenceCount} sentences`}</span>
                      <span>{document.sourceKind}</span>
                    </p>
                  </div>
                  <div className="lectern-library__document-actions">
                    <select
                      aria-label={`Move ${document.title}`}
                      value={document.folderId ?? ""}
                      onChange={(event) => void moveDocument(document, event.target.value === "" ? null : event.target.value)}
                    >
                      <option value="">No folder</option>
                      {folderRows.map((row) => (
                        <option key={row.folder.id} value={row.folder.id}>
                          {row.folder.name}
                        </option>
                      ))}
                    </select>
                    {confirmingDocument === document.docId ? (
                      <>
                        <button type="button" aria-label={`Confirm delete ${document.title}`} onClick={() => void removeDocument(document)}>
                          Delete
                        </button>
                        <button type="button" onClick={() => setConfirmingDocument(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button type="button" aria-label={`Delete ${document.title}`} onClick={() => setConfirmingDocument(document.docId)}>
                        Delete
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
