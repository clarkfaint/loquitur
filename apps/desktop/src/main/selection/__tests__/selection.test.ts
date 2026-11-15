/**
 * Selection capture and the read-selection flow (F§10.3).
 *
 * Every case here drives the chain through the surfaces it is given — a clipboard that is a map of two strings,
 * an `exec` that answers per tool name, a `sleep` that is a function — so what is asserted is the *decision*:
 * which candidate is asked in which order, what each way of failing means, whether the operator's clipboard is
 * put back, and what the handler does with the text (and with a failure). Nothing here starts an application,
 * touches an operating system clipboard, or has a Windows to run on: the round trip that needs one is exercised
 * with the same injected surfaces the rest of the chain uses, which is F§10.3's own reason for injecting them.
 *
 * The Electron surfaces themselves are built in `readSelectionFeature`, which the end-to-end case drives; the
 * handler below is `useReadSelection`, so every behaviour of the handler is reachable from here.
 */

import { describe, expect, test } from "vitest";
import type { MainContext } from "../../context";
import { type DesktopAction, IPC_CHANNELS } from "../../ipc";
import { type DesktopStatus, defaultSettings, pendingStatus } from "../../settings-store";
import { createLinuxSelectionProvider } from "../linux";
import {
  classifyExecFailure,
  detectEnvironment,
  EXEC_TIMEOUT_MS,
  type SelectionClipboard,
  type SelectionEnvironment,
  SelectionError,
  type SelectionExec,
  type SelectionProvider,
  type SelectionSleep,
} from "../provider";
import { createSelectionProvider, REFUSAL_TITLE, SELECTION_CHAR_LIMIT, SELECTION_TITLE_CHARS, useReadSelection } from "../read-selection";
import { COPY_POLL_MS, COPY_SCRIPT, COPY_WAIT_MS, createWindowsSelectionProvider, POWERSHELL, POWERSHELL_ARGUMENTS } from "../windows";

/** One command the chain ran, as it was handed over. */
interface ExecCall {
  file: string;
  args: string[];
  timeout: number;
}

/** The error a program that is not installed produces: `execFile` reports the spawn's own `ENOENT`. */
function missingTool(tool: string): Error {
  return Object.assign(new Error(`spawn ${tool} ENOENT`), { code: "ENOENT" });
}

/** The error a program that ran past its deadline produces: the kill is what ended it. */
function pastDeadline(tool: string): Error {
  return Object.assign(new Error(`${tool} was killed`), { killed: true, signal: "SIGTERM" });
}

/**
 * `fakeClipboard(held)` — the clipboard, as two strings and a log.
 *
 * The reads are counted because half of the chain is about which source is asked *at all*: a tool that answers
 * means the clipboard is never consulted again.
 */
function fakeClipboard(held: { primary?: string; system?: string } = {}): {
  clipboard: SelectionClipboard;
  writes: string[];
  primaryReads: number;
  systemReads: number;
  hold(text: string): void;
} {
  let primary = held.primary ?? "";
  let system = held.system ?? "";
  const state = {
    writes: [] as string[],
    primaryReads: 0,
    systemReads: 0,
    clipboard: {
      readPrimary: async () => {
        state.primaryReads += 1;
        return primary;
      },
      readSystem: async () => {
        state.systemReads += 1;
        return system;
      },
      writeSystem: async (text: string) => {
        state.writes.push(text);
        system = text;
      },
    } satisfies SelectionClipboard,
    hold: (text: string) => {
      primary = text;
      system = text;
    },
  };
  return state;
}

/** `fakeExec(answers)` — one answer per tool, and every call it was handed. A tool with no answer is missing. */
function fakeExec(answers: Readonly<Record<string, string | Error>> = {}): { exec: SelectionExec; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  return {
    calls,
    exec: async (file, args, options) => {
      calls.push({ file, args: [...args], timeout: options.timeout });
      const answer = answers[file];
      if (answer === undefined) throw missingTool(file);
      if (answer instanceof Error) throw answer;
      return { stdout: answer };
    },
  };
}

/** A chain that must not run at all in the case using it. */
const unusedExec: SelectionExec = async (file) => {
  throw new Error(`${file} was not expected to run`);
};

/** One notification, as it was shown. */
interface Notification {
  title: string;
  body: string;
}

/** The shell the handler is given, as a case sees it: the context, and everything the handler did with it. */
interface FakeShell {
  ctx: MainContext;
  /** Every payload pushed to the main window, in order. */
  sent: { channel: string; payload: unknown }[];
  /** Every status the shell published, in order. */
  statuses: DesktopStatus[];
  /** How often the mini-player's trigger was raised. */
  readonly miniToggles: number;
  /** Raise one action on the bus, exactly as a shortcut or the tray does. */
  raise(action: DesktopAction): void;
}

/** `fakeShell()` — the context the handler is given, with everything it does recorded. */
function fakeShell(): FakeShell {
  let status: DesktopStatus = pendingStatus();
  let miniToggles = 0;
  const statuses: DesktopStatus[] = [];
  const sent: { channel: string; payload: unknown }[] = [];
  const listeners = new Set<{ action: DesktopAction; handler: () => void }>();

  const raise = (action: DesktopAction): void => {
    for (const listener of [...listeners]) {
      if (listener.action === action) listener.handler();
    }
  };

  const ctx: MainContext = {
    settings: {
      directory: () => "/tmp/lectern-u041",
      get: async () => defaultSettings(),
      set: async () => defaultSettings(),
      onChange: () => () => undefined,
      onStatus: (handler) => {
        handler(status);
        return () => undefined;
      },
      publishStatus: (next) => {
        status = next;
        statuses.push(next);
      },
      status: () => status,
      pickFolder: async () => null,
    },
    actions: {
      emit: (action) => {
        raise(action);
      },
      on: (action, handler) => {
        const listener = { action, handler: () => handler(action) };
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    windows: {
      main: null,
      showMain: () => undefined,
      toggleMini: () => {
        miniToggles += 1;
      },
    },
    get status(): DesktopStatus {
      return status;
    },
    sendToMain: (channel, payload) => {
      sent.push({ channel, payload });
    },
  };

  return {
    ctx,
    sent,
    statuses,
    raise,
    get miniToggles(): number {
      return miniToggles;
    },
  };
}

/** What a Linux provider is built from in one line. */
function linuxChain(environment: SelectionEnvironment, clipboard: SelectionClipboard, exec: SelectionExec): SelectionProvider {
  return createLinuxSelectionProvider({ environment: environment === "linux-wayland" ? "linux-wayland" : "linux-x11", clipboard, exec });
}

/** Let the handler's own promise chain finish before its effects are read. */
async function settled(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("detectEnvironment", () => {
  test("names the three environments F§10.3's table has a chain for", () => {
    // A Wayland session states itself, or names its compositor's socket, and it is decided before X11.
    expect(detectEnvironment("linux", { WAYLAND_DISPLAY: "wayland-0" })).toBe("linux-wayland");
    expect(detectEnvironment("linux", { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" })).toBe("linux-wayland");
    // The X11 session under a virtual X server: a display, and neither of the other two.
    expect(detectEnvironment("linux", { DISPLAY: ":99" })).toBe("linux-x11");
    expect(detectEnvironment("linux", {})).toBe("linux-x11");
    // The platform's own answer wins over a session variable: a Wayland variable on Windows is not a session.
    expect(detectEnvironment("win32", { WAYLAND_DISPLAY: "wayland-0" })).toBe("windows");
    // An empty value is not a value: an exported-but-blank variable is the X11 branch.
    expect(detectEnvironment("linux", { WAYLAND_DISPLAY: "" })).toBe("linux-x11");
  });
});

describe("the X11 chain", () => {
  test("the shell's own clipboard answers first, and no tool is asked", async () => {
    const clipboard = fakeClipboard({ primary: "The ferry waits.\n" });
    const { exec, calls } = fakeExec();
    const provider = linuxChain("linux-x11", clipboard.clipboard, exec);

    expect(provider.id).toBe("linux-x11");
    // The text arrives as the selection holds it: trimming is the reading's decision, not the capture's.
    expect(await provider.capture()).toBe("The ferry waits.\n");
    expect(calls).toEqual([]);
    expect(clipboard.primaryReads).toBe(1);
  });

  test("an empty clipboard falls through xclip to xsel, and the arguments are an array", async () => {
    const clipboard = fakeClipboard({ primary: "" });
    const { exec, calls } = fakeExec({ xsel: "Nobody is in a hurry yet." });
    const provider = linuxChain("linux-x11", clipboard.clipboard, exec);

    expect(await provider.capture()).toBe("Nobody is in a hurry yet.");
    // F§10.3's own order, one command each, and the deadline is the contract's 2 s.
    expect(calls).toEqual([
      { file: "xclip", args: ["-o", "-selection", "primary"], timeout: EXEC_TIMEOUT_MS },
      { file: "xsel", args: ["-o", "-p"], timeout: EXEC_TIMEOUT_MS },
    ]);
    // Each argument is its own element: nothing here is a command string for a shell to interpret.
    expect(calls[0]?.args).toEqual(["-o", "-selection", "primary"]);
    expect(calls.every((call) => call.args.every((arg) => !arg.includes(";") && !arg.includes("|")))).toBe(true);
  });

  test("xclip answering stops the chain: xsel is never asked", async () => {
    const clipboard = fakeClipboard({ primary: "   " });
    const { exec, calls } = fakeExec({ xclip: "Gulls circle the pier." });
    const provider = linuxChain("linux-x11", clipboard.clipboard, exec);

    expect(await provider.capture()).toBe("Gulls circle the pier.");
    expect(calls.map((call) => call.file)).toEqual(["xclip"]);
  });

  test("a tool that is installed and answers nothing is an empty selection, not a missing tool", async () => {
    const clipboard = fakeClipboard({ primary: "" });
    const { exec } = fakeExec({ xclip: "", xsel: "  \n" });
    const provider = linuxChain("linux-x11", clipboard.clipboard, exec);

    await expect(provider.capture()).rejects.toThrow(SelectionError);
    await expect(provider.capture()).rejects.toMatchObject({ code: "EMPTY", message: "nothing is selected" });
  });

  test("both tools missing is TOOL_MISSING, naming the packages", async () => {
    const clipboard = fakeClipboard({ primary: "" });
    const { exec } = fakeExec();
    const provider = linuxChain("linux-x11", clipboard.clipboard, exec);

    const failure = await provider.capture().catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(SelectionError);
    expect(failure).toMatchObject({ code: "TOOL_MISSING" });
    // The message is the operator's next command, so both packages are in it, in the chain's own order.
    expect((failure as SelectionError).message).toContain("xclip");
    expect((failure as SelectionError).message).toContain("xsel");
    expect((failure as SelectionError).message.indexOf("xclip")).toBeLessThan((failure as SelectionError).message.indexOf("xsel"));
  });

  test("a tool that runs past its deadline is TIMEOUT, not an empty selection", async () => {
    const clipboard = fakeClipboard({ primary: "" });
    const { exec, calls } = fakeExec({ xclip: pastDeadline("xclip"), xsel: pastDeadline("xsel") });
    const provider = linuxChain("linux-x11", clipboard.clipboard, exec);

    await expect(provider.capture()).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(calls).toHaveLength(2);
  });

  test("the shell's own clipboard failing is reported as itself, unless something else can be installed", async () => {
    const broken: SelectionClipboard = {
      readPrimary: async () => {
        throw new Error("the display went away");
      },
      readSystem: async () => "",
      writeSystem: async () => undefined,
    };

    // Both tools are installed and answer nothing: the reason nothing was read is the clipboard, and saying
    // "nothing is selected" would hide it.
    const present = fakeExec({ xclip: "", xsel: "  " });
    await expect(linuxChain("linux-x11", broken, present.exec).capture()).rejects.toThrow("the display went away");

    // Nothing installable could have answered either: that is the more useful of the two sentences, because it
    // is the one the operator can act on.
    const absent = fakeExec();
    await expect(linuxChain("linux-x11", broken, absent.exec).capture()).rejects.toMatchObject({ code: "TOOL_MISSING" });
  });
});

describe("the Wayland chain", () => {
  test("wl-paste is asked first, and answers the selection", async () => {
    const clipboard = fakeClipboard({ primary: "The morning ferry waits." });
    const { exec, calls } = fakeExec({ "wl-paste": "The morning ferry waits." });
    const provider = linuxChain("linux-wayland", clipboard.clipboard, exec);

    expect(provider.id).toBe("linux-wayland");
    expect(await provider.capture()).toBe("The morning ferry waits.");
    expect(calls).toEqual([{ file: "wl-paste", args: ["--primary", "--no-newline"], timeout: EXEC_TIMEOUT_MS }]);
    // F§10.3's own order on Wayland: the compositor's own tool first, Electron's clipboard after it.
    expect(clipboard.primaryReads).toBe(0);
  });

  test("a wl-paste that is not installed falls back to the shell's own clipboard", async () => {
    const clipboard = fakeClipboard({ primary: "Nobody is in a hurry yet." });
    const { exec, calls } = fakeExec();
    const provider = linuxChain("linux-wayland", clipboard.clipboard, exec);

    expect(await provider.capture()).toBe("Nobody is in a hurry yet.");
    expect(calls.map((call) => call.file)).toEqual(["wl-paste"]);
    expect(clipboard.primaryReads).toBe(1);
  });

  test("wl-clipboard missing with nothing selectable names the package", async () => {
    const clipboard = fakeClipboard({ primary: "" });
    const { exec } = fakeExec();
    const provider = linuxChain("linux-wayland", clipboard.clipboard, exec);

    const failure = await provider.capture().catch((cause: unknown) => cause);
    expect(failure).toMatchObject({ code: "TOOL_MISSING" });
    expect((failure as SelectionError).message).toContain("wl-clipboard");
  });
});

describe("the Windows round trip", () => {
  test("the copy chord is sent, the clipboard is read once it changes, and it is put back", async () => {
    const clipboard = fakeClipboard({ system: "what the operator had copied" });
    const { exec, calls } = fakeExec({ [POWERSHELL]: "" });
    const sleeps: number[] = [];
    let polled = 0;
    const sleep: SelectionSleep = async (ms) => {
      sleeps.push(ms);
      polled += 1;
      if (polled === 1) clipboard.hold("The ferry waits. Gulls circle the pier.");
    };

    const provider = createWindowsSelectionProvider({ clipboard: clipboard.clipboard, exec, sleep });
    expect(provider.id).toBe("windows");
    expect(await provider.capture()).toBe("The ferry waits. Gulls circle the pier.");

    // PowerShell, with the copy chord as one argument of an array — never a command line assembled here.
    expect(calls).toEqual([{ file: POWERSHELL, args: [...POWERSHELL_ARGUMENTS], timeout: EXEC_TIMEOUT_MS }]);
    expect(POWERSHELL_ARGUMENTS).toEqual(["-NoProfile", "-NonInteractive", "-Command", COPY_SCRIPT]);
    expect(POWERSHELL_ARGUMENTS).toContain(COPY_SCRIPT);
    expect(sleeps).toEqual([COPY_POLL_MS]);
    // What was there before the capture is what is there after it (F§10.3's own rule for Windows).
    expect(clipboard.writes).toEqual(["what the operator had copied"]);
    expect(await clipboard.clipboard.readSystem()).toBe("what the operator had copied");
  });

  test("a copy that never changes the clipboard is EMPTY, and the wait is the whole window", async () => {
    const clipboard = fakeClipboard({ system: "what the operator had copied" });
    const { exec } = fakeExec({ [POWERSHELL]: "" });
    const sleeps: number[] = [];
    const sleep: SelectionSleep = async (ms) => {
      sleeps.push(ms);
    };

    const provider = createWindowsSelectionProvider({ clipboard: clipboard.clipboard, exec, sleep });
    await expect(provider.capture()).rejects.toMatchObject({ code: "EMPTY" });

    // F§10.3's 400 ms, polled a tenth of it at a time: the window is counted, so a case can assert it exactly.
    expect(sleeps).toHaveLength(COPY_WAIT_MS / COPY_POLL_MS);
    expect(sleeps.every((ms) => ms === COPY_POLL_MS)).toBe(true);
    expect(clipboard.writes).toEqual(["what the operator had copied"]);
  });

  test("a chord that copied a blank clipboard is EMPTY too", async () => {
    const clipboard = fakeClipboard({ system: "what the operator had copied" });
    const { exec } = fakeExec({ [POWERSHELL]: "" });
    const sleep: SelectionSleep = async () => {
      clipboard.hold("   ");
    };

    const provider = createWindowsSelectionProvider({ clipboard: clipboard.clipboard, exec, sleep });
    await expect(provider.capture()).rejects.toMatchObject({ code: "EMPTY" });
    expect(clipboard.writes).toEqual(["what the operator had copied"]);
  });

  test("a PowerShell that ran past its deadline is TIMEOUT, and the clipboard is still put back", async () => {
    const clipboard = fakeClipboard({ system: "what the operator had copied" });
    const { exec } = fakeExec({ [POWERSHELL]: pastDeadline(POWERSHELL) });
    const sleep: SelectionSleep = async () => undefined;

    const provider = createWindowsSelectionProvider({ clipboard: clipboard.clipboard, exec, sleep });
    await expect(provider.capture()).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(clipboard.writes).toEqual(["what the operator had copied"]);
    expect(await clipboard.clipboard.readSystem()).toBe("what the operator had copied");
  });

  test("a PowerShell that is not there is TOOL_MISSING, and the clipboard is still put back", async () => {
    const clipboard = fakeClipboard({ system: "what the operator had copied" });
    const { exec } = fakeExec();
    const sleep: SelectionSleep = async () => undefined;

    const provider = createWindowsSelectionProvider({ clipboard: clipboard.clipboard, exec, sleep });
    await expect(provider.capture()).rejects.toMatchObject({ code: "TOOL_MISSING" });
    expect(clipboard.writes).toEqual(["what the operator had copied"]);
  });

  test("a failed copy is left to the clipboard, and what was saved is still put back", async () => {
    const clipboard = fakeClipboard({ system: "what the operator had copied" });
    const { exec } = fakeExec({ [POWERSHELL]: new Error("the chord could not be sent") });
    let polled = 0;
    const sleep: SelectionSleep = async () => {
      polled += 1;
      if (polled === 2) clipboard.hold("The ferry waits.");
    };

    const provider = createWindowsSelectionProvider({ clipboard: clipboard.clipboard, exec, sleep });
    expect(await provider.capture()).toBe("The ferry waits.");
    expect(clipboard.writes).toEqual(["what the operator had copied"]);
  });
});

describe("classifyExecFailure", () => {
  test("tells a missing program, a deadline and a program that simply failed apart", () => {
    expect(classifyExecFailure(missingTool("xclip"))).toBe("missing");
    expect(classifyExecFailure(pastDeadline("xclip"))).toBe("timeout");
    expect(classifyExecFailure(Object.assign(new Error("exited 1"), { code: 1 }))).toBe("failed");
    expect(classifyExecFailure(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }))).toBe("timeout");
    expect(classifyExecFailure("not an error")).toBe("failed");
    expect(classifyExecFailure(null)).toBe("failed");
  });
});

describe("the read-selection handler", () => {
  test("announces its provider at registration, and a reading is trimmed, capped and handed over", async () => {
    const shell = fakeShell();
    const clipboard = fakeClipboard({ primary: `   ${"ferry ".repeat(20)}   ` });
    const { exec } = fakeExec();
    const notifications: Notification[] = [];
    const read = useReadSelection(shell.ctx, {
      clipboard: clipboard.clipboard,
      exec,
      sleep: async () => undefined,
      notify: (title, body) => notifications.push({ title, body }),
      platform: "linux",
      env: { DISPLAY: ":99" },
    });

    // F§10.3's `status` carries the chain this shell chose, and it is announced before anything is captured.
    expect(read.provider.id).toBe("linux-x11");
    expect(shell.statuses).toHaveLength(1);
    expect(shell.statuses[0]?.selectionProvider).toBe("linux-x11");
    // ...and the announcement is a change to the record it found, not a record of its own.
    expect(shell.statuses[0]?.hotkeys).toEqual(pendingStatus().hotkeys);

    shell.raise("readSelection");
    await settled();

    expect(shell.sent).toEqual([
      {
        channel: IPC_CHANNELS.readText,
        payload: { text: "ferry ".repeat(20).trimEnd(), title: "ferry ".repeat(20).trimEnd().slice(0, SELECTION_TITLE_CHARS) },
      },
    ]);
    // The strip comes up with the reading (F§10.3's trigger for it).
    expect(shell.miniToggles).toBe(1);
    expect(notifications).toEqual([]);
  });

  test("the text is capped at 100 000 characters after trimming, and the title is its first 60", async () => {
    const shell = fakeShell();
    const long = `   ${"x".repeat(SELECTION_CHAR_LIMIT + 10)}   `;
    const clipboard = fakeClipboard({ primary: long });
    const read = useReadSelection(shell.ctx, {
      clipboard: clipboard.clipboard,
      exec: unusedExec,
      sleep: async () => undefined,
      notify: () => undefined,
      platform: "linux",
      env: { DISPLAY: ":99" },
    });

    await read.read();

    const payload = shell.sent[0]?.payload as { text: string; title: string };
    expect(payload.text).toHaveLength(SELECTION_CHAR_LIMIT);
    expect(payload.title).toHaveLength(SELECTION_TITLE_CHARS);
    expect(payload.text.startsWith("x".repeat(SELECTION_CHAR_LIMIT))).toBe(true);
  });

  test("an empty selection is reported as one notification, and nothing else happens", async () => {
    const shell = fakeShell();
    // The clipboard holds whitespace and both tools are installed and answer nothing: an empty selection.
    const clipboard = fakeClipboard({ primary: "  \n" });
    const { exec } = fakeExec({ xclip: "", xsel: "" });
    const notifications: Notification[] = [];
    const read = useReadSelection(shell.ctx, {
      clipboard: clipboard.clipboard,
      exec,
      sleep: async () => undefined,
      notify: (title, body) => notifications.push({ title, body }),
      platform: "linux",
      env: { DISPLAY: ":99" },
    });

    await read.read();

    expect(notifications).toEqual([{ title: REFUSAL_TITLE, body: "nothing is selected" }]);
    expect(shell.sent).toEqual([]);
    expect(shell.miniToggles).toBe(0);
  });

  test("a host without the tools reports what to install, and still nothing else happens", async () => {
    const shell = fakeShell();
    const clipboard = fakeClipboard({ primary: "" });
    const { exec } = fakeExec();
    const notifications: Notification[] = [];
    const read = useReadSelection(shell.ctx, {
      clipboard: clipboard.clipboard,
      exec,
      sleep: async () => undefined,
      notify: (title, body) => notifications.push({ title, body }),
      platform: "linux",
      env: { DISPLAY: ":99" },
    });

    await read.read();

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.title).toBe(REFUSAL_TITLE);
    expect(notifications[0]?.body).toContain("xclip");
    expect(shell.sent).toEqual([]);
    expect(shell.miniToggles).toBe(0);
  });

  test("a capture that threw something else is reported too, and never escapes the handler", async () => {
    const shell = fakeShell();
    const notifications: Notification[] = [];
    const broken: SelectionClipboard = {
      readPrimary: async () => {
        throw new Error("the display went away");
      },
      readSystem: async () => "",
      writeSystem: async () => undefined,
    };
    const read = useReadSelection(shell.ctx, {
      clipboard: broken,
      exec: unusedExec,
      sleep: async () => undefined,
      notify: (title, body) => notifications.push({ title, body }),
      platform: "linux",
      env: { DISPLAY: ":99" },
    });

    await expect(read.read()).resolves.toBeUndefined();
    expect(notifications).toEqual([{ title: REFUSAL_TITLE, body: "the selection could not be read: the display went away" }]);
    expect(shell.sent).toEqual([]);
  });

  test("the environment decides the chain the handler uses", () => {
    const shell = fakeShell();
    const clipboard = fakeClipboard();
    const surfaces = {
      clipboard: clipboard.clipboard,
      exec: unusedExec,
      sleep: async () => undefined,
      notify: () => undefined,
    };

    expect(createSelectionProvider("linux-wayland", surfaces).id).toBe("linux-wayland");
    expect(createSelectionProvider("windows", surfaces).id).toBe("windows");
    expect(createSelectionProvider("linux-x11", surfaces).id).toBe("linux-x11");
    expect(shell.statuses).toEqual([]);
  });
});
