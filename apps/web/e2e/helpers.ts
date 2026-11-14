/**
 * The browser tests' shared steps (F§10.1).
 *
 * `connect` is the way into the app: there is no other. The hub's address is typed into the settings screen
 * exactly as an operator would type it, and the connected state is waited for rather than assumed, so a run
 * that cannot reach the test hub fails here instead of somewhere later and less clearly.
 *
 * `importText` (this unit) is the way into a library: text a reader pastes is read by the hub exactly as a
 * file would be, so a fixture that needs a document in the library needs no fixture file.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";

/** What the run's `global-setup.ts` wrote: the hub the tests talk to. */
export interface TestHub {
  baseUrl: string;
  token: string;
}

/** Where the hub's address and token are written. */
const HUB_FILE = fileURLToPath(new URL("./.hub.local", import.meta.url));

/** The hub this run started, as `global-setup.ts` left it. */
export async function testHub(): Promise<TestHub> {
  return JSON.parse(await readFile(HUB_FILE, "utf8")) as TestHub;
}

/** The status paragraph's states, as the settings screen writes them. */
const STATUS = (kind: "idle" | "testing" | "connected" | "error") => `[role="status"][data-status="${kind}"]`;

/**
 * `connect(page)` — open the settings screen, save the run's hub and token, and wait for the connected state.
 * A later unit's `importText(page, title, text)` starts from here.
 */
export async function connect(page: Page, overrides: { hubUrl?: string; token?: string } = {}): Promise<void> {
  const hub = await testHub();
  await page.goto("/#/settings");
  await page.getByLabel("Hub URL").fill(overrides.hubUrl ?? hub.baseUrl);
  await page.getByLabel("Token").fill(overrides.token ?? hub.token);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(STATUS("connected"))).toBeVisible();
}

/**
 * `importText(page, title, text)` — paste a document into the library. The screen starts a fresh list of
 * imports on every visit, so the row that has to be `done` is the one this call just added and not one an
 * earlier call left behind.
 */
export async function importText(page: Page, title: string, text: string): Promise<void> {
  await page.goto("/#/import");
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByLabel("Text", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Import text" }).click();
  await expect(page.locator("[data-import-item]").last()).toHaveAttribute("data-status", "done");
}
