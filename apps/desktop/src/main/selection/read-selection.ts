/**
 * Reading the operator's selection (F§10.3): the `readSelection` action, from the trigger to the reading.
 *
 * The shell's selection capture has one entry point — F§10.3's `readSelection`, raised by the global shortcut,
 * by the tray and by the mini-player, all of which are the same action on the same bus — and this module is
 * everything that happens after it. A capture is made once (never watched, never polled, never repeated), the
 * text is trimmed and capped, and it is handed to the app over the read-text channel, where the app's ordinary
 * import pipeline files it into `Quick reads` and opens it playing. The mini-player comes up with it, because
 * the reading is then something the operator listens to while they are in the application they selected the text
 * in. When there is nothing to read, nothing is read: one desktop notification carries the reason and the shell
 * is exactly as it was.
 *
 * Four decisions are this module's, and they are all about the boundary between the shell and F§10.3's bridge:
 *
 * - **The app is told, not shown.** The handler sends a read request — text and a title — and the app decides
 *   what a document is (F§5.2's `docId`, the library, the reader route). No file is written here, no `docId` is
 *   computed here, and no library is touched here.
 * - **The title is the text's own first sixty characters.** It is what the operator will see in the library and
 *   in the strip, and a selection has no name of its own (F§10.3's import request carries one because the
 *   library needs one).
 * - **A capture that failed is reported and not thrown.** The trigger is a shortcut or a tray entry, where an
 *   exception has nowhere to go and nobody to tell; the reason becomes a notification instead.
 * - **The environment is decided once, when the shell registers.** F§10.3 has the provider "(chosen at
 *   startup)", the choice is published into `DesktopStatus.selectionProvider` for the settings and diagnostics
 *   screens, and every later capture uses the chain that was chosen.
 *
 * Everything the capture and the report need is injected into `useReadSelection`, and the Electron surfaces are
 * built only in `readSelectionFeature` — the function `features.ts` registers. That is what lets the handler be
 * driven by unit tests on a host that has no Windows and no `xclip`, and what keeps this file free of any
 * decision a test would have to reach into an application to observe.
 */

import { execFile } from "node:child_process";
import { type Clipboard, clipboard, Notification } from "electron";
import type { MainContext } from "../context";
import type { ShellFeature } from "../features";
import { IPC_CHANNELS } from "../ipc";
import { createLinuxSelectionProvider } from "./linux";
import {
  detectEnvironment,
  type SelectionClipboard,
  type SelectionEnvironment,
  SelectionError,
  type SelectionExec,
  type SelectionProvider,
  type SelectionSleep,
} from "./provider";
import { createWindowsSelectionProvider } from "./windows";

/** The most text one capture hands to the app: the contract's 100 000 characters. */
export const SELECTION_CHAR_LIMIT = 100_000;

/** How much of the text becomes the document's title: the contract's first 60 characters. */
export const SELECTION_TITLE_CHARS = 60;

/** The notification a capture that failed is reported with. A trigger has no page to render an error into. */
export const REFUSAL_TITLE = "Loquitur could not read the selection";

/** What the handler is built from: the four surfaces it uses, and where it learns which platform it is on. */
export interface ReadSelectionSurfaces {
  /** The clipboard: the primary selection on Linux, the system clipboard on Windows. */
  clipboard: SelectionClipboard;
  /** How a command-line tool is run, when the chain reaches one. */
  exec: SelectionExec;
  /** How a wait between two reads is spent (F§10.3's Windows round trip). */
  sleep: SelectionSleep;
  /** Show one desktop notification: the shell's own, or a stand-in. */
  notify(title: string, body: string): void;
  /** Which platform this is; `process.platform` in the shell. */
  platform?: string;
  /** The session variables the environment is decided from; `process.env` in the shell. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** What a registered handler offers: the provider it chose, and the one way to ask it for a reading. */
export interface ReadSelection {
  /** The chain F§10.3 chose at startup, whose `id` is published as `DesktopStatus.selectionProvider`. */
  provider: SelectionProvider;
  /** Capture once, and do what F§10.3 says with what came back. It answers nothing and throws nothing. */
  read(): Promise<void>;
}

/** `createSelectionProvider(environment, surfaces)` — the chain F§10.3's table gives that environment. */
export function createSelectionProvider(environment: SelectionEnvironment, surfaces: ReadSelectionSurfaces): SelectionProvider {
  if (environment === "windows") {
    return createWindowsSelectionProvider({ clipboard: surfaces.clipboard, exec: surfaces.exec, sleep: surfaces.sleep });
  }
  return createLinuxSelectionProvider({ environment, clipboard: surfaces.clipboard, exec: surfaces.exec });
}

/** The title a capture is imported under: its own beginning, and nothing else. */
function titleFor(text: string): string {
  return text.slice(0, SELECTION_TITLE_CHARS);
}

/** What a failed capture is reported as, in one sentence the operator can act on. */
function reasonFor(cause: unknown): string {
  if (cause instanceof SelectionError) return cause.message;
  return `the selection could not be read: ${cause instanceof Error ? cause.message : String(cause)}`;
}

/**
 * `useReadSelection(ctx, surfaces)` — choose the chain, announce it, and answer F§10.3's action with a reading.
 *
 * The provider is chosen before anything is published, so the status a renderer reads can never name a chain
 * that does not exist. The handler itself is deliberately thin: capture, trim, cap, hand over, show the strip —
 * or report. Everything that could be decided differently is decided in the provider or in the app.
 *
 * The reading is capped *after* trimming, so the operator's leading whitespace cannot spend part of the
 * allowance; a capture that trims away to nothing is `EMPTY`, because whitespace is not something to read.
 */
export function useReadSelection(ctx: MainContext, surfaces: ReadSelectionSurfaces): ReadSelection {
  const environment = detectEnvironment(surfaces.platform ?? process.platform, surfaces.env ?? process.env);
  const provider = createSelectionProvider(environment, surfaces);

  // F§10.3's `DesktopStatus` is where a feature says what it registered. This one is chosen at startup and
  // never changes, so it is announced once, from here, and every later publish spreads the record it finds.
  ctx.settings.publishStatus({ ...ctx.settings.status(), selectionProvider: provider.id });

  async function read(): Promise<void> {
    try {
      const captured = await provider.capture();
      const text = captured.trim().slice(0, SELECTION_CHAR_LIMIT);
      if (text === "") throw new SelectionError("EMPTY", "nothing is selected");
      ctx.sendToMain(IPC_CHANNELS.readText, { text, title: titleFor(text) });
      // F§10.3's own trigger for the strip: the reading belongs to a strip that stands in for the window while
      // the operator is somewhere else (§7 (3) of the evidence notes what "show" means without a `showMini`).
      ctx.windows.toggleMini();
    } catch (cause) {
      surfaces.notify(REFUSAL_TITLE, reasonFor(cause));
    }
  }

  ctx.actions.on("readSelection", () => {
    void read();
  });

  return { provider, read };
}

/**
 * `readPrimarySelection()` — the primary selection, read through Electron's own clipboard.
 *
 * Electron documents the selection clipboard as a Linux object and says nothing about what it is elsewhere, so
 * the member is read as the optional thing its documentation describes rather than assumed: a platform without
 * one answers "nothing", which is what the chain's fallback is for.
 */
async function readPrimarySelection(): Promise<string> {
  const selection: Clipboard | undefined = clipboard.selection;
  return selection === undefined ? "" : await selection.readText();
}

/**
 * `execTool(file, args, options)` — one command-line tool, with the arguments as an array and a deadline.
 *
 * `execFile` spawns the program itself: there is no shell to interpret anything, so a selection can never be
 * read back as part of a command, and the deadline is the one F§10.3's rule gives (`timeout`). The rejection it
 * hands over is passed through unchanged, because which way a command failed is what the chain reads from it
 * (`classifyExecFailure`).
 */
function execTool(file: string, args: readonly string[], options: { timeout: number }): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: options.timeout, windowsHide: true }, (cause, stdout) => {
      if (cause !== null) {
        reject(cause);
        return;
      }
      resolve({ stdout });
    });
  });
}

/** `wait(ms)` — how long F§10.3's Windows round trip is given between two reads. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Show one desktop notification, on a desktop that has something to show it with. */
function notifyOnDesktop(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  new Notification({ title, body }).show();
}

/**
 * `readSelectionFeature` — what `features.ts` registers (the registry U-038 marked).
 *
 * It is the whole of this unit's contact with Electron: one adapter per surface, so the chain below it speaks
 * only the four interfaces `./provider` declares.
 */
export const readSelectionFeature: ShellFeature = (ctx: MainContext): void => {
  useReadSelection(ctx, {
    clipboard: {
      readPrimary: readPrimarySelection,
      readSystem: () => clipboard.readText(),
      writeSystem: (text) => clipboard.writeText(text),
    },
    exec: execTool,
    sleep: wait,
    platform: process.platform,
    env: process.env,
    notify: notifyOnDesktop,
  });
};
