/**
 * The bookmarks panel (F§10.1, F§5.9): the places a reader marked in the document they are reading.
 *
 * A bookmark is one `bookmark` record, so the panel is a view of the store and nothing more — every action is
 * a write through the frozen `LibraryStore`, and each one reads the records back rather than holding a second
 * copy of the list that a later write could contradict. Adding marks the word being read right now, which is
 * what the caller hands in as `position`; jumping asks the reader to seek there; deleting writes F§5.9's
 * tombstone, so a bookmark removed on one device is removed on the reader's others too.
 */

import type { Bookmark } from "@lectern/core";
import { type FormEvent, type ReactElement, useCallback, useEffect, useState } from "react";
import { getStorage } from "../services";

/** A place in the document, in the shape the reader and F§5.9's records both use. */
export interface BookmarkPosition {
  sentenceIndex: number;
  wordIndex: number;
}

export interface BookmarksPanelProps {
  /** The document these bookmarks belong to. */
  docId: string;
  /** Where a bookmark is added: the word being read right now (F§5.6(d)). */
  position: BookmarkPosition;
  /** Where a jump goes. */
  onJump: (position: BookmarkPosition) => void;
  /** Close the panel. */
  onClose: () => void;
}

/** The id the note field's label points at. */
const NOTE_ID = "lectern-bookmark-note";

/** A place in the document, written the way a reader counts: from one. */
function describePosition(position: BookmarkPosition): string {
  return `Sentence ${position.sentenceIndex + 1}, word ${position.wordIndex + 1}`;
}

export function BookmarksPanel({ docId, position, onJump, onClose }: BookmarksPanelProps): ReactElement {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  /** Read the document's bookmarks again, so the list always shows what was last written. */
  const refresh = useCallback(async (): Promise<void> => {
    const { store } = await getStorage();
    setBookmarks(await store.listBookmarks(docId));
  }, [docId]);

  useEffect(() => {
    let live = true;
    void refresh()
      .then(() => {
        if (live) setProblem(null);
      })
      .catch((cause: unknown) => {
        if (live) setProblem(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      live = false;
    };
  }, [refresh]);

  /** Run a store action, report a failure instead of losing it, and read the list back. */
  const act = async (work: () => Promise<void>): Promise<void> => {
    try {
      await work();
      setProblem(null);
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause));
    }
    await refresh();
  };

  const add = (): Promise<void> =>
    act(async () => {
      const { store } = await getStorage();
      const now = Date.now();
      await store.putBookmark({
        id: crypto.randomUUID(),
        docId,
        sentenceIndex: position.sentenceIndex,
        wordIndex: position.wordIndex,
        note: note.trim(),
        createdAt: now,
        updatedAt: now,
        deleted: false,
      });
      setNote("");
    });

  const remove = (id: string): Promise<void> =>
    act(async () => {
      const { store } = await getStorage();
      await store.deleteBookmark(id);
    });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void add();
  };

  return (
    <aside aria-label="Bookmarks" className="lectern-bookmarks">
      <div className="lectern-bookmarks__head">
        <h2>Bookmarks</h2>
        <button className="lectern-bookmarks__close" onClick={onClose} type="button">
          Close
        </button>
      </div>

      <form className="lectern-bookmarks__form" onSubmit={onSubmit}>
        <label htmlFor={NOTE_ID}>Note</label>
        <input autoComplete="off" id={NOTE_ID} name="note" onChange={(event) => setNote(event.target.value)} type="text" value={note} />
        <button type="submit">Add bookmark</button>
      </form>
      <p className="lectern-bookmarks__hint">{`Adding marks ${describePosition(position)}.`}</p>

      {problem === null ? null : (
        <p className="lectern-bookmarks__problem" role="alert">
          {problem}
        </p>
      )}

      {bookmarks.length === 0 ? (
        <p className="lectern-bookmarks__empty" role="status">
          No bookmarks in this document yet.
        </p>
      ) : (
        <ol className="lectern-bookmarks__list">
          {bookmarks.map((bookmark, index) => (
            <li className="lectern-bookmarks__item" data-bookmark-id={bookmark.id} key={bookmark.id}>
              <p className="lectern-bookmarks__note">{bookmark.note === "" ? `Bookmark ${index + 1}` : bookmark.note}</p>
              <p className="lectern-bookmarks__where">{describePosition(bookmark)}</p>
              <div className="lectern-bookmarks__actions">
                <button onClick={() => onJump({ sentenceIndex: bookmark.sentenceIndex, wordIndex: bookmark.wordIndex })} type="button">
                  {`Jump to bookmark ${index + 1}`}
                </button>
                <button onClick={() => void remove(bookmark.id)} type="button">
                  {`Delete bookmark ${index + 1}`}
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
