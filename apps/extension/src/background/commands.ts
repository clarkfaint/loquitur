/**
 * The keyboard commands (F§10.2): the manifest's four shortcuts, and what each one asks for.
 *
 * U-032's manifest declares the bindings and Chrome delivers them — the extension installs no key listener of
 * its own — so this file is the mapping from a command name to a `PlayerCommand` or to the page-reading
 * request, and the one listener that turns a keystroke into a message through the reading session. A player
 * command is sent as `ext/command`, the same message every view sends, because a keyboard shortcut is a view's
 * request like any other; and it goes through the session rather than straight to the offscreen document, so a
 * keystroke with nothing being read is refused with `NO_SESSION` instead of waking an audio host that has no
 * document.
 *
 * `read-page` is the one command that is not a player command: it starts a reading of the tab the reader is
 * looking at. Its *binding* belongs to U-035's `installReadActiveTab`, which already answers that command with
 * the same request, and the listener below therefore leaves it alone — two listeners on
 * `chrome.commands.onCommand` would answer one keystroke with two page-reading requests, and the tab would
 * extract and start its reading twice. The dispatch below still handles it, because the map is the whole
 * command surface; it is what a caller driving the command path runs.
 *
 * That caller is `lecternCommand`, published on the worker's global for the end-to-end suite: Chrome delivers
 * a manifest shortcut only to a focused browser window, and Playwright's key events reach the page instead of
 * the extension (measured — this unit's evidence file, §2). The seam runs the same dispatch the accelerator
 * runs, so what the suite drives is this file's own code.
 */

import type { PlayerCommand } from "@lectern/core";
import { requestPageReading } from "./read-active-tab";
import { getReadingSession } from "./session";

/** What one manifest command asks for. */
export type CommandAction = { readonly kind: "player"; readonly command: PlayerCommand } | { readonly kind: "reading" };

/** The four commands U-032's manifest binds, and what each one means. */
export const COMMANDS: Readonly<Record<string, CommandAction>> = {
  "toggle-play": { kind: "player", command: { type: "toggle" } },
  "next-sentence": { kind: "player", command: { type: "skip", sentences: 1 } },
  "previous-sentence": { kind: "player", command: { type: "skip", sentences: -1 } },
  "read-page": { kind: "reading" },
};

/** What a command name means, or `null` for a name this extension does not bind. */
export function commandAction(name: string): CommandAction | null {
  return COMMANDS[name] ?? null;
}

/** What this feature needs from the extension platform, injected so it can be driven without a browser. */
export interface CommandsPlatform {
  /** Watch the extension's keyboard commands. */
  onCommand(listener: (name: string) => void): void;
}

/** The platform of a real extension: `chrome.commands`. */
export const chromeCommandsPlatform: CommandsPlatform = {
  onCommand: (listener) => {
    chrome.commands.onCommand.addListener((command) => listener(command));
  },
};

/**
 * Run one command, as the extension would if no other feature had bound it.
 *
 * The answer is dropped: nobody is waiting on a keyboard shortcut, and a refusal is already visible as a
 * player that did not move. A session with nothing in it answers `NO_SESSION` for a player command, and a tab
 * that cannot be read answers `NO_ACTIVE_TAB` or `NO_CONTENT_SCRIPT` for `read-page`; neither is an error here.
 */
export async function runCommand(name: string): Promise<void> {
  const action = commandAction(name);
  if (action === null) return;
  if (action.kind === "reading") {
    await requestPageReading(null).catch(() => undefined);
    return;
  }
  await getReadingSession().command({ type: "ext/command", command: action.command });
}

declare global {
  /**
   * The command path, as the browser would raise it: one manifest command name, dispatched.
   *
   * Published by `installCommands` because a manifest shortcut needs a focused browser window and Playwright's
   * key events never reach the extension (measured). This is the seam an end-to-end case drives instead, and
   * it is `runCommand` itself — the same function the command listener below calls.
   */
  var lecternCommand: ((name: string) => Promise<void>) | undefined;
}

/**
 * Install the feature: watch the commands and run the ones this unit owns. Run once when the service worker
 * starts.
 */
export function installCommands(platform: CommandsPlatform = chromeCommandsPlatform): void {
  platform.onCommand((name) => {
    const action = commandAction(name);
    if (action === null) return;
    // `read-page` is bound by U-035's feature, which owns the page-reading request; see this file's note.
    if (action.kind === "reading") return;
    void runCommand(name);
  });
  globalThis.lecternCommand = runCommand;
}
