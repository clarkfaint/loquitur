/**
 * The offline cache's settings section (F§10.1, F§5.9): what the cache is holding, what it may hold, and the
 * one action a reader needs when they are short of room.
 *
 * The section owns no audio. Everything it shows is read from F§5.9's `BlobCache` when the screen appears and
 * again after the action, and the action is the service's own `enforceCacheLimit` pointed at zero — the same
 * eviction the limit uses, with nothing left to keep. Pinned documents survive it by definition: that is what
 * pinning means, and it is why the button says "unpinned".
 *
 * The limit itself is the reader's preference, edited on the Playback section where the rest of the playback
 * settings live; this section states it rather than offering a second field that would write the same key.
 */

import { type ReactElement, useEffect, useState } from "react";
import { getStorage } from "../services";
import { useSettingsStore } from "../settings/settings";
import { enforceCacheLimit } from "./offline-service";

/** The unit the sizes are shown in. */
const BYTES_PER_MB = 1024 * 1024;

/** A byte count as whole megabytes. */
function inMegabytes(bytes: number): string {
  return `${Math.round(bytes / BYTES_PER_MB)} MB`;
}

/** The words for a failure. */
function describeFailure(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The bytes the cache holds right now (F§5.9). */
async function cacheSizeBytes(): Promise<number> {
  const { cache } = await getStorage();
  return await cache.sizeBytes();
}

export function OfflineSection(): ReactElement {
  const limit = useSettingsStore((state) => state.preferences.cacheLimitBytes);
  const [size, setSize] = useState<number | null>(null);
  const [freed, setFreed] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void cacheSizeBytes()
      .then((bytes) => {
        if (live) setSize(bytes);
      })
      .catch((cause: unknown) => {
        if (live) setProblem(describeFailure(cause));
      });
    return () => {
      live = false;
    };
  }, []);

  const clear = async (): Promise<void> => {
    setProblem(null);
    try {
      setFreed(await enforceCacheLimit(0));
      setSize(await cacheSizeBytes());
    } catch (cause) {
      setProblem(describeFailure(cause));
    }
  };

  return (
    <div className="lectern-offline-section">
      <p className="lectern-offline-section__size" role="status" data-cache-size={size === null ? "unknown" : String(size)}>
        {size === null ? "Measuring the audio cache…" : `Audio cache: ${inMegabytes(size)} of ${inMegabytes(limit)} in use.`}
      </p>
      <button type="button" onClick={() => void clear()}>
        Clear unpinned audio
      </button>
      {freed === null ? null : (
        <p className="lectern-offline-section__freed" role="status">
          {freed === 0 ? "Nothing was unpinned." : `Freed ${inMegabytes(freed)}.`}
        </p>
      )}
      {problem === null ? null : (
        <p className="lectern-offline-section__problem" role="status">
          {problem}
        </p>
      )}
      <p className="lectern-offline-section__hint">Documents you downloaded for offline reading are kept.</p>
    </div>
  );
}
