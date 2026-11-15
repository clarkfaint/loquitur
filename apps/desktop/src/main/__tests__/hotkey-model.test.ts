/**
 * The hotkey model and the feature that applies it (F§10.3).
 *
 * The first four groups are the pure model: F§10.3's defaults, the validator, the conflict finder and the diff
 * between two maps. The last group drives the feature itself through the surfaces it is given — a stand-in for
 * `globalShortcut`, for `app`'s quit event, and for `ipcMain` — so what it asserts is what the shell hands the
 * OS, in which order, and what it reports about each action afterwards, with no application and no window
 * involved. The settings store underneath it is the real one, over a directory of this case's own.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { MainContext } from "../context";
import { DEFAULT_HOTKEYS, diffHotkeys, findConflicts, type HotkeyMap, normalizeAccelerator, validateAccelerator } from "../hotkey-model";
import {
  type GlobalShortcutSurface,
  type HotkeyChannelHost,
  type LifecycleSurface,
  PORTAL_RESOLUTION_EVENT,
  registerGlobalHotkeys,
} from "../hotkeys";
import { type DesktopAction, IPC_CHANNELS } from "../ipc";
import { createSettingsStore, type DesktopSettingsStore, defaultSettings, DEFAULT_HOTKEYS as STORE_DEFAULTS } from "../settings-store";

/** The directory this case's record lives in. */
let directory = "";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "lectern-desktop-hotkeys-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("F§10.3's defaults", () => {
  test("the seven chords appear verbatim, and the tray's two triggers have none", () => {
    expect(DEFAULT_HOTKEYS).toEqual({
      readSelection: "Ctrl+Alt+R",
      readRegion: "Ctrl+Alt+S",
      togglePlay: "Ctrl+Alt+Space",
      nextSentence: "Ctrl+Alt+Right",
      previousSentence: "Ctrl+Alt+Left",
      faster: "Ctrl+Alt+Up",
      slower: "Ctrl+Alt+Down",
      toggleMini: "",
      showMain: "",
    });
  });

  test("every bound default is usable, and no two actions ask for the same chord", () => {
    for (const [action, accelerator] of Object.entries(DEFAULT_HOTKEYS)) {
      if (accelerator === "") continue;
      expect(validateAccelerator(accelerator), `${action} is ${accelerator}`).toBeNull();
    }
    expect(findConflicts(DEFAULT_HOTKEYS)).toEqual([]);
  });

  test("the defaults are the same table the frozen settings record starts from", () => {
    // U-038's `settings-store` holds its own copy (R6 freezes it); the two must not drift.
    expect(DEFAULT_HOTKEYS).toEqual(STORE_DEFAULTS);
    expect(defaultSettings().hotkeys).toEqual(DEFAULT_HOTKEYS);
  });
});

describe("validateAccelerator", () => {
  test("a modifier and a key, however they are spelled", () => {
    for (const accelerator of ["Ctrl+Alt+R", "Control+Alt+Space", "CmdOrCtrl+Shift+P", "Alt+Right", "Super+Space", "Option+F5", "Ctrl+/"]) {
      expect(validateAccelerator(accelerator), accelerator).toBeNull();
    }
  });

  test("a bare key, a bare modifier and a chord with no key are all refused", () => {
    expect(validateAccelerator("")).toMatch(/modifier and a key/u);
    expect(validateAccelerator("R")).toMatch(/modifier before its key/u);
    expect(validateAccelerator("Ctrl")).toMatch(/modifier before its key/u);
    // A last part that is a modifier is not a key, whichever modifier it is.
    expect(validateAccelerator("Ctrl+Alt")).toMatch(/that is a modifier/u);
    expect(validateAccelerator("Ctrl+Shift+Option")).toMatch(/that is a modifier/u);
    expect(validateAccelerator("Ctrl+Alt+")).toMatch(/key after its modifiers/u);
  });

  test("a modifier named twice, an empty part and an unknown modifier are refused", () => {
    expect(validateAccelerator("Ctrl+Shift+Control+P")).toMatch(/named twice/u);
    // `Ctrl` and `Control` are one modifier, so naming both is naming one twice.
    expect(validateAccelerator("Ctrl+Control+P")).toMatch(/named twice/u);
    expect(validateAccelerator("Control++P")).toMatch(/not a modifier/u);
    expect(validateAccelerator("Hyper+P")).toMatch(/not a modifier/u);
    expect(validateAccelerator(" Ctrl+Alt+P")).toMatch(/whitespace/u);
  });
});

describe("findConflicts", () => {
  test("the later action of a shared chord is the one that conflicts", () => {
    const shared = { readSelection: "Ctrl+Alt+R", togglePlay: "Ctrl+Alt+R", nextSentence: "Ctrl+Alt+Right" };
    expect(findConflicts(shared)).toEqual(["togglePlay"]);
  });

  test("two spellings of one chord conflict, and two unbound actions do not", () => {
    expect(findConflicts({ readSelection: "Ctrl+Alt+R", togglePlay: "Control+Alt+R" })).toEqual(["togglePlay"]);
    expect(findConflicts({ readSelection: "Ctrl+Alt+R", togglePlay: "Ctrl+Alt+r" })).toEqual(["togglePlay"]);
    expect(findConflicts({ toggleMini: "", showMain: "" })).toEqual([]);
    expect(findConflicts({})).toEqual([]);
  });

  test("a chord three actions ask for reports the two that came after the first", () => {
    const three = { readSelection: "Ctrl+Alt+R", togglePlay: "Ctrl+Alt+R", nextSentence: "Ctrl+Alt+R" };
    expect(findConflicts(three)).toEqual(["togglePlay", "nextSentence"]);
  });
});

describe("diffHotkeys", () => {
  test("from nothing, every bound default is asked for and nothing is given up", () => {
    const changes = diffHotkeys({}, DEFAULT_HOTKEYS);
    expect(changes.unregister).toEqual([]);
    expect(changes.register).toEqual(["readSelection", "readRegion", "togglePlay", "nextSentence", "previousSentence", "faster", "slower"]);
  });

  test("an unchanged map asks for nothing at all", () => {
    expect(diffHotkeys(DEFAULT_HOTKEYS, DEFAULT_HOTKEYS)).toEqual({ unregister: [], register: [] });
  });

  test("a changed chord gives the old one up and asks for the action that took a new one", () => {
    const next: HotkeyMap = { ...DEFAULT_HOTKEYS, togglePlay: "Control+Alt+P" };
    expect(diffHotkeys(DEFAULT_HOTKEYS, next)).toEqual({ unregister: ["Ctrl+Alt+Space"], register: ["togglePlay"] });
  });

  test("binding an action that had none asks for it, and unbinding one gives its chord up", () => {
    const bound: HotkeyMap = { ...DEFAULT_HOTKEYS, toggleMini: "Ctrl+Alt+M" };
    expect(diffHotkeys(DEFAULT_HOTKEYS, bound)).toEqual({ unregister: [], register: ["toggleMini"] });
    expect(diffHotkeys(bound, DEFAULT_HOTKEYS)).toEqual({ unregister: ["Ctrl+Alt+M"], register: [] });
  });

  test("a swap gives both chords up before either is asked for, which is the order they are in", () => {
    const swapped: HotkeyMap = { ...DEFAULT_HOTKEYS, readSelection: "Ctrl+Alt+S", readRegion: "Ctrl+Alt+R" };
    expect(diffHotkeys(DEFAULT_HOTKEYS, swapped)).toEqual({
      unregister: ["Ctrl+Alt+R", "Ctrl+Alt+S"],
      register: ["readSelection", "readRegion"],
    });
  });
});

describe("normalizeAccelerator", () => {
  test("two spellings of one chord come to the same thing", () => {
    expect(normalizeAccelerator("Ctrl+Alt+R")).toBe(normalizeAccelerator("Control+Alt+R"));
    expect(normalizeAccelerator("Alt+Ctrl+R")).toBe(normalizeAccelerator("Ctrl+Alt+R"));
    expect(normalizeAccelerator("CmdOrCtrl+P")).toBe(normalizeAccelerator("CommandOrControl+p"));
  });
});

/** One payload the feature pushed to the renderer, and the channel it went out on. */
interface Delivery {
  channel: string;
  payload: unknown;
}

/** A stand-in for the shell: the store, the action bus, and the push to the main window. */
interface FakeShell extends MainContext {
  sent: Delivery[];
  raised: DesktopAction[];
}

function fakeShell(store: DesktopSettingsStore): FakeShell {
  const sent: Delivery[] = [];
  const raised: DesktopAction[] = [];
  return {
    settings: {
      ...store,
      pickFolder: async () => null,
    },
    actions: {
      emit(action) {
        raised.push(action);
      },
      on: () => () => undefined,
    },
    windows: { main: null, showMain: () => undefined, toggleMini: () => undefined },
    get status() {
      return store.status();
    },
    sendToMain(channel, payload) {
      sent.push({ channel, payload });
    },
    sent,
    raised,
  };
}

/** A stand-in for `globalShortcut`: what it was told, what it holds, and the portal's own resolution. */
interface FakeShortcut extends GlobalShortcutSurface {
  calls: string[];
  registered: Map<string, () => void>;
  resolve(): void;
}

function fakeShortcut(options: { portal?: boolean; refuses?: string[] } = {}): FakeShortcut {
  const calls: string[] = [];
  const registered = new Map<string, () => void>();
  const listeners = new Set<(details: unknown) => void>();
  const refuses = new Set(options.refuses ?? []);
  const surface: FakeShortcut = {
    calls,
    registered,
    register(accelerator, callback) {
      calls.push(`register:${accelerator}`);
      if (refuses.has(accelerator) || registered.has(accelerator)) return false;
      registered.set(accelerator, callback);
      return true;
    },
    isRegistered: (accelerator) => registered.has(accelerator),
    unregister(accelerator) {
      calls.push(`unregister:${accelerator}`);
      registered.delete(accelerator);
    },
    unregisterAll() {
      calls.push("unregisterAll");
      registered.clear();
    },
    resolve() {
      for (const listener of [...listeners]) listener({});
    },
  };
  if (options.portal === true) {
    surface.on = (event, listener) => {
      if (event === PORTAL_RESOLUTION_EVENT) listeners.add(listener);
    };
    surface.off = (_event, listener) => {
      listeners.delete(listener);
    };
  }
  return surface;
}

/** A stand-in for the application object: the one member the feature registers on, and the quit that fires it. */
interface FakeLifecycle extends LifecycleSurface {
  quit(): void;
}

function fakeLifecycle(): FakeLifecycle {
  const listeners: (() => void)[] = [];
  return {
    on: (_event, listener) => {
      listeners.push(listener);
    },
    quit() {
      for (const listener of [...listeners]) listener();
    },
  };
}

/** A stand-in for `ipcMain`: one handler per channel, as `handle` and `removeHandler` maintain. */
interface FakeChannels extends HotkeyChannelHost {
  raise(channel: string, payload: unknown): Promise<unknown>;
}

function fakeChannels(): FakeChannels {
  const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
  return {
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
    async raise(channel, payload) {
      const bound = handlers.get(channel);
      if (bound === undefined) throw new Error(`nothing answers on ${channel}`);
      return await bound(null, payload);
    },
  };
}

/** A shell's worth of surfaces, and the store underneath the context. */
function surfaces(): {
  store: DesktopSettingsStore;
  shell: FakeShell;
  shortcut: FakeShortcut;
  lifecycle: FakeLifecycle;
  channels: FakeChannels;
} {
  const store = createSettingsStore({ dir: directory });
  return { store, shell: fakeShell(store), shortcut: fakeShortcut(), lifecycle: fakeLifecycle(), channels: fakeChannels() };
}

describe("the feature", () => {
  test("every default chord is handed over once, each raises its own action, and the shell reports them", async () => {
    const { store, shell, shortcut, lifecycle, channels } = surfaces();
    // A binding that was there before the feature runs: the channel changes hands rather than gaining a second
    // handler (`ipcMain` keeps one per channel), so this one never answers again.
    channels.handle(IPC_CHANNELS.settingsGet, () => "the handler that was there before");

    const hotkeys = registerGlobalHotkeys(shell, { shortcut, lifecycle, channels });
    // The renderer's own read is also where the first registration is awaited, so this is deterministic.
    expect(await channels.raise(IPC_CHANNELS.settingsGet, undefined)).toEqual(defaultSettings());

    expect(shortcut.calls).toEqual([
      "register:Ctrl+Alt+R",
      "register:Ctrl+Alt+S",
      "register:Ctrl+Alt+Space",
      "register:Ctrl+Alt+Right",
      "register:Ctrl+Alt+Left",
      "register:Ctrl+Alt+Up",
      "register:Ctrl+Alt+Down",
    ]);
    expect(hotkeys.status()).toEqual({
      readSelection: "registered",
      readRegion: "registered",
      togglePlay: "registered",
      nextSentence: "registered",
      previousSentence: "registered",
      faster: "registered",
      slower: "registered",
      // F§10.3 gives these two no default, so nothing is bound and nothing is claimed.
      toggleMini: "pending",
      showMain: "pending",
    });

    shortcut.registered.get("Ctrl+Alt+R")?.();
    shortcut.registered.get("Ctrl+Alt+Space")?.();
    expect(shell.raised).toEqual(["readSelection", "togglePlay"]);

    // The status is published to the store and pushed to the renderer, which are two different readers.
    const last = shell.sent.at(-1);
    expect(last?.channel).toBe(IPC_CHANNELS.settingsStatus);
    expect(store.status().hotkeys.togglePlay).toBe("registered");
  });

  test("a stored string that is not an accelerator never reaches the OS, and reads failed", async () => {
    const { store, shell, shortcut, lifecycle, channels } = surfaces();
    await store.set({ hotkeys: { ...DEFAULT_HOTKEYS, togglePlay: "P" } });

    const hotkeys = registerGlobalHotkeys(shell, { shortcut, lifecycle, channels });
    await channels.raise(IPC_CHANNELS.settingsGet, undefined);

    expect(shortcut.calls).not.toContain("register:P");
    expect(shortcut.registered.has("P")).toBe(false);
    expect(hotkeys.status().togglePlay).toBe("failed");
    // The other six are unaffected by one bad string.
    expect(hotkeys.status().readSelection).toBe("registered");
  });

  test("a chord the OS refuses reads failed, and an empty accelerator is never handed over", async () => {
    const store = createSettingsStore({ dir: directory });
    const shell = fakeShell(store);
    const shortcut = fakeShortcut({ refuses: ["Ctrl+Alt+S"] });
    const lifecycle = fakeLifecycle();
    const channels = fakeChannels();
    await store.set({ hotkeys: { ...DEFAULT_HOTKEYS, toggleMini: "" } });

    const hotkeys = registerGlobalHotkeys(shell, { shortcut, lifecycle, channels });
    await channels.raise(IPC_CHANNELS.settingsGet, undefined);

    expect(hotkeys.status().readRegion).toBe("failed");
    expect(shortcut.calls.filter((call) => call.startsWith("register:"))).toHaveLength(7);
  });

  test("a change gives the old chord up before asking for the new one, and leaves the rest alone", async () => {
    const { store, shell, shortcut, lifecycle, channels } = surfaces();
    const hotkeys = registerGlobalHotkeys(shell, { shortcut, lifecycle, channels });
    await channels.raise(IPC_CHANNELS.settingsGet, undefined);
    const before = shortcut.calls.length;

    await store.set({ hotkeys: { ...DEFAULT_HOTKEYS, togglePlay: "Control+Alt+P" } });

    expect(shortcut.calls.slice(before)).toEqual(["unregister:Ctrl+Alt+Space", "register:Control+Alt+P"]);
    expect(shortcut.registered.has("Control+Alt+P")).toBe(true);
    expect(shortcut.registered.has("Ctrl+Alt+Space")).toBe(false);
    expect(hotkeys.status().togglePlay).toBe("registered");
    expect(hotkeys.status().readSelection).toBe("registered");
  });

  test("two actions may swap chords, because both are given up before either is asked for", async () => {
    const { store, shell, shortcut, lifecycle, channels } = surfaces();
    registerGlobalHotkeys(shell, { shortcut, lifecycle, channels });
    await channels.raise(IPC_CHANNELS.settingsGet, undefined);
    const before = shortcut.calls.length;

    await store.set({ hotkeys: { ...DEFAULT_HOTKEYS, readSelection: "Ctrl+Alt+S", readRegion: "Ctrl+Alt+R" } });

    // Both are given up before either is asked for, so the swap is possible at all.
    expect(shortcut.calls.slice(before)).toEqual([
      "unregister:Ctrl+Alt+R",
      "unregister:Ctrl+Alt+S",
      "register:Ctrl+Alt+S",
      "register:Ctrl+Alt+R",
    ]);
    expect([...shortcut.registered.keys()]).toContain("Ctrl+Alt+S");
    expect([...shortcut.registered.keys()]).toContain("Ctrl+Alt+R");
  });

  test("on a surface that reports the portal, a chord waits, and is then read from the accelerators themselves", async () => {
    const store = createSettingsStore({ dir: directory });
    const shell = fakeShell(store);
    // The desktop takes every chord but one, which is what a consent dialog answered "no" looks like.
    const shortcut = fakeShortcut({ portal: true, refuses: ["Ctrl+Alt+Down"] });
    const lifecycle = fakeLifecycle();
    const channels = fakeChannels();

    const hotkeys = registerGlobalHotkeys(shell, { shortcut, lifecycle, channels });
    await channels.raise(IPC_CHANNELS.settingsGet, undefined);

    // Nothing is claimed before the desktop has answered, however the register call itself returned.
    expect(hotkeys.status().togglePlay).toBe("pending");
    expect(hotkeys.status().slower).toBe("pending");
    expect(shortcut.calls.filter((call) => call.startsWith("register:"))).toHaveLength(7);

    shortcut.resolve();

    expect(hotkeys.status().togglePlay).toBe("registered");
    expect(hotkeys.status().slower).toBe("failed");
    expect(hotkeys.status().readSelection).toBe("registered");
  });

  test("quitting gives every chord up", async () => {
    const { store, shell, shortcut, lifecycle, channels } = surfaces();
    registerGlobalHotkeys(shell, { shortcut, lifecycle, channels });
    await channels.raise(IPC_CHANNELS.settingsGet, undefined);
    expect(shortcut.registered.size).toBe(7);

    lifecycle.quit();

    expect(shortcut.calls.at(-1)).toBe("unregisterAll");
    expect(shortcut.registered.size).toBe(0);
    expect(store.status().hotkeys.togglePlay).toBe("registered");
  });
});
