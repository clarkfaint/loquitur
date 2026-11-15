/**
 * Windows selection capture (F§10.3's selection-capture table).
 *
 * On Windows there is no primary selection and no tool that reads what another application has highlighted, so
 * F§10.3's chain is a *round trip through the clipboard*: save what the operator had, send the copy chord to
 * whatever window has focus, wait for the clipboard to change, read it, and put back what was saved. Four steps,
 * and only the second one needs the operating system.
 *
 * The one rule that shapes every line below is that the clipboard belongs to the operator. A read-aloud action
 * may not cost them what they had copied, so the saved text is restored in a `finally` — after a success, after
 * the deadline, and after a copy that failed — and the chain never leaves the clipboard holding the selection it
 * captured. (On Linux nothing is written at all: the selection is read where it already lives.)
 *
 * The wait is counted rather than timed. F§10.3 fixes the window at 400 ms and this module reads the clipboard
 * every 40 ms of it, which is ten polls: counting them makes the wait exact under an injected `sleep` and
 * independent of how long a read takes, and it keeps the whole round trip a decision over its inputs rather
 * than something a clock decides (AGENTS.md §7).
 */

import {
  classifyExecFailure,
  EXEC_TIMEOUT_MS,
  isBlank,
  type SelectionClipboard,
  SelectionError,
  type SelectionExec,
  type SelectionProvider,
  type SelectionSleep,
} from "./provider";

/** How long Windows is given to put the selection on the clipboard (F§10.3). */
export const COPY_WAIT_MS = 400;

/** How often the clipboard is read while that window runs: a tenth of it. */
export const COPY_POLL_MS = 40;

/** The program that sends the chord: the Windows PowerShell that is part of the operating system. */
export const POWERSHELL = "powershell.exe";

/**
 * What is sent: the copy chord, to the window that currently has the operator's focus.
 *
 * It is PowerShell's own `SendKeys`, which is the only part of the round trip that has to be PowerShell at all,
 * and it is written as an argument — never as a command line assembled here — so nothing about the selection
 * can reach it.
 */
export const COPY_SCRIPT = 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^c")';

/** The arguments F§10.3's copy chord is sent with: no profile, no prompts, one script. */
export const POWERSHELL_ARGUMENTS: readonly string[] = ["-NoProfile", "-NonInteractive", "-Command", COPY_SCRIPT];

/** What a Windows provider is built from. */
export interface WindowsSelectionOptions {
  /** The clipboard, as the shell exposes it. */
  clipboard: SelectionClipboard;
  /** How the copy chord is sent. */
  exec: SelectionExec;
  /** How the wait between two reads is spent. */
  sleep: SelectionSleep;
}

/**
 * `waitForChange(clipboard, saved, sleep)` — the clipboard's text once it differs from what was saved.
 *
 * `null` is the answer F§10.3's window closes with nothing happening, which is the ordinary way a copy that
 * copied nothing behaves: the chord was sent, the application had no selection, and the clipboard is exactly as
 * it was.
 */
async function waitForChange(clipboard: SelectionClipboard, saved: string, sleep: SelectionSleep): Promise<string | null> {
  const polls = Math.max(1, Math.round(COPY_WAIT_MS / COPY_POLL_MS));
  for (let poll = 0; poll < polls; poll += 1) {
    await sleep(COPY_POLL_MS);
    const text = await clipboard.readSystem();
    if (text !== saved) return text;
  }
  return null;
}

/**
 * `createWindowsSelectionProvider(options)` — F§10.3's clipboard round trip.
 *
 * The three ways the copy step can fail are told apart, because they ask different things of the operator: a
 * PowerShell that is not installed is `TOOL_MISSING`, one that hangs past its deadline is `TIMEOUT`, and any
 * other failure is left to the clipboard itself — the chord may still have been sent, and what the clipboard
 * says afterwards is the answer F§10.3 wants. A copy that changed nothing, or that put nothing on the
 * clipboard, is `EMPTY`: the operator's next step is to select something and ask again.
 */
export function createWindowsSelectionProvider(options: WindowsSelectionOptions): SelectionProvider {
  const { clipboard, exec, sleep } = options;

  return {
    id: "windows",

    async capture(): Promise<string> {
      const saved = await clipboard.readSystem();
      try {
        try {
          await exec(POWERSHELL, POWERSHELL_ARGUMENTS, { timeout: EXEC_TIMEOUT_MS });
        } catch (cause) {
          const failure = classifyExecFailure(cause);
          if (failure === "missing") {
            throw new SelectionError("TOOL_MISSING", `${POWERSHELL} is not available, so the copy chord cannot be sent`);
          }
          if (failure === "timeout") {
            throw new SelectionError("TIMEOUT", `sending the copy chord took longer than ${EXEC_TIMEOUT_MS} ms`);
          }
        }

        const copied = await waitForChange(clipboard, saved, sleep);
        if (copied === null || isBlank(copied)) {
          throw new SelectionError("EMPTY", "nothing was copied, so the clipboard did not change");
        }
        return copied;
      } finally {
        // F§10.3: the operator's clipboard is theirs. Every path above passes through here, including the two
        // throws, so a capture can never be the reason something they copied is gone.
        await clipboard.writeSystem(saved);
      }
    },
  };
}
