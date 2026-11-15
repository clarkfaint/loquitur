/**
 * The global shortcuts' settings section (F§10.1, F§10.3): one row per trigger, the chord it answers to, what
 * the shell reports about it, and the button that puts F§10.3's defaults back.
 *
 * The section exists only inside the shell. F§10.1's settings screen is shared with the browser, where there is
 * no bridge and therefore no global shortcut at all, so the whole section renders nothing rather than a form
 * whose changes would go nowhere.
 *
 * **A row captures, it does not type.** The accelerator of each action is a read-only field that takes the next
 * key the operator presses and turns it into an accelerator — the modifiers held down, then the physical key —
 * because that is the only way to write a chord that the operator can be sure of. The chord is applied as soon
 * as it is captured, so the two refusals happen *before* anything is written: a string that is not a modifier
 * plus a key is declined, and one another action already holds is declined by name. Either way the field keeps
 * showing the accelerator that is really bound, and one sentence says why the attempt was not taken.
 *
 * The two small predicates below are this section's own copy of the shell's pure model
 * (`apps/desktop/src/main/hotkey-model.ts`): the web app has no dependency on the desktop package, and F§10.3's
 * bridge carries neither the defaults nor the predicates. The default table is repeated for the same reason,
 * since the reset control has nowhere else to read it from. §7 (2) of the evidence files the duplication.
 */

import { type DesktopAction, type DesktopSettings, type DesktopStatus, getDesktopBridge } from "@lectern/ui-web";
import { type KeyboardEvent, type ReactElement, useEffect, useState } from "react";

/** Every action this section lists, with the words it is named by, in F§10.3's own order. */
const ACTIONS: { action: DesktopAction; label: string }[] = [
  { action: "readSelection", label: "Read selection" },
  { action: "readRegion", label: "Read screen region" },
  { action: "togglePlay", label: "Play or pause" },
  { action: "nextSentence", label: "Next sentence" },
  { action: "previousSentence", label: "Previous sentence" },
  { action: "faster", label: "Speed up" },
  { action: "slower", label: "Slow down" },
  { action: "toggleMini", label: "Show or hide the mini-player" },
  { action: "showMain", label: "Show the main window" },
];

/** F§10.3's default accelerators, verbatim — what the reset control puts back. */
const DEFAULT_HOTKEYS: Record<DesktopAction, string> = {
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

/** Every spelling Electron accepts for a modifier, under the name this section compares them by. */
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

/** What a key may look like: one printable character, or a name of letters and digits. */
const KEY_PATTERN = /^(?:[!-~]|[A-Za-z][A-Za-z0-9]*)$/u;

/** The keys that are only ever modifiers: pressing one of them asks for no chord yet. */
const BARE_MODIFIERS = new Set(["Control", "Alt", "Shift", "Meta", "AltGraph"]);

/** The problem with a written accelerator, or `null` when there is none (F§10.3's modifier-and-key rule). */
function validateAccelerator(accelerator: string): string | null {
  if (accelerator === "") return "an accelerator needs a modifier and a key";
  const parts = accelerator.split("+");
  const key = parts.at(-1) ?? "";
  const modifiers = parts.slice(0, -1);
  if (modifiers.length === 0) return "an accelerator needs a modifier before its key";
  if (key === "" || MODIFIERS.has(key.toLowerCase())) return "an accelerator needs a key after its modifiers";
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

/** One canonical spelling of an accelerator, so `Ctrl+Alt+R` and `Control+Alt+R` compare equal. */
function normalizeAccelerator(accelerator: string): string {
  const parts = accelerator.split("+");
  const key = (parts.at(-1) ?? "").toLowerCase();
  const modifiers = parts.slice(0, -1).map((part) => (MODIFIERS.get(part.toLowerCase()) ?? part).toLowerCase());
  return [...new Set(modifiers)].sort().concat(key).join("+");
}

/** The key a captured chord names (the physical key, so the layout and the shift state cannot move it). */
function keyName(event: KeyboardEvent<HTMLInputElement>): string {
  const { code } = event;
  if (/^Key[A-Z]$/u.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/u.test(code)) return code.slice(5);
  const named =
    /^(?:Arrow(?:Up|Down|Left|Right)|Space|Escape|Tab|Enter|Backspace|Delete|Insert|Home|End|PageUp|PageDown|F(?:[1-9]|1[0-9]|2[0-4]))$/u;
  if (named.test(code)) return code.replace("Arrow", "");
  return event.key.length === 1 ? event.key.toUpperCase() : event.key;
}

/** The chord a key event is asking for, written the way Electron writes an accelerator. */
function chordFor(event: KeyboardEvent<HTMLInputElement>): string {
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push("Control");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (event.metaKey) modifiers.push("Super");
  return [...modifiers, keyName(event)].join("+");
}

/** The action already holding an accelerator, or `null` when no other action does. */
function holderOf(hotkeys: Record<DesktopAction, string>, action: DesktopAction, accelerator: string): DesktopAction | null {
  const wanted = normalizeAccelerator(accelerator);
  for (const candidate of ACTIONS) {
    if (candidate.action === action) continue;
    const held = hotkeys[candidate.action];
    if (held !== "" && normalizeAccelerator(held) === wanted) return candidate.action;
  }
  return null;
}

/** The words for a state the shell reports (F§10.3). */
function describeState(state: DesktopStatus["hotkeys"][DesktopAction]): string {
  if (state === "registered") return "Registered";
  return state === "failed" ? "Could not be registered" : "Not registered yet";
}

/** The words for a failure. */
function describeFailure(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function HotkeysSection(): ReactElement | null {
  const [bridge] = useState(() => getDesktopBridge());
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // Subscribing before reading is what makes the order safe: the shell re-announces its status as part of
  // answering the read, so a page that mounts late is told what the shell holds rather than waiting for the
  // next change to hear about it.
  useEffect(() => {
    if (bridge === null) return;
    const stop = bridge.settings.onStatus(setStatus);
    let live = true;
    void bridge.settings
      .get()
      .then((record) => {
        if (live) setSettings(record);
      })
      .catch((cause: unknown) => {
        if (live) setProblem(describeFailure(cause));
      });
    return () => {
      live = false;
      stop();
    };
  }, [bridge]);

  if (bridge === null) return null;

  /** Take one captured chord: refuse it if it cannot be used, otherwise write it and let the shell bind it. */
  const capture =
    (action: DesktopAction) =>
    (event: KeyboardEvent<HTMLInputElement>): void => {
      if (BARE_MODIFIERS.has(event.key)) return;
      event.preventDefault();
      if (settings === null) return;
      const accelerator = chordFor(event);
      const refused = validateAccelerator(accelerator);
      if (refused !== null) {
        setProblem(`"${accelerator}" was not used: ${refused}.`);
        return;
      }
      const holder = holderOf(settings.hotkeys, action, accelerator);
      if (holder !== null) {
        setProblem(
          `"${accelerator}" was not used: ${ACTIONS.find((entry) => entry.action === holder)?.label ?? holder} already answers to it.`,
        );
        return;
      }
      setProblem(null);
      void bridge.settings
        .set({ hotkeys: { ...settings.hotkeys, [action]: accelerator } })
        .then(setSettings)
        .catch((cause: unknown) => {
          setProblem(describeFailure(cause));
        });
    };

  /** Put F§10.3's defaults back, exactly as a captured chord would: one ordinary write to the record. */
  const reset = (): void => {
    setProblem(null);
    void bridge.settings
      .set({ hotkeys: { ...DEFAULT_HOTKEYS } })
      .then(setSettings)
      .catch((cause: unknown) => {
        setProblem(describeFailure(cause));
      });
  };

  return (
    <div className="lectern-hotkeys" data-hotkeys-section>
      {ACTIONS.map(({ action, label }) => (
        <div className="lectern-settings__field lectern-hotkeys__row" key={action} data-hotkey-row={action}>
          <label htmlFor={`lectern-hotkey-${action}`}>{label}</label>
          <input
            aria-describedby={`lectern-hotkey-state-${action}`}
            data-hotkey-capture={action}
            id={`lectern-hotkey-${action}`}
            name={action}
            onKeyDown={capture(action)}
            placeholder="Not bound"
            readOnly
            type="text"
            value={settings?.hotkeys[action] ?? ""}
          />
          <span className="lectern-hotkeys__state" data-hotkey-status={action} data-state={status?.hotkeys[action] ?? "pending"}>
            <span id={`lectern-hotkey-state-${action}`}>{describeState(status?.hotkeys[action] ?? "pending")}</span>
          </span>
        </div>
      ))}

      <div className="lectern-settings__actions">
        <button onClick={reset} type="button">
          Reset to defaults
        </button>
      </div>

      {problem === null ? null : (
        <p className="lectern-settings__status lectern-hotkeys__problem" data-hotkey-problem data-status="error" role="status">
          {problem}
        </p>
      )}
    </div>
  );
}
