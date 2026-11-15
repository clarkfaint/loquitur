/**
 * The shell's player feature (F§10.3): the tray, the mini-player's window and the player's relay, registered
 * together because they are one thing — the shell's own controls for a reading that is going on in a page.
 *
 * `features.ts` runs this once, after the app is ready and the main window exists, and everything it needs is
 * already in place by then: the context's action bus (which it registers the player's actions on), the context's
 * push to the main window (which the relay keeps as the echo), and `ipcMain`, which the relay takes the player's
 * two channels over through.
 *
 * The window is made lazily, on the first trigger that needs it — which is exactly what F§10.3 wants: the
 * mini-player is a thing the operator asks for, and a shell that is only ever used for its main window never
 * pays for a second one. Where it opens comes from the settings record, and where it is moved to goes back
 * there, so the position survives a restart.
 *
 * Two of F§10.3's actions are answered here. `toggleMini` shows or hides the strip. `showMain` — raised by a
 * shortcut, the tray's Show Lectern entry and a second launch of the app — hides it: the reader's own window is
 * in front with the whole player bar in it, and the strip exists to stand in for that window, not to sit on top
 * of it.
 */

import { join } from "node:path";
import { app, ipcMain, nativeImage } from "electron";
import { emitAction } from "../actions";
import type { MainContext } from "../context";
import type { ShellFeature } from "../features";
import { registerPlayerRelay } from "../player-relay";
import { createTray, type ShellTray, TRAY_ICON, type TrayState } from "../tray";
import { createMiniWindow, type MiniWindow, miniWindowPage } from "../windows/mini-window";

/** The preload script F§10.3's bridge is exposed by, beside the built main bundle in `out/main`. */
const PRELOAD_SCRIPT = join(__dirname, "..", "preload", "index.cjs");

/** The tray's icon, beside the packaged application's `resources` directory. */
const TRAY_ICON_PATH = join(__dirname, "..", "..", TRAY_ICON);

/** Report a trigger that could not do what it was asked, since a tray click has nowhere to show an error. */
function report(cause: unknown): void {
  console.error(`the mini-player is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
}

export const shellFeatures: ShellFeature = (context: MainContext): void => {
  const relay = registerPlayerRelay({ actions: context.actions, sendToMain: context.sendToMain }, { channels: ipcMain });

  let mini: MiniWindow | null = null;
  let tray: ShellTray | null = null;

  /** What the tray's two labels are drawn from: the state the host published, and the mini-player. */
  function shellState(): TrayState {
    return { playing: relay.last()?.state === "playing", miniVisible: mini?.isVisible() ?? false };
  }

  /** Bring the tray's labels up to date. It is called far more often than either label changes. */
  function refresh(): void {
    tray?.update(shellState());
  }

  /** The mini-player's window: made on the first trigger that needs it, kept from then on. */
  async function miniWindow(): Promise<MiniWindow> {
    const existing = mini;
    if (existing !== null) return existing;

    const settings = await context.settings.get();
    const created = createMiniWindow({
      preload: PRELOAD_SCRIPT,
      page: miniWindowPage(),
      bounds: settings.miniBounds,
      onMoved: (bounds) => {
        void context.settings.set({ miniBounds: bounds }).catch(report);
      },
      onReady: (window) => {
        // The page is loaded and its bus is up: hand the relay the window, and it will join the page to the
        // bridge and give it the state it missed (F§10.1 defines no handshake for a remote that opens late).
        void relay.attach(window.webContents);
      },
    });

    mini = created;
    created.window().on("show", refresh);
    created.window().on("hide", refresh);
    return created;
  }

  context.actions.on("toggleMini", () => {
    void miniWindow()
      .then((created) => {
        if (created.isVisible()) created.hide();
        else created.show();
        refresh();
      })
      .catch(report);
  });

  context.actions.on("showMain", () => {
    if (mini === null || !mini.isVisible()) return;
    mini.hide();
    refresh();
  });

  // The tray's entries raise the shell's own actions rather than acting themselves, so a tray click and a
  // hotkey are the same trigger on F§10.3's one bus — and Quit, which is the only entry that ends the shell.
  tray = createTray({
    icon: nativeImage.createFromPath(TRAY_ICON_PATH),
    actions: {
      togglePlay: () => {
        emitAction("togglePlay");
      },
      nextSentence: () => {
        emitAction("nextSentence");
      },
      showMain: () => {
        emitAction("showMain");
      },
      toggleMini: () => {
        emitAction("toggleMini");
      },
      quit: () => {
        app.quit();
      },
    },
    state: shellState(),
  });

  // Play or Pause follows the state the host publishes, so the label is refreshed from the relay's snapshots.
  relay.onSnapshot(refresh);
};
