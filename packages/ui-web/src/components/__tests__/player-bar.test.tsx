/**
 * The player bar's behaviour, from a user's side (F§10.1, F§5.7): every control is found the way a
 * screen reader finds it — by its accessible name — and the assertion is always the command the bar
 * emitted to the player it does not own.
 */

import type { PlayerCommand, PlayerSnapshot } from "@lectern/core";
import { RATE_MAX } from "@lectern/core";
import type { Voice } from "@lectern/core-tts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PlayerBar } from "../PlayerBar";

const VOICES: Voice[] = [
  { id: "mock:mock-a", engine: "mock", engineVoiceId: "mock-a", name: "Mock A", lang: "en" },
  { id: "mock:mock-b", engine: "mock", engineVoiceId: "mock-b", name: "Mock B", lang: "en" },
];

/** A snapshot in the state a case is about; every other field is the reader at rest. */
function snapshot(overrides: Partial<PlayerSnapshot> = {}): PlayerSnapshot {
  return {
    state: "paused",
    docId: "doc-1",
    sentenceIndex: 3,
    wordIndex: 0,
    rate: 1,
    voiceId: "mock:mock-a",
    sleepRemainingMs: null,
    error: null,
    ...overrides,
  };
}

/** Render the bar and collect every command it emits. */
function renderBar(
  snapshotOverrides: Partial<PlayerSnapshot> = {},
  barOverrides: { progressFraction?: number; remainingMs?: number } = {},
): PlayerCommand[] {
  const commands: PlayerCommand[] = [];
  render(
    <PlayerBar
      baseWpm={170}
      onCommand={(command) => commands.push(command)}
      progressFraction={barOverrides.progressFraction ?? 0.25}
      remainingMs={barOverrides.remainingMs ?? 720_000}
      snapshot={snapshot(snapshotOverrides)}
      variant="full"
      voices={VOICES}
    />,
  );
  return commands;
}

afterEach(cleanup);

describe("PlayerBar transport", () => {
  it("asks to play when the snapshot is paused", () => {
    const commands = renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(commands).toEqual([{ type: "play" }]);
  });

  it("asks to pause when the snapshot is playing", () => {
    const commands = renderBar({ state: "playing" });
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(commands).toEqual([{ type: "pause" }]);
  });

  it("skips one sentence back and one forward", () => {
    const commands = renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Previous sentence" }));
    fireEvent.click(screen.getByRole("button", { name: "Next sentence" }));
    expect(commands).toEqual([
      { type: "skip", sentences: -1 },
      { type: "skip", sentences: 1 },
    ]);
  });
});

describe("PlayerBar speed control", () => {
  it("sets the rate a preset button names", () => {
    const commands = renderBar();
    fireEvent.click(screen.getByRole("button", { name: "4.5×" }));
    expect(commands).toEqual([{ type: "setRate", rate: 4.5 }]);
  });

  it("refuses a slider value above the highest rate the reader offers", () => {
    const commands = renderBar();
    const slider = screen.getByRole("slider", { name: "Playback speed" });
    fireEvent.change(slider, { target: { value: String(RATE_MAX + 0.5) } });
    expect(commands).toEqual([{ type: "setRate", rate: RATE_MAX }]);
  });

  it("shows the multiplier and the words per minute the rate implies", () => {
    renderBar({ rate: 1.5 });
    expect(screen.getByText("255 wpm")).toBeTruthy();
    const slider = screen.getByRole("slider", { name: "Playback speed" });
    expect(slider.getAttribute("aria-valuetext")).toBe("1.5×, 255 wpm");
  });
});

describe("PlayerBar voice picker", () => {
  it("sets the voice a listed option names", () => {
    const commands = renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Mock B" }));
    expect(commands).toEqual([{ type: "setVoice", voiceId: "mock:mock-b" }]);
  });

  it("groups the voices by language and engine", () => {
    renderBar();
    expect(screen.getByRole("group", { name: "en mock" })).toBeTruthy();
  });

  it("filters the list down to the voices whose name matches", () => {
    renderBar();
    fireEvent.change(screen.getByRole("searchbox", { name: "Voice" }), { target: { value: "Mock B" } });
    expect(screen.queryByRole("button", { name: "Mock A" })).toBeNull();
    expect(screen.getByRole("button", { name: "Mock B" })).toBeTruthy();
  });
});

describe("PlayerBar sleep timer", () => {
  it("sets the timer a listed choice names", () => {
    const commands = renderBar();
    fireEvent.click(screen.getByRole("button", { name: "15 min" }));
    expect(commands).toEqual([{ type: "setSleep", minutes: 15 }]);
  });

  it("turns the timer off", () => {
    const commands = renderBar({ sleepRemainingMs: 600_000 });
    expect(screen.getByText("10 min")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Off" }));
    expect(commands).toEqual([{ type: "setSleep", minutes: null }]);
  });
});

describe("PlayerBar readouts", () => {
  it("shows a spinner while the audio is loading or buffering", () => {
    renderBar({ state: "buffering" });
    expect(screen.getByRole("status", { name: "Loading audio" })).toBeTruthy();
    cleanup();
    renderBar({ state: "loading" });
    expect(screen.getByRole("status", { name: "Loading audio" })).toBeTruthy();
  });

  it("shows no spinner while playing", () => {
    renderBar({ state: "playing" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the error message the player reported", () => {
    renderBar({ state: "error", error: { code: "ENGINE_UNAVAILABLE", message: "The engine is not reachable." } });
    expect(screen.getByRole("alert").textContent).toBe("The engine is not reachable.");
  });

  it("reports progress and the time remaining to assistive technology", () => {
    renderBar({}, { progressFraction: 0.42 });
    expect(screen.getByRole("progressbar", { name: "Playback progress" }).getAttribute("aria-valuenow")).toBe("42");
    expect(screen.getByText("12 min")).toBeTruthy();
  });

  it("gives every button an accessible name", () => {
    renderBar();
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBe(15);
    for (const button of buttons) {
      const name = (button.getAttribute("aria-label") ?? button.textContent ?? "").trim();
      expect(name).not.toBe("");
      expect(screen.getByRole("button", { name })).toBe(button);
    }
  });
});

describe("PlayerBar compact variant", () => {
  it("keeps the transport and the clock and drops the panels", () => {
    const commands: PlayerCommand[] = [];
    render(
      <PlayerBar
        baseWpm={170}
        onCommand={(command) => commands.push(command)}
        progressFraction={0.5}
        remainingMs={60_000}
        snapshot={snapshot({ state: "playing", rate: 2 })}
        variant="compact"
        voices={VOICES}
      />,
    );
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(screen.queryByRole("slider", { name: "Playback speed" })).toBeNull();
    expect(screen.queryByRole("searchbox", { name: "Voice" })).toBeNull();
    expect(screen.queryByRole("button", { name: "15 min" })).toBeNull();
    expect(screen.getByText("340 wpm")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next sentence" }));
    expect(commands).toEqual([{ type: "skip", sentences: 1 }]);
  });
});
