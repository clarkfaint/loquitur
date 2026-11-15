/**
 * The global shortcuts, end to end (F§10.3, F§13 phase 3).
 *
 * These cases drive the built application under a real display, and the question they ask is the one only a
 * running shell can answer: whether the operating system is really holding the chords, and whether changing one
 * in the settings screen really moves the shell's hold on it. So every fact about a registration is read in the
 * *main process* — `globalShortcut.isRegistered`, evaluated there — and every fact about the screen is read from
 * its own page.
 *
 * A chord is captured the way the operator captures one: the field is focused and the keys are pressed. That
 * the chord then really fires its action is not asserted here and cannot be — a global shortcut needs the window
 * manager to deliver a keystroke, which a synthetic key event does not do — and the action a chord raises is
 * `./ipc`'s one bus call, which U-039's own cases already exercise from the same bus.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, _electron as electron, expect, type Locator, type Page, test } from "@playwright/test";
import { closeApp, launchApp, openScreen, shellArguments, shellEnvironment } from "./launch";

/** F§10.3's seven bound actions and their default accelerators, in the shell's own order. */
const DEFAULTS: { action: string; accelerator: string }[] = [
  { action: "readSelection", accelerator: "Ctrl+Alt+R" },
  { action: "readRegion", accelerator: "Ctrl+Alt+S" },
  { action: "togglePlay", accelerator: "Ctrl+Alt+Space" },
  { action: "nextSentence", accelerator: "Ctrl+Alt+Right" },
  { action: "previousSentence", accelerator: "Ctrl+Alt+Left" },
  { action: "faster", accelerator: "Ctrl+Alt+Up" },
  { action: "slower", accelerator: "Ctrl+Alt+Down" },
];

/** Which of these accelerators the shell holds, asked where they are registered. */
function held(app: ElectronApplication, accelerators: string[]): Promise<boolean[]> {
  return app.evaluate(({ globalShortcut }, wanted) => wanted.map((accelerator) => globalShortcut.isRegistered(accelerator)), accelerators);
}

/** The settings screen's section for the shortcuts. */
function section(window: Page): Locator {
  return window.locator("[data-hotkeys-section]");
}

/** One action's row, as the operator sees it. */
function row(window: Page, action: string): Locator {
  return section(window).locator(`[data-hotkey-row="${action}"]`);
}

/** Capture a chord into one action, as the operator does: focus the field, then press the keys. */
async function capture(window: Page, action: string, chord: string): Promise<void> {
  await section(window).locator(`[data-hotkey-capture="${action}"]`).click();
  await window.keyboard.press(chord);
}

/** The shell's own record, read from the user-data directory the launch was given. */
async function recordHotkeys(userData: string): Promise<Record<string, string> | null> {
  try {
    const text = await readFile(join(userData, "desktop-settings.json"), "utf8");
    return (JSON.parse(text) as { hotkeys: Record<string, string> }).hotkeys;
  } catch {
    return null;
  }
}

test("the shell holds every default shortcut, and the settings section shows what it holds", async () => {
  const { app, window } = await launchApp();
  try {
    // Read in the main process, because that is where a global shortcut lives — and the first registration
    // happens after the shell is ready, so the answer is waited for rather than read once.
    const defaults = DEFAULTS.map((entry) => entry.accelerator);
    await expect.poll(async () => held(app, defaults)).toEqual(defaults.map(() => true));
    // A chord nobody configured is not a shortcut of this shell.
    expect(await held(app, ["Control+Alt+P"])).toEqual([false]);

    await openScreen(window, "#/settings");
    await expect(row(window, "togglePlay").locator("input")).toHaveValue("Ctrl+Alt+Space");
    // The shell's account of each action is shown beside it: the seven it bound, and the two F§10.3 leaves to
    // the tray and the mini-player.
    for (const entry of DEFAULTS) {
      await expect(section(window).locator(`[data-hotkey-status="${entry.action}"]`)).toHaveAttribute("data-state", "registered");
    }
    await expect(section(window).locator('[data-hotkey-status="toggleMini"]')).toHaveAttribute("data-state", "pending");
    await expect(section(window).getByRole("button", { name: "Reset to defaults" })).toBeVisible();
  } finally {
    await closeApp(app);
  }
});

test("changing play/pause through the settings section re-registers it, and the change survives a restart", async () => {
  const { app, window, userData } = await launchApp();
  try {
    await openScreen(window, "#/settings");
    await expect(row(window, "togglePlay").locator("input")).toHaveValue("Ctrl+Alt+Space");

    await capture(window, "togglePlay", "Control+Alt+P");
    await expect(row(window, "togglePlay").locator("input")).toHaveValue("Control+Alt+P");

    // The chord changed hands in the shell: the old one is given up and the new one held.
    await expect.poll(async () => held(app, ["Ctrl+Alt+Space", "Control+Alt+P"])).toEqual([false, true]);
    // ...and the six the operator did not touch are still held.
    expect(
      await held(
        app,
        DEFAULTS.filter((entry) => entry.action !== "togglePlay").map((entry) => entry.accelerator),
      ),
    ).toEqual([true, true, true, true, true, true]);
    // The change is in the record, which is what a restart reads.
    await expect.poll(async () => (await recordHotkeys(userData))?.togglePlay).toBe("Control+Alt+P");
  } finally {
    await closeApp(app);
  }

  // A second launch of the same shell, with the same user-data directory.
  const second = await electron.launch({ args: shellArguments(), env: shellEnvironment(userData) });
  try {
    await second.firstWindow();
    await expect.poll(async () => held(second, ["Control+Alt+P", "Ctrl+Alt+Space"])).toEqual([true, false]);
  } finally {
    await closeApp(second);
  }
});

test("an accelerator that cannot be used is refused in the settings section, and nothing is written", async () => {
  const { app, window, userData } = await launchApp();
  try {
    await openScreen(window, "#/settings");
    await expect(row(window, "togglePlay").locator("input")).toHaveValue("Ctrl+Alt+Space");

    // A chord another action already holds: Read selection has Ctrl+Alt+R, so Play/pause cannot have it too.
    await capture(window, "togglePlay", "Control+Alt+R");
    await expect(section(window).locator("[data-hotkey-problem]")).toContainText("Read selection");
    await expect(row(window, "togglePlay").locator("input")).toHaveValue("Ctrl+Alt+Space");
    // Both chords are still the shell's, and nothing was written at all: a refused chord never reaches the
    // record, which in this run does not exist yet — no settings change has been accepted.
    expect(await held(app, ["Ctrl+Alt+R", "Ctrl+Alt+Space"])).toEqual([true, true]);
    expect(await recordHotkeys(userData)).toBeNull();

    // A bare key is not an accelerator either (F§10.3's chords carry a modifier).
    await capture(window, "togglePlay", "p");
    await expect(section(window).locator("[data-hotkey-problem]")).toContainText("modifier");
    await expect(row(window, "togglePlay").locator("input")).toHaveValue("Ctrl+Alt+Space");
    expect(await held(app, ["Ctrl+Alt+Space"])).toEqual([true]);
    expect(await recordHotkeys(userData)).toBeNull();
  } finally {
    await closeApp(app);
  }
});
