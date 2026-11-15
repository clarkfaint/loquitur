/**
 * The shell's features (F§10.3), as the registry AGENTS.md §5 describes.
 *
 * A feature is given the main process's context and registers what it owns: the global shortcuts and the tray
 * (U-039), the selection provider and the screen-region reader, the folder watcher. `index.ts` runs the whole
 * list once, after the app is ready and the main window exists, and a later unit adds its own feature here
 * without any other file changing.
 *
 * The list is empty in this unit, and deliberately: everything this unit owes — the window, the bridge, the
 * settings record and the action bus — has an owner in the file list, and the first thing that is genuinely a
 * feature rather than part of the shell is the tray's (U-039). The loop in `index.ts` is what the entries are
 * for, and it is exercised the moment one is added.
 */

import type { MainContext } from "./context";

/** One feature: given the shell's context, register what it owns and return. */
export type ShellFeature = (ctx: MainContext) => void;

/** Every registered feature, in the order they run. */
export const features: ShellFeature[] = [];
