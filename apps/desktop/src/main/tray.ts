/**
 * The tray (F§10.3): the shell's one always-there trigger, and the way back to the app after its window is
 * closed.
 *
 * Five entries and no more. **Play** or **Pause**, whose label follows the state the host published — which is
 * why the menu is built from that state rather than written once; **Next sentence**; **Show Lectern**;
 * **Show** or **Hide mini-player**, whose label follows whether the strip is up; and **Quit**. There is
 * deliberately nothing here about accounts, plans, updates or the wider world: this is a single-user local
 * application, and F§10.3's list is the whole of what its tray offers.
 *
 * **Quit is the only entry that ends the shell** (F§10.3). Closing the app's window hides it, because playback
 * is supposed to outlive the window, so the tray is where the operator says they are finished — and that is
 * also what makes the menu honest: while it is up, the app is still running and still reading.
 *
 * Nothing here reads the player's state for itself. `update(state)` is handed what the relay last carried, so
 * the tray never forms a second opinion about what the player is doing.
 */

import { Menu, type MenuItemConstructorOptions, type NativeImage, Tray } from "electron";

/** The icon the tray is created with, relative to the application directory — the shell adds its own directory
 * to it the same way it does for the windows' pages. */
export const TRAY_ICON = "resources/icons/32.png";

/** What the tray's entries do. Each one is F§10.3's own action, or the quit that ends the shell. */
export interface TrayActions {
  /** Play or pause the reading: F§10.3's `togglePlay`. */
  togglePlay(): void;
  /** Move on a sentence: F§10.3's `nextSentence`. */
  nextSentence(): void;
  /** Bring the app's window forward: F§10.3's `showMain`. */
  showMain(): void;
  /** Show or hide the mini-player: F§10.3's `toggleMini`. */
  toggleMini(): void;
  /** End the shell. The tray is the only place that does (F§10.3). */
  quit(): void;
}

/** The two pieces of state the tray's labels are drawn from. */
export interface TrayState {
  /** Whether the reading is running, which decides between Play and Pause. */
  playing: boolean;
  /** Whether the mini-player is on the screen, which decides between Show and Hide. */
  miniVisible: boolean;
}

/** A tray that is up, and can be told that the shell's state has changed. */
export interface ShellTray {
  /** Rebuild the menu from `state`, unless neither label would differ. */
  update(state: TrayState): void;
  /** Take the tray down. */
  destroy(): void;
}

/**
 * `trayMenuTemplate(state, actions)` — F§10.3's five entries, separated into the reading's own controls, the
 * two windows, and the end of the session.
 *
 * Every entry raises one of the shell's actions rather than doing the work here, so the tray is a trigger like
 * a hotkey or a mini-player button and F§10.3's one action bus stays the only way a feature is reached.
 */
export function trayMenuTemplate(state: TrayState, actions: TrayActions): MenuItemConstructorOptions[] {
  return [
    { label: state.playing ? "Pause" : "Play", click: () => actions.togglePlay() },
    { type: "separator" },
    { label: "Next sentence", click: () => actions.nextSentence() },
    { label: "Show Lectern", click: () => actions.showMain() },
    { label: state.miniVisible ? "Hide mini-player" : "Show mini-player", click: () => actions.toggleMini() },
    { type: "separator" },
    { label: "Quit", click: () => actions.quit() },
  ];
}

/** `createTray(options)` — the tray icon and its menu, up and answerable. */
export function createTray(options: { icon: NativeImage; actions: TrayActions; state: TrayState }): ShellTray {
  const tray = new Tray(options.icon);
  tray.setToolTip("Lectern");
  let current = options.state;
  const apply = (state: TrayState): void => {
    tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(state, options.actions)));
  };
  apply(current);

  return {
    update(state) {
      // The state arrives on every published snapshot, and a menu is rebuilt only when a label would change:
      // replacing the menu of a tray the operator is looking at is not something to do once a second.
      if (state.playing === current.playing && state.miniVisible === current.miniVisible) return;
      current = state;
      apply(current);
    },

    destroy() {
      tray.destroy();
    },
  };
}
