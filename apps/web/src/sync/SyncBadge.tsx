/**
 * The sync badge (F§10.1): what this page is doing with the hub, in one small mark in the navigation bar.
 *
 * It is a view of the service's own state and nothing more. Four labels, because F§8.2's failures are two
 * facts a reader acts on differently — a hub nobody can reach is not the same as a hub that refused — and
 * the last clean round's time is the title, which is the one thing a person wants when they wonder whether
 * what they wrote actually left this device.
 *
 * With no hub configured, or with sync switched off on this device, there is nothing to report and the
 * badge renders nothing at all: a mark that said "synced" for a page that is not syncing would be a lie, and
 * the settings section is where the switch lives.
 *
 * Its own rules are injected as a `<style>` element rather than added to `app.css`, whose owning unit is
 * frozen; they are written in the design tokens `@lectern/ui-web/styles.css` declares, so the badge follows
 * the reader's theme like every other part of the shell.
 */

import type { SyncStatus } from "@lectern/api-client";
import { type ReactElement, useEffect, useState } from "react";
import { type SyncView, syncService } from "./sync-service";

/** What the badge says: F§8.2's two failures told apart, and the two states that are not failures. */
type BadgeState = "synced" | "syncing" | "offline" | "error";

/** The words each state is shown as. */
const LABELS: Readonly<Record<BadgeState, string>> = {
  synced: "Synced",
  syncing: "Syncing",
  offline: "Offline",
  error: "Sync failed",
};

/** The id of the `<style>` element this component's rules live in. */
const STYLE_ID = "lectern-sync-badge-styles";

/** The badge's layout, in the tokens the stylesheet declares. */
const RULES = [
  ".lectern-sync-badge { border: 1px solid var(--lectern-line); border-radius: var(--lectern-radius-1);",
  "  color: var(--lectern-ink-muted); font-size: 0.8125rem; margin-inline-start: auto;",
  "  padding: var(--lectern-space-1) var(--lectern-space-2); white-space: nowrap; }",
  '.lectern-sync-badge[data-sync-badge="synced"] { color: var(--lectern-accent); }',
  '.lectern-sync-badge[data-sync-badge="offline"], .lectern-sync-badge[data-sync-badge="error"] {',
  "  color: var(--lectern-danger); }",
].join("\n");

/**
 * Which of the four states an engine status is. An engine that has not finished a round yet reads as
 * `syncing` rather than as an error: it is doing exactly what it was just asked to do.
 */
function stateOf(status: SyncStatus): BadgeState {
  if (status.state === "syncing") return "syncing";
  if (status.state === "offline") return "offline";
  if (status.state === "error") return "error";
  return status.lastSyncedAt === null ? "syncing" : "synced";
}

/** The badge's title: when the last round that reached the hub finished, in the reader's own clock. */
function titleOf(status: SyncStatus): string {
  if (status.lastSyncedAt === null) return "Nothing has been synced yet.";
  return `Last synced ${new Date(status.lastSyncedAt).toLocaleTimeString()}`;
}

export function SyncBadge(): ReactElement | null {
  const [view, setView] = useState<SyncView>(() => syncService.view());

  useEffect(() => {
    if (document.getElementById(STYLE_ID) === null) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = RULES;
      document.head.append(style);
    }
    return syncService.subscribe(setView);
  }, []);

  if (!view.running) return null;
  const state = stateOf(view.status);

  return (
    <span className="lectern-sync-badge" data-sync-badge={state} role="status" title={titleOf(view.status)}>
      {LABELS[state]}
    </span>
  );
}
