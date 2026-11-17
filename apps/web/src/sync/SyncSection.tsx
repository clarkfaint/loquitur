/**
 * Sync's settings section (F§10.1, F§8): the switch that decides whether this device talks to the hub at all,
 * what the engine is doing, how much is still waiting to leave, and the one button a reader needs when they
 * have just come back to a machine that was asleep.
 *
 * It reads the service and never the hub: every figure below is the engine's own `SyncStatus`, refreshed
 * through the service's subscription, so the section cannot show a state the sync code does not believe.
 * Flipping the switch really starts or stops the engine — a device with sync off makes no round, opens no
 * socket, and is exactly the page it would be with no hub configured.
 *
 * Its own rules are injected as a `<style>` element rather than added to `app.css`, whose owning unit is
 * frozen; they are written in the design tokens `@lectern/ui-web/styles.css` declares.
 */

import { type ReactElement, useEffect, useState } from "react";
import { type SyncView, syncService } from "./sync-service";

/** What the section says about the engine, in the same four words the badge uses. */
const STATE_WORDS: Readonly<Record<string, string>> = {
  idle: "Up to date",
  syncing: "Syncing now",
  offline: "The hub cannot be reached",
  error: "The hub refused the last round",
};

/** The id of the `<style>` element this section's rules live in. */
const STYLE_ID = "lectern-sync-section-styles";

/** The section's layout, in the tokens the stylesheet declares. */
const RULES = [
  ".lectern-sync-section { display: flex; flex-direction: column; gap: var(--lectern-space-2); }",
  ".lectern-sync-section__check { align-items: center; display: flex; gap: var(--lectern-space-2); }",
  ".lectern-sync-section__state, .lectern-sync-section__figures { color: var(--lectern-ink-muted); margin: 0; }",
  ".lectern-sync-section__figures { display: flex; flex-wrap: wrap; font-size: 0.875rem;",
  "  gap: var(--lectern-space-3); }",
  ".lectern-sync-section__actions button { background: transparent; border: 1px solid var(--lectern-line);",
  "  border-radius: var(--lectern-radius-2); color: var(--lectern-ink); cursor: pointer; font: inherit;",
  "  padding: var(--lectern-space-2) var(--lectern-space-3); }",
  ".lectern-sync-section__actions button:disabled { cursor: default; opacity: 0.6; }",
  ".lectern-sync-section__switch-id { color: var(--lectern-ink-muted); font-size: 0.875rem; }",
].join("\n");

/** The one instant a reader is shown, or the words for never. */
function lastSynced(lastSyncedAt: number | null): string {
  if (lastSyncedAt === null) return "never";
  return new Date(lastSyncedAt).toLocaleString();
}

export function SyncSection(): ReactElement {
  const [view, setView] = useState<SyncView>(() => syncService.view());
  const [on, setOn] = useState(() => syncService.enabled());
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (document.getElementById(STYLE_ID) === null) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = RULES;
      document.head.append(style);
    }
    return syncService.subscribe(setView);
  }, []);

  const flip = (enabled: boolean): void => {
    setOn(enabled);
    void syncService.setEnabled(enabled);
  };

  const syncNow = async (): Promise<void> => {
    setAsking(true);
    try {
      await syncService.syncNow();
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="lectern-sync-section">
      <div className="lectern-sync-section__check">
        <input checked={on} id="lectern-sync-enabled" name="syncEnabled" onChange={(event) => flip(event.target.checked)} type="checkbox" />
        <label htmlFor="lectern-sync-enabled">Sync this device with the hub</label>
      </div>

      <p
        className="lectern-sync-section__state"
        data-sync-last={view.status.lastSyncedAt === null ? "" : String(view.status.lastSyncedAt)}
        data-sync-pending={view.status.pending}
        data-sync-running={view.running}
        data-sync-state={on ? view.status.state : "off"}
        role="status"
      >
        {on ? (STATE_WORDS[view.status.state] ?? view.status.state) : "Sync is off on this device."}
      </p>

      <p className="lectern-sync-section__figures">
        <span>{`${view.status.pending} change${view.status.pending === 1 ? "" : "s"} waiting`}</span>
        <span>{`Last synced: ${lastSynced(view.status.lastSyncedAt)}`}</span>
      </p>

      <div className="lectern-sync-section__actions">
        <button disabled={!view.running || asking} onClick={() => void syncNow()} type="button">
          Sync now
        </button>
      </div>

      <p className="lectern-sync-section__switch-id">
        Everything the library holds — documents, folders, bookmarks and progress — travels to the reader's other devices; a document's
        audio does not.
      </p>
    </div>
  );
}
