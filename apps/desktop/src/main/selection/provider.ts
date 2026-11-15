/**
 * Reading the operator's selection (F§10.3): where a capture comes from, and the one thing the shell asks of it.
 *
 * A selection lives in the operating system, not in the shell, and every way of reaching it is somewhere
 * different: Electron's own clipboard on X11, a command-line tool where the clipboard is not the answer, and a
 * synthetic copy chord on Windows. F§10.3's selection-capture table is therefore a *chain* per environment, and
 * this module is what a chain and an environment have in common: the answer (`capture()`), the name of the
 * chain (`id`, which is what `DesktopStatus.selectionProvider` carries), and one error type whose code says
 * what the operator would have to do about it.
 *
 * Three things are deliberately not here. Nothing in this module starts an observation: a capture happens when
 * the operator asks for one and never before. Nothing here reads a clock or a random number, so every chain is
 * a decision over the answers it is given. And nothing here knows about Electron: the clipboard, the
 * command-line tools and the timer are all *injected* (`SelectionClipboard`, `SelectionExec`, `SelectionSleep`),
 * which is F§10.3's own rule — "all commands run through an injected `exec` function so the logic is
 * unit-tested without the tools installed" — and the reason the Windows round trip is covered by a test on a
 * host that has no Windows.
 */

/** The environment a selection is captured in (F§10.3's selection-capture table). */
export type SelectionEnvironment = "linux-x11" | "linux-wayland" | "windows";

/** Why a capture failed: what the operator can do about each one is different. */
export type SelectionErrorCode = "TOOL_MISSING" | "TIMEOUT" | "EMPTY";

/** What a capture that could not answer is refused with: a code, and one sentence naming the reason. */
export class SelectionError extends Error {
  /** Which of the three endings this was. */
  readonly code: SelectionErrorCode;

  constructor(code: SelectionErrorCode, message: string) {
    super(message);
    this.name = "SelectionError";
    this.code = code;
  }
}

/** One way of reading the operator's selection. */
export interface SelectionProvider {
  /** Which chain this is, as `DesktopStatus.selectionProvider` reports it. */
  readonly id: SelectionEnvironment;
  /**
   * Read what is selected now, or fail with a `SelectionError`.
   *
   * The text is answered as the operating system holds it — trailing whitespace and all — because trimming and
   * capping are the reading's decisions rather than the capture's, and a chain that trimmed would have to guess
   * whether a source was really empty.
   */
  capture(): Promise<string>;
}

/**
 * The clipboard, as a provider uses it.
 *
 * Both selections F§10.3's table names are here, because the shell reads one on Linux and the other on
 * Windows. A platform that has no primary selection still has to answer the member — `""` is what it says.
 */
export interface SelectionClipboard {
  /** The primary selection's text (Linux X11 and Wayland), or `""` where the platform has no such selection. */
  readPrimary(): Promise<string>;
  /** The system clipboard's text. */
  readSystem(): Promise<string>;
  /** Replace the system clipboard's text. */
  writeSystem(text: string): Promise<void>;
}

/** How long one command-line tool is given before it is killed: the contract's 2 s, in one place. */
export const EXEC_TIMEOUT_MS = 2_000;

/**
 * How a provider runs a command-line tool: `execFile`'s shape, with the arguments as an array and a deadline.
 *
 * There is no shell here and no command string: the file and each argument are passed separately, so nothing a
 * selection contains can become part of a command.
 */
export type SelectionExec = (file: string, args: readonly string[], options: { timeout: number }) => Promise<{ stdout: string }>;

/** How a provider waits between two reads. It is injected so a wait is a test's decision, not a clock's. */
export type SelectionSleep = (ms: number) => Promise<void>;

/** Which way a command failed, as far as the chain cares. */
export type ExecFailure = "missing" | "timeout" | "failed";

/**
 * `classifyExecFailure(cause)` — what a failed command means.
 *
 * A missing executable is reported by the spawn itself (`ENOENT`) rather than by the program, and a deadline is
 * reported by the kill (`killed`), so both are read off the error the way `node:child_process` writes them. A
 * program that ran and exited badly is neither: it is *there*, which is what the chain needs to know.
 */
export function classifyExecFailure(cause: unknown): ExecFailure {
  if (typeof cause !== "object" || cause === null) return "failed";
  const shape = cause as { code?: unknown; killed?: unknown };
  if (shape.code === "ENOENT") return "missing";
  if (shape.code === "ETIMEDOUT" || shape.killed === true) return "timeout";
  return "failed";
}

/** Whether an answer holds any text at all: whitespace is nothing selected, not something selected. */
export function isBlank(text: string): boolean {
  return text.trim() === "";
}

/**
 * `detectEnvironment(platform, env)` — which of F§10.3's three chains this shell reads selections with.
 *
 * Wayland is decided by the session rather than by the display: a Wayland session names its compositor's socket
 * in `WAYLAND_DISPLAY` and states itself in `XDG_SESSION_TYPE`, while an X11 session — including one under a
 * nested or virtual X server — sets `DISPLAY` and neither of the other two. `win32` is Windows; anything else is
 * treated as a Linux session and decided by those two variables, which is what a shell built for Linux and
 * Windows can be asked (see the evidence's deviation proposals for the fourth platform this union has no
 * answer for).
 */
export function detectEnvironment(platform: string, env: Readonly<Record<string, string | undefined>>): SelectionEnvironment {
  if (platform === "win32") return "windows";
  const { WAYLAND_DISPLAY: wayland, XDG_SESSION_TYPE: session } = env;
  if (session === "wayland" || (wayland !== undefined && wayland !== "")) return "linux-wayland";
  return "linux-x11";
}
