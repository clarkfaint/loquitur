/**
 * One document's offline control (F§10.1): download it, watch it happen, and take it away again.
 *
 * The control owns no state of its own beyond what it is doing this moment. Whether a document has a pack
 * is F§5.9's record, so the button asks the store when the row appears and again after every action, which
 * is what makes a second tab, a reload or another device show the same thing.
 *
 * Four states are drawn, and one of them is not the record's: while a download is running the button leaves
 * the row to a percentage, because "pinned" is only true once the last sentence is cached. A pinned document
 * whose audio is not all there — a download the reader stopped, or a pack the reader unpinned and then
 * refilled — offers to finish rather than pretending to be done.
 */

import { type ReactElement, useEffect, useState } from "react";
import { downloadForOffline, type OfflineProgress, type OfflineState, offlineState, removeOffline } from "./offline-service";

/** What one row's offline control is told about the document it belongs to. */
export interface OfflineButtonProps {
  docId: string;
  title: string;
}

/** How far a download has got, as the row shows it. */
function asPercent(progress: OfflineProgress): string {
  return progress.total === 0 ? "Starting…" : `${Math.round((progress.done / progress.total) * 100)}%`;
}

/** The words for a failure, which is the hub's own when it answered with one. */
function describeFailure(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function OfflineButton({ docId, title }: OfflineButtonProps): ReactElement {
  const [state, setState] = useState<OfflineState>("none");
  const [progress, setProgress] = useState<OfflineProgress | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // The state is a record, not a memory: it is read when the row appears, so a document downloaded in another
  // tab or before this one was opened reads as downloaded here too.
  useEffect(() => {
    let live = true;
    void offlineState(docId)
      .then((read) => {
        if (live) setState(read);
      })
      .catch((cause: unknown) => {
        if (live) setProblem(describeFailure(cause));
      });
    return () => {
      live = false;
    };
  }, [docId]);

  const download = async (): Promise<void> => {
    setProblem(null);
    setProgress({ done: 0, total: 0 });
    try {
      await downloadForOffline(docId, (next) => setProgress(next));
      setState(await offlineState(docId));
    } catch (cause) {
      setProblem(describeFailure(cause));
    } finally {
      setProgress(null);
    }
  };

  const remove = async (): Promise<void> => {
    setProblem(null);
    try {
      await removeOffline(docId);
      setState(await offlineState(docId));
    } catch (cause) {
      setProblem(describeFailure(cause));
    }
  };

  const running = progress !== null;

  return (
    <div className="lectern-offline" data-offline={running ? "downloading" : state}>
      {progress === null ? null : (
        <p className="lectern-offline__progress" role="status">
          {asPercent(progress)}
        </p>
      )}
      {problem === null ? null : (
        <p className="lectern-offline__problem" role="status">
          {problem}
        </p>
      )}
      {running || state === "complete" ? null : (
        <button
          type="button"
          aria-label={state === "none" ? `Download ${title} for offline` : `Finish downloading ${title}`}
          onClick={() => void download()}
        >
          {state === "none" ? "Offline" : "Finish"}
        </button>
      )}
      {running || state === "none" ? null : (
        <button type="button" aria-label={`Remove the offline copy of ${title}`} onClick={() => void remove()}>
          Remove
        </button>
      )}
    </div>
  );
}
