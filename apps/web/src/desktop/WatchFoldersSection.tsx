/**
 * The watched folders' settings section (F§10.1, F§10.3): every folder the shell is reading on its own, what it
 * reports about it, the button that adds one, and the button that stops watching one.
 *
 * The section exists only inside the shell. F§10.1's settings screen is shared with the browser, where there is
 * no bridge and therefore no folder watcher at all, so the whole section renders nothing rather than a list
 * whose buttons would go nowhere.
 *
 * Three decisions are the section's own.
 *
 * - **What is listed is what the shell is watching, not what the record says.** F§10.3's `DesktopStatus` is the
 *   shell's account of its own watchers, folder by folder, with the reason when one could not be held; the
 *   record is only what the operator asked for. The two differ by exactly one folder — the shell's own inbox,
 *   which nobody added and which cannot be removed — so the list is drawn from the status and the *removal* is
 *   offered only for the folders that came from the record.
 * - **Subscribing comes before reading.** F§10.3's `onStatus` is a one-way push, so a page that mounts after the
 *   shell's last publish would otherwise wait for the next change to hear anything; the shell re-announces its
 *   status as part of answering the read (the takeover U-040's feature makes), which is what the ordering here
 *   is for.
 * - **A folder is added by the picker and written as a change.** F§10.3's bridge hands over a path — or `null`
 *   when the operator cancels — and the section writes what came back into the record, where the shell's own
 *   watcher picks it up. Nothing is watched that the operator did not choose, and nothing is written for a
 *   cancelled picker.
 */

import { type DesktopSettings, type DesktopStatus, getDesktopBridge } from "@lectern/ui-web";
import { type ReactElement, useEffect, useState } from "react";

/** One folder as the shell reports it (F§10.3). */
type WatchedFolder = DesktopStatus["watchers"][number];

/** The words for what the shell says about a folder. */
function describeState(folder: WatchedFolder | undefined): string {
  if (folder === undefined) return "Not watched yet";
  if (folder.ok) return "Watching";
  return `Could not be watched: ${folder.error ?? "the shell did not say why"}`;
}

/** The words for a failure. */
function describeFailure(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function WatchFoldersSection(): ReactElement | null {
  const [bridge] = useState(() => getDesktopBridge());
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (bridge === null) return;
    const stop = bridge.settings.onStatus(setStatus);
    let live = true;
    void bridge.settings
      .get()
      .then((record) => {
        if (live) setSettings(record);
      })
      .catch((cause: unknown) => {
        if (live) setProblem(describeFailure(cause));
      });
    return () => {
      live = false;
      stop();
    };
  }, [bridge]);

  if (bridge === null) return null;

  const watched = status?.watchers ?? [];
  const chosen = settings?.watchFolders ?? [];

  /** Add one folder: ask the operator for a path, then write it into the record the watcher reads. */
  const add = (): void => {
    setProblem(null);
    void bridge.settings
      .pickFolder()
      .then(async (picked) => {
        // A cancelled picker is an answer, not a failure: there is nothing to watch and nothing to write.
        if (picked === null) return;
        const held = (await bridge.settings.get()).watchFolders;
        if (held.includes(picked)) return;
        setSettings(await bridge.settings.set({ watchFolders: [...held, picked] }));
      })
      .catch((cause: unknown) => {
        setProblem(describeFailure(cause));
      });
  };

  /** Stop watching one folder: the record loses it, and the shell's watcher is told by the change. */
  const remove = (folder: string): void => {
    setProblem(null);
    void bridge.settings
      .set({ watchFolders: chosen.filter((held) => held !== folder) })
      .then(setSettings)
      .catch((cause: unknown) => {
        setProblem(describeFailure(cause));
      });
  };

  return (
    <div className="lectern-watch-folders" data-watch-folders-section>
      {watched.length === 0 ? (
        <p className="lectern-settings__status">No folder is being read yet.</p>
      ) : (
        <ul className="lectern-watch-folders__list">
          {watched.map((folder) => (
            <li
              className="lectern-watch-folders__row"
              data-state={folder.ok ? "watching" : "failed"}
              data-watch-folder={folder.folder}
              key={folder.folder}
            >
              <span className="lectern-watch-folders__path">{folder.folder}</span>
              <span className="lectern-watch-folders__state">{describeState(folder)}</span>
              {chosen.includes(folder.folder) ? (
                <button onClick={() => remove(folder.folder)} type="button">
                  Stop watching
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <div className="lectern-settings__actions">
        <button onClick={add} type="button">
          Add folder
        </button>
      </div>

      {problem === null ? null : (
        <p className="lectern-settings__status lectern-watch-folders__problem" data-watch-problem data-status="error" role="status">
          {problem}
        </p>
      )}
    </div>
  );
}
