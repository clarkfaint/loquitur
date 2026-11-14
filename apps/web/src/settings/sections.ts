/**
 * The settings screen's sections (F§10.1), as the registry AGENTS.md §5 describes.
 *
 * The connection form and the playback preferences are the screen's own; everything else a unit wants to let
 * the reader configure — the offline cache, the desktop hotkeys — is registered here as one section, so the
 * page renders what exists without knowing what it is. Empty in this unit.
 */

import type { ComponentType } from "react";

/** One registered section: an id for its key and DOM anchor, a title, and the component to render. */
export interface SettingsSection {
  id: string;
  title: string;
  component: ComponentType;
}

/** Every registered section, in the order the settings page lists them. */
export const sections: SettingsSection[] = [];
