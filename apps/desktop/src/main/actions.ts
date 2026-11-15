/**
 * The shell's action bus (F§10.3).
 *
 * Every trigger the shell has — a global shortcut, the tray, the mini-player's own buttons, the bridge's
 * `windows` members, the region reader, and the end-to-end suite — raises one of the nine actions on this one
 * bus, and every feature that acts on an action registers its handler here. Nothing calls a feature directly,
 * which is what keeps the triggers and the features from having to know about each other: this unit raises
 * `toggleMini` and `readRegion`, and the features that own those (U-039's tray and mini-player, the region
 * reader) answer them without either side importing the other.
 *
 * The bus is Electron's own `app` emitter. That is deliberate: `app` is an `EventEmitter` with the
 * application's lifetime that every main-process module already holds, and it is the one trigger a test can
 * press from outside the app process, since `app.emit('lectern:action', …)` is an ordinary method call.
 *
 * The nine names and their schema live in `./ipc`, next to the wire shapes that carry them, because a
 * preload script bundles that module and may not import Electron at all; this module re-exports them, so
 * `./actions` is where a caller reads the action vocabulary from.
 */

import { app } from "electron";
import { DESKTOP_ACTION_NAMES, type DesktopAction, DesktopActionSchema } from "./ipc";

export type { DesktopAction };
export { DESKTOP_ACTION_NAMES, DesktopActionSchema };

/** The event every action rides on. */
export const ACTION_EVENT = "lectern:action";

/**
 * The two emitter members the bus uses.
 *
 * Electron's `App` extends `NodeJS.EventEmitter`, but it also declares an overload per built-in event, and
 * those overloads shadow the inherited generic ones — so `app.on("lectern:action", …)` does not type-check
 * even though it works, and neither does a direct narrowing of `App` to this pair. The application object is
 * an emitter at runtime; naming the pair the bus needs is what keeps the action type checked at both ends.
 */
interface ActionEmitter {
  emit(event: string, action: DesktopAction): void;
  on(event: string, listener: (action: DesktopAction) => void): void;
  off(event: string, listener: (action: DesktopAction) => void): void;
}

/** The application object, as the bus uses it: one emitter, alive for as long as the shell is. */
const bus = app as unknown as ActionEmitter;

/** Whether a value off a wire is one of the nine actions. */
export function isDesktopAction(value: unknown): value is DesktopAction {
  return DesktopActionSchema.safeParse(value).success;
}

/** `emitAction(action)` — raise one action on the bus, for every handler that registered for it. */
export function emitAction(action: DesktopAction): void {
  bus.emit(ACTION_EVENT, action);
}

/**
 * `onAction(action, handler)` — run `handler` whenever `action` is raised, and answer with the function that
 * stops listening. A handler registered for one action never sees another: the filter is here, once, rather
 * than in every feature.
 */
export function onAction(action: DesktopAction, handler: (action: DesktopAction) => void): () => void {
  const listener = (raised: DesktopAction): void => {
    if (raised === action) handler(raised);
  };
  bus.on(ACTION_EVENT, listener);
  return () => {
    bus.off(ACTION_EVENT, listener);
  };
}
