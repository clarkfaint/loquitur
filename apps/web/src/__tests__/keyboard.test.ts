/**
 * The reader's shortcuts (U-029, F§10.1).
 *
 * `commandForKey` decides one key at a time and nothing else, so every binding is asserted here without a
 * window, a listener or a player: `Space` toggles, the arrows skip a sentence, the brackets move the speed by
 * a tenth, and a key that is being typed into a field — or that carries a modifier the browser and the
 * desktop shell's hotkeys own — means nothing at all.
 */

import type { PlayerSnapshot } from "@lectern/core";
import { expect, test } from "vitest";
import { commandForKey, type KeyEventLike } from "../reader/keyboard";

/** A playing snapshot at 1.5×, which is what the two bracket cases step away from. */
const SNAPSHOT: PlayerSnapshot = {
  state: "playing",
  docId: "doc-harbour",
  sentenceIndex: 3,
  wordIndex: 1,
  rate: 1.5,
  voiceId: "mock:mock-a",
  sleepRemainingMs: null,
  error: null,
};

/** The snapshot with another rate, for the cases about the ends of F§5.6(e)'s range. */
function atRate(rate: number): PlayerSnapshot {
  return { ...SNAPSHOT, rate };
}

/** One key event, with the fields a shortcut does not care about filled in. */
function key(name: string, overrides: Partial<KeyEventLike> = {}): KeyEventLike {
  return { key: name, altKey: false, ctrlKey: false, metaKey: false, target: null, ...overrides };
}

/** A field of the kind a reader types into. */
function field(tag: "input" | "textarea" | "select"): HTMLElement {
  return document.createElement(tag);
}

test("Space toggles playback", () => {
  expect(commandForKey(key(" "), SNAPSHOT)).toEqual({ type: "toggle" });
});

test("the arrows skip one sentence, back or forward", () => {
  expect(commandForKey(key("ArrowLeft"), SNAPSHOT)).toEqual({ type: "skip", sentences: -1 });
  expect(commandForKey(key("ArrowRight"), SNAPSHOT)).toEqual({ type: "skip", sentences: 1 });
});

test("the brackets move the speed by a tenth from the snapshot's own rate", () => {
  expect(commandForKey(key("["), SNAPSHOT)).toEqual({ type: "setRate", rate: 1.4 });
  expect(commandForKey(key("]"), SNAPSHOT)).toEqual({ type: "setRate", rate: 1.6 });
  expect(commandForKey(key("]"), atRate(2))).toEqual({ type: "setRate", rate: 2.1 });
});

test("a bracket at the end of F§5.6(e)'s range stays inside it", () => {
  expect(commandForKey(key("]"), atRate(5))).toEqual({ type: "setRate", rate: 5 });
  expect(commandForKey(key("["), atRate(0.5))).toEqual({ type: "setRate", rate: 0.5 });
});

test("a key typed into a form field is not a shortcut", () => {
  for (const target of [field("input"), field("textarea"), field("select")]) {
    expect(commandForKey(key(" ", { target }), SNAPSHOT)).toBeNull();
    expect(commandForKey(key("ArrowRight", { target }), SNAPSHOT)).toBeNull();
    expect(commandForKey(key("]", { target }), SNAPSHOT)).toBeNull();
  }
});

test("a key typed into an editable region is not a shortcut", () => {
  const editor = document.createElement("div");
  editor.contentEditable = "true";
  expect(editor.isContentEditable).toBe(true);
  expect(commandForKey(key(" ", { target: editor }), SNAPSHOT)).toBeNull();
});

test("a modified key is left to the browser and to the desktop shell", () => {
  expect(commandForKey(key(" ", { ctrlKey: true }), SNAPSHOT)).toBeNull();
  expect(commandForKey(key("ArrowRight", { metaKey: true }), SNAPSHOT)).toBeNull();
  expect(commandForKey(key("]", { altKey: true }), SNAPSHOT)).toBeNull();
});

test("a key this module does not bind answers nothing", () => {
  expect(commandForKey(key("a"), SNAPSHOT)).toBeNull();
  expect(commandForKey(key("Enter"), SNAPSHOT)).toBeNull();
  expect(commandForKey(key("ArrowUp"), SNAPSHOT)).toBeNull();
  // `Esc` closes a panel, which is the view's own business and not a `PlayerCommand` (F§5.7).
  expect(commandForKey(key("Escape"), SNAPSHOT)).toBeNull();
});
