/**
 * The global shortcuts as data (F§10.3): what the defaults are, whether a written accelerator is usable, which
 * two actions are asking for the same one, and what a change from one map to another comes to.
 *
 * Nothing here imports Electron. The shell's feature (`./hotkeys`) is what holds the OS surface and the action
 * bus; this module is the part of the problem that is a decision rather than a call, so it can be reasoned about
 * — and tested — without an application running. The four questions it answers are the four the shell asks in
 * that order: are these the defaults, may this string be handed over, does someone else already hold it, and
 * what has to be unregistered and registered to get from the map in force to the map the operator just chose.
 *
 * An accelerator is written the way Electron writes one: modifiers, then a key, joined by `+` — `Ctrl+Alt+R`.
 * The defaults below are F§10.3's own strings and appear verbatim, `Ctrl` included; a chord the operator
 * *captures* in the settings screen is spelled with the full modifier names (`Control+Alt+R`), which is the same
 * accelerator to the OS and an unambiguous one to read. That is why comparison goes through
 * `normalizeAccelerator` rather than through string equality.
 */

import { DESKTOP_ACTION_NAMES, type DesktopAction } from "./ipc";

/** A map from action to accelerator, as far as each of them is known: an action nobody has bound is absent. */
export type HotkeyMap = Readonly<Partial<Record<DesktopAction, string>>>;

/**
 * The default accelerator of every action (F§10.3).
 *
 * Seven of the nine actions have one. `toggleMini` and `showMain` do not — F§10.3 lists them as the tray's and
 * the mini-player's own triggers — and the empty string is how "no accelerator" is written everywhere in this
 * shell, because the settings record's schema gives every action a string.
 */
export const DEFAULT_HOTKEYS: Record<DesktopAction, string> = {
  readSelection: "Ctrl+Alt+R",
  readRegion: "Ctrl+Alt+S",
  togglePlay: "Ctrl+Alt+Space",
  nextSentence: "Ctrl+Alt+Right",
  previousSentence: "Ctrl+Alt+Left",
  faster: "Ctrl+Alt+Up",
  slower: "Ctrl+Alt+Down",
  toggleMini: "",
  showMain: "",
};

/**
 * Every spelling Electron accepts for a modifier, under the canonical name this module files it as.
 *
 * The synonyms are the point: `Ctrl` and `Control` are one modifier, so a map that binds `Ctrl+Alt+R` to one
 * action and `Control+Alt+R` to another is asking the OS for the same chord twice, however it is written.
 */
const MODIFIERS: ReadonlyMap<string, string> = new Map([
  ["command", "Command"],
  ["cmd", "Command"],
  ["control", "Control"],
  ["ctrl", "Control"],
  ["commandorcontrol", "CommandOrControl"],
  ["cmdorctrl", "CommandOrControl"],
  ["alt", "Alt"],
  ["option", "Alt"],
  ["altgr", "AltGr"],
  ["shift", "Shift"],
  ["super", "Super"],
  ["meta", "Super"],
]);

/**
 * What a key may look like: one printable ASCII character, or a name of letters and digits (`F5`, `Space`,
 * `Right`, `PageUp`).
 *
 * This is the *shape* of a key and not Electron's own vocabulary of them: the installed Electron types name no
 * such vocabulary (R9), so nothing here claims a name the OS does not know — an accelerator that reads as a
 * name and is not one is refused by the OS itself, and reports `failed` for it.
 */
const KEY_PATTERN = /^(?:[!-~]|[A-Za-z][A-Za-z0-9]*)$/u;

/**
 * `validateAccelerator(accelerator)` — the problem with a written accelerator, or `null` when there is none.
 *
 * F§10.3's rule is that an accelerator is a modifier and a key: a bare key would take a keystroke away from
 * every application on the desktop, and a bare modifier is not a chord at all. Beyond that this refuses what
 * cannot be read rather than what the OS may not know — an empty part, whitespace around the whole string, a
 * modifier named twice, a last part that is a modifier rather than a key.
 */
export function validateAccelerator(accelerator: string): string | null {
  if (accelerator === "") return "an accelerator needs a modifier and a key";
  if (accelerator !== accelerator.trim()) return "an accelerator cannot have whitespace around it";

  const parts = accelerator.split("+");
  const key = parts.at(-1) ?? "";
  const modifiers = parts.slice(0, -1);

  if (modifiers.length === 0) return "an accelerator needs a modifier before its key";
  if (key === "") return "an accelerator needs a key after its modifiers";
  if (MODIFIERS.has(key.toLowerCase())) return "an accelerator's last part is its key, and that is a modifier";
  if (!KEY_PATTERN.test(key)) return `"${key}" is not a key`;

  const seen = new Set<string>();
  for (const part of modifiers) {
    const canonical = MODIFIERS.get(part.toLowerCase());
    if (canonical === undefined) return `"${part}" is not a modifier`;
    if (seen.has(canonical)) return `"${part}" is named twice`;
    seen.add(canonical);
  }
  return null;
}

/**
 * `normalizeAccelerator(accelerator)` — one canonical spelling of an accelerator, for comparing two of them.
 *
 * Modifiers are filed under their canonical name, deduplicated and sorted (the order they are written in means
 * nothing to the OS), and the key is lowercased because `P` and `p` are the same key. This is for comparison
 * only: what is registered is the string the operator chose, written as they chose it.
 */
export function normalizeAccelerator(accelerator: string): string {
  const parts = accelerator.trim().split("+");
  const key = (parts.at(-1) ?? "").trim();
  const modifiers = parts.slice(0, -1).map((part) => {
    const written = part.trim();
    return (MODIFIERS.get(written.toLowerCase()) ?? written).toLowerCase();
  });
  return [...new Set(modifiers)].sort().concat(key.toLowerCase()).join("+");
}

/**
 * `findConflicts(hotkeys)` — every action that asks for an accelerator another action already asks for.
 *
 * The answer is the *later* holder of each duplicated chord, in F§10.3's own action order, so one chord shared
 * by three actions reports the two that came after the first: what the settings screen needs in order to refuse
 * the attempt that caused it. An action with no accelerator conflicts with nothing, and two empty strings are
 * not a shared chord.
 */
export function findConflicts(hotkeys: HotkeyMap): DesktopAction[] {
  const held = new Map<string, DesktopAction>();
  const conflicts: DesktopAction[] = [];
  for (const action of DESKTOP_ACTION_NAMES) {
    const accelerator = hotkeys[action];
    if (accelerator === undefined || accelerator === "") continue;
    const name = normalizeAccelerator(accelerator);
    if (held.has(name)) conflicts.push(action);
    else held.set(name, action);
  }
  return conflicts;
}

/** What a change comes to: what to give up, and what to ask for. */
export interface HotkeyDiff {
  /** The accelerators that are going away, in F§10.3's action order. */
  unregister: string[];
  /** The actions whose accelerator has to be handed over, in the same order. */
  register: DesktopAction[];
}

/**
 * `diffHotkeys(previous, next)` — the difference between the map in force and the one the operator chose.
 *
 * An action whose accelerator did not change appears in neither list, which is what keeps a change from
 * disturbing the shortcuts around it — and what keeps the shell from handing the same accelerator to the OS
 * twice, since a second registration of a chord this shell already holds answers `false` and would report a
 * working shortcut as failed.
 *
 * The two lists are meant to be applied in the order they are in: everything that is going away is given up
 * *before* anything is asked for, so two actions may swap accelerators, which a register-first order would
 * refuse.
 */
export function diffHotkeys(previous: HotkeyMap, next: HotkeyMap): HotkeyDiff {
  const unregister: string[] = [];
  const register: DesktopAction[] = [];
  for (const action of DESKTOP_ACTION_NAMES) {
    const before = previous[action] ?? "";
    const after = next[action] ?? "";
    if (before === after) continue;
    if (before !== "") unregister.push(before);
    if (after !== "") register.push(action);
  }
  return { unregister, register };
}
