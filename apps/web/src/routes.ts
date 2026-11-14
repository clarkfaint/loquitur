/**
 * The shell's routes (F§10.1), as the registry AGENTS.md §5 describes: a later unit appends its own pattern
 * and component here, and the shell picks it up with no edit of its own.
 *
 * `/settings` is this unit's only screen. F§10.1's library, reader, import and mini routes arrive with the
 * units that build them.
 */

import type { ComponentType } from "react";
import { ImportPage } from "./import/ImportPage";
import { LibraryPage } from "./library/LibraryPage";
import { MiniPage } from "./mini/MiniPage";
import { ReaderPage } from "./reader/ReaderPage";
import { SettingsPage } from "./settings/SettingsPage";

/** One registered route: the pattern the router matches, and the component it renders. A route takes no
 * props — a page that needs a parameter or a query reads it from `useHashRoute()` itself. */
export interface AppRoute {
  pattern: string;
  component: ComponentType;
}

/** Every registered route, in the order the shell's navigation lists them. */
export const routes: AppRoute[] = [
  { pattern: "/settings", component: SettingsPage },
  { pattern: "/library", component: LibraryPage },
  { pattern: "/import", component: ImportPage },
  { pattern: "/read/:docId", component: ReaderPage },
  { pattern: "/mini", component: MiniPage },
];
