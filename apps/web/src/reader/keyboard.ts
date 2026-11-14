/**
 * The reader's keyboard (F§10.1): the five keys that drive playback, turned into the command they mean.
 *
 * The function is pure — a key event's own fields and a snapshot in, one `PlayerCommand` or `null` out — so
 * every shortcut is decided without a window, a listener or a controller, and the page that owns the
 * listener is left with nothing to decide. `Esc` is deliberately not a command: F§10.1 gives it to closing
 * a panel, and F§5.7's `PlayerCommand` union has no member for that, so the view handles it itself.
 */

import { clampRate, type PlayerCommand, type PlayerSnapshot } from "@lectern/core";

/** How far F§10.1's two bracket keys move the speed. */
const SPEED_STEP = 0.1;

/** The key a space bar arrives as; `Spacebar` is the name older engines report for the same key. */
const SPACE_KEYS: readonly string[] = [" ", "Spacebar"];

/** The two decimal places a rate is kept at, so a step of a tenth cannot drift into float noise. */
const RATE_DECIMALS = 100;

/**
 * The part of a key event this module reads. A real `KeyboardEvent` satisfies it, so the page passes the
 * event it received and the tests pass a plain object — and the shortcut rules are exercised with no DOM.
 */
export interface KeyEventLike {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  target: EventTarget | null;
}

/** The elements a reader types into, where a bare key is text rather than a shortcut. */
const FIELD_TAGS: readonly string[] = ["INPUT", "TEXTAREA", "SELECT"];

/** Whether a key event's target is a field the reader is typing in. */
function isFormField(target: EventTarget | null): boolean {
  if (target === null || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return FIELD_TAGS.includes(target.tagName);
}

/** A rate moved by one step and held inside F§5.6(e)'s range. */
function stepped(rate: number, delta: number): number {
  return clampRate(Math.round((rate + delta) * RATE_DECIMALS) / RATE_DECIMALS);
}

/** The command a space bar means: play when stopped, pause when playing (F§5.7's `toggle`). */
function spaceCommand(event: KeyEventLike): PlayerCommand | null {
  return SPACE_KEYS.includes(event.key) ? { type: "toggle" } : null;
}

/** The command a bracket means, or `null` for a key this module does not bind. */
function bracketCommand(event: KeyEventLike, snapshot: PlayerSnapshot): PlayerCommand | null {
  if (event.key === "[") return { type: "setRate", rate: stepped(snapshot.rate, -SPEED_STEP) };
  if (event.key === "]") return { type: "setRate", rate: stepped(snapshot.rate, SPEED_STEP) };
  return null;
}

/** The command an arrow means: one sentence forward or back in F§5.7's playback order. */
function arrowCommand(event: KeyEventLike): PlayerCommand | null {
  if (event.key === "ArrowLeft") return { type: "skip", sentences: -1 };
  if (event.key === "ArrowRight") return { type: "skip", sentences: 1 };
  return null;
}

/**
 * `commandForKey(event, snapshot)` — F§10.1's shortcuts: `Space` toggles, `←` and `→` skip a sentence, and
 * `[` and `]` move the rate by 0.1 from the rate the snapshot reports.
 *
 * A key that carries `Alt`, `Ctrl` or `Meta` is left alone, because those combinations belong to the browser
 * and to the desktop shell's own hotkeys (F§10.3), and so is any key typed into a form field — a reader
 * filling in a bookmark note must be able to type a space.
 */
export function commandForKey(event: KeyEventLike, snapshot: PlayerSnapshot): PlayerCommand | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  if (isFormField(event.target)) return null;
  return spaceCommand(event) ?? arrowCommand(event) ?? bracketCommand(event, snapshot);
}
