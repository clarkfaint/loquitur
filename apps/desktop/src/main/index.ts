/**
 * The shell's entry point (F§10.3): one instance, one window, and the context both of them use.
 *
 * The single-instance lock is the first thing the shell does, and it is what makes a second launch a
 * *request to see the app* rather than a second app: this instance brings its window forward and the second
 * one exits before it creates anything at all. The lock is keyed on the user-data directory, which is why the
 * end-to-end suite can give a run its own directory and still exercise both halves.
 *
 * The context is built before `ready` so the settings are answerable the moment a renderer can ask — the
 * settings screen is the only way into the app. The window is created after `ready`, because there is no
 * window before it, and the features run last, with everything they might need already in place.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { createMainContext } from "./context";
import { features } from "./features";
import { settingsDirectory } from "./settings-store";
import { createMainWindow, MAIN_WINDOW_PAGE } from "./windows/main-window";

/** The built main bundle lives in `out/main`, so the two files beside it are found from there. The preload is
 * the one file that cannot be an ES module (F§10.3's `sandbox: true`), which is why its name says so. */
const PRELOAD_SCRIPT = join(__dirname, "..", "preload", "index.cjs");
const WEB_PAGE = join(__dirname, "..", "..", MAIN_WINDOW_PAGE);

/**
 * The directory this shell keeps everything in.
 *
 * `LECTERN_USER_DATA` overrides the *whole* user-data directory rather than only the settings file, and it has
 * to be applied before the single-instance lock: Chromium's lock lives in that directory, so the override is
 * what makes "a second launch of this shell" mean the shell a given run started, with no profile, database or
 * lock left over from an earlier one.
 */
function prepareUserDataDirectory(): string {
  const directory = settingsDirectory(process.env, app.getPath("userData"));
  if (process.env["LECTERN_USER_DATA"] !== undefined && process.env["LECTERN_USER_DATA"] !== "") {
    // Electron refuses a user-data directory that does not exist yet, so it is made first.
    mkdirSync(directory, { recursive: true });
    app.setPath("userData", directory);
  }
  return directory;
}

const userDataDirectory = prepareUserDataDirectory();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  const ctx = createMainContext({ settingsDir: userDataDirectory });

  // A second launch asks to see the app: the lock's own event carries it here, and the window it raises the
  // `showMain` action for is the one that answers (F§10.3).
  app.on("second-instance", () => {
    ctx.windows.showMain();
  });

  // The window hides rather than closes, so this only runs when the shell really has no window left.
  app.on("window-all-closed", () => {
    app.quit();
  });

  void app
    .whenReady()
    .then(() => {
      ctx.windows.main = createMainWindow({ preload: PRELOAD_SCRIPT, page: WEB_PAGE });
      for (const feature of features) feature(ctx);
    })
    .catch((cause: unknown) => {
      console.error(`Lectern could not start: ${cause instanceof Error ? cause.message : String(cause)}`);
      app.exit(1);
    });
}
