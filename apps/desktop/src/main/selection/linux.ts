/**
 * Linux selection capture (F§10.3's selection-capture table).
 *
 * Two environments, two chains, and one of them is backwards from the other:
 *
 * | Environment | First | Then |
 * |---|---|---|
 * | X11 | Electron's own clipboard, reading the PRIMARY selection | `xclip -o -selection primary`, then `xsel -o -p` |
 * | Wayland | `wl-paste --primary --no-newline` | Electron's own clipboard |
 *
 * The order is F§10.3's and it is not decoration. The shell's own clipboard needs nothing installed and answers
 * synchronously from the same process, which is what makes it the first candidate on X11; on Wayland the
 * compositor owns the selection and `wl-paste` is the only way to ask a different client about it, while the
 * clipboard object is the fallback for a session that still has an X11 path. On this host neither `xclip` nor
 * `xsel` nor `wl-paste` exists, so the shell's own clipboard is what answers in practice — and the command-line
 * tools are the fallback for the hosts that have them.
 *
 * Everything the chain touches is injected (see `./provider`): the clipboard object, the way a command is run,
 * and — through `SelectionExec`'s deadline — how long one of those commands is allowed to take. A command is
 * always a file plus an argument array, never a string handed to a shell, so nothing that is selected can
 * become part of a command.
 */

import {
  classifyExecFailure,
  EXEC_TIMEOUT_MS,
  isBlank,
  type SelectionClipboard,
  type SelectionEnvironment,
  SelectionError,
  type SelectionExec,
  type SelectionProvider,
} from "./provider";

/** One way of getting the text: a command-line tool, or the shell's own clipboard. */
interface SelectionSource {
  /** What an operator installs to make this source work, or `null` for one that needs nothing installed. */
  readonly packages: string | null;
  /** What the tool is called, for the source that is one. */
  readonly tool: string | null;
  run(): Promise<string>;
}

/** The two environments a Linux chain covers. */
export type LinuxSelectionEnvironment = Exclude<SelectionEnvironment, "windows">;

/** What a Linux provider is built from. */
export interface LinuxSelectionOptions {
  /** Which chain to build: the X11 one or the Wayland one (F§10.3). */
  environment: LinuxSelectionEnvironment;
  /** The clipboard, as the shell exposes it. */
  clipboard: SelectionClipboard;
  /** How a command-line tool is run. */
  exec: SelectionExec;
}

/** The clipboard source: always there, and never counted as a tool in the error a failure produces. */
function clipboardSource(clipboard: SelectionClipboard): SelectionSource {
  return { packages: null, tool: null, run: () => clipboard.readPrimary() };
}

/** One command-line source: its package for the install hint, its arguments, and its own output. */
function toolSource(exec: SelectionExec, packages: string, tool: string, args: readonly string[]): SelectionSource {
  return {
    packages,
    tool,
    run: async () => (await exec(tool, args, { timeout: EXEC_TIMEOUT_MS })).stdout,
  };
}

/** The chain F§10.3 gives each environment, in its own order. */
function sourcesFor(environment: LinuxSelectionEnvironment, options: LinuxSelectionOptions): SelectionSource[] {
  const own = clipboardSource(options.clipboard);
  if (environment === "linux-wayland") {
    return [toolSource(options.exec, "wl-clipboard", "wl-paste", ["--primary", "--no-newline"]), own];
  }
  return [
    own,
    toolSource(options.exec, "xclip", "xclip", ["-o", "-selection", "primary"]),
    toolSource(options.exec, "xsel", "xsel", ["-o", "-p"]),
  ];
}

/** The packages an operator installs, in the order the chain would have used them. */
function packagesToInstall(missing: readonly string[]): string {
  return [...new Set(missing)].join(" or ");
}

/**
 * `createLinuxSelectionProvider(options)` — the chain F§10.3 gives this environment.
 *
 * The chain ends in exactly one of F§10.3's outcomes, and which one is decided by what the candidates did
 * rather than by which one was asked last:
 *
 * - the first candidate that answers with text wins, and nothing after it is asked;
 * - every candidate that ran and answered nothing — a selection that really is empty — is `EMPTY`;
 * - every candidate that could have answered was not installed is `TOOL_MISSING`, naming the packages;
 * - a candidate that hung past its deadline is `TIMEOUT`, because the operator's fix for that is neither an
 *   install nor a second try at selecting something.
 */
export function createLinuxSelectionProvider(options: LinuxSelectionOptions): SelectionProvider {
  const sources = sourcesFor(options.environment, options);

  return {
    id: options.environment,

    async capture(): Promise<string> {
      /** The packages of every candidate that was not installed, in the order they were asked. */
      const missing: string[] = [];
      /** Whether a tool that could have answered really ran, which is what makes an empty answer a selection. */
      let answered = false;
      /** Whether something hung, which is the one ending an install cannot fix. */
      let timedOut = false;
      /** What the shell's own clipboard failed with, if it did: no tool can explain that away as "nothing". */
      let ownFailure: unknown = null;

      for (const source of sources) {
        try {
          const text = await source.run();
          if (source.tool !== null) answered = true;
          if (!isBlank(text)) return text;
        } catch (cause) {
          if (source.tool === null) {
            // A source that runs no program — the shell's own clipboard — cannot fail in a way this chain
            // understands, so the reason is kept and reported if nothing else answers.
            ownFailure = cause;
            continue;
          }
          const failure = classifyExecFailure(cause);
          if (failure === "missing") {
            if (source.packages !== null) missing.push(source.packages);
            continue;
          }
          if (failure === "timeout") timedOut = true;
          else answered = true;
        }
      }

      if (timedOut) throw new SelectionError("TIMEOUT", `a selection tool did not answer within ${EXEC_TIMEOUT_MS} ms`);
      if (!answered && missing.length > 0) {
        throw new SelectionError("TOOL_MISSING", `reading the selection needs ${packagesToInstall(missing)} installed`);
      }
      // Nothing answered, and the shell's own clipboard is why: reporting "nothing is selected" would hide it.
      if (ownFailure !== null) throw ownFailure;
      throw new SelectionError("EMPTY", "nothing is selected");
    },
  };
}
