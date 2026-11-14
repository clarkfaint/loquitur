/**
 * The settings screen end to end (F§10.1): the app's first load with nothing configured, a connection that is
 * saved and survives a reload, and a token the hub refuses.
 *
 * Every step goes through the screen a reader sees — the address bar, the two fields, the two buttons and the
 * status paragraph — so a passing run says the browser can reach the hub through the app's own client.
 */

import { expect, test } from "@playwright/test";
import { connect, testHub } from "./helpers";

/** A token of F§7.1's length that is not the run's. */
const WRONG_TOKEN = "e2e-wrong-token-0123456789abcdef";

test("the first load lands on settings with nothing configured", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveURL(/#\/settings$/);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connection" })).toBeVisible();
  await expect(page.locator('[role="status"][data-status="idle"]')).toContainText("No hub is configured");
  await expect(page.getByRole("heading", { name: "Playback" })).toBeVisible();
});

test("a correct URL and token show a connected state and survive a reload", async ({ page }) => {
  await connect(page);

  const hub = await testHub();
  const status = page.locator('[role="status"][data-status="connected"]');
  await expect(status).toContainText(new URL(hub.baseUrl).origin);
  await expect(status).toContainText("voices");

  await page.reload();
  await expect(page.locator('[role="status"][data-status="connected"]')).toContainText("Connected");
  await expect(page).toHaveURL(/#\/settings$/);
});

test("a wrong token shows an error and stays on settings", async ({ page }) => {
  const hub = await testHub();
  await page.goto("/#/settings");
  await page.getByLabel("Hub URL").fill(hub.baseUrl);
  await page.getByLabel("Token").fill(WRONG_TOKEN);

  // Tested before it is saved: the hub answers the health probe (F§7.2 exempts it) and refuses the token.
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.locator('[role="status"][data-status="error"]')).toContainText("UNAUTHORIZED");

  // Saved as well, so the same refusal is what a reload shows.
  await page.getByRole("button", { name: "Save" }).click();
  await page.reload();
  await expect(page.locator('[role="status"][data-status="error"]')).toContainText("UNAUTHORIZED");
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(page.locator('[role="status"][data-status="connected"]')).toHaveCount(0);
});
