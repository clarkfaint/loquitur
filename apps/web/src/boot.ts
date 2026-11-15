/**
 * The app's start-up features (F§10.1), as the registry AGENTS.md §5 describes.
 *
 * A later unit that has something to start once — the sync engine, the desktop shell's bridge, the offline
 * precache — adds one entry here, and `main.tsx` runs the list once, in order, after the settings are loaded
 * and before the shell mounts. Empty in this unit: the shell and the settings screen need no start-up work.
 */

import { desktopIntegration } from "./desktop/desktop-integration";
import type { Services } from "./services";

/** One start-up feature: given the app's services, it may do nothing or return a promise that resolves. */
export type BootFeature = (services: Services) => void | Promise<void>;

/** Every registered feature, in the order they run. The desktop shell's hand-offs are the first: a shell that
 * is present can ask for a document to be read before the reader has touched anything. */
export const bootFeatures: BootFeature[] = [desktopIntegration];
