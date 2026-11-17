/**
 * Summaries, end to end (F§9, F§10.1): the reader's Summarize control, the summary drawer, and the four things
 * the contract asks of them — a running state then a result in brief mode, a second result in detailed mode, a
 * cached result when the drawer is reopened, a summary that is filed in `Summaries` and read aloud, and a
 * document the model cannot answer for ending in the error state with a retry.
 *
 * The hub this run started has F§9's mock LLM behind it — `global-setup.ts` names its address in F§7.1's
 * `LLM_BASE_URL` — so a summary is really asked for and really written. The reply is steered the way F§9's own
 * rules steer it: a document whose text carries `FORCE_INVALID` makes the endpoint answer something that is not
 * JSON, which the hub retries and then records as a failure.
 *
 * Every case imports a document of its own text: an import of a document the library already holds writes
 * nothing and is reported as a duplicate, so two cases sharing one text would share one document.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { connect, importText } from "./helpers";

/** A summary is a job on the hub, a poll, and a model call, so the budget is generous. */
test.setTimeout(120_000);

/** The document the first case summarizes: short sentences, written for this test. */
const BRIEF_TITLE = "Quay Notes";
const BRIEF_TEXT = [
  "The quay is quiet before the tide turns.",
  "A gull lands on the bollard and stays.",
  "The water keeps its own slow count.",
  "Nobody is in a hurry here.",
].join(" ");

/** The document the second case summarizes: its own text, so it is a document of its own. */
const LISTEN_TITLE = "Mill Notes";
const LISTEN_TEXT = [
  "The mill wheel is still under the moss.",
  "Swallows cross the empty yard.",
  "The channel holds a shallow brown water.",
  "The day is warm and slow.",
].join(" ");

/** The document whose text makes F§9's endpoint answer invalidly, which is a job the hub cannot finish. */
const BROKEN_TITLE = "Broken Notes";
const BROKEN_TEXT = [
  "The FORCE_INVALID marker makes this document unspeakable to the model.",
  "Nothing here can be summarized at all.",
].join(" ");

/** Open a document in the reader, and answer its `docId` as the reader's own address carries it. */
async function open(page: Page, title: string, text: string): Promise<string> {
  await importText(page, title, text);
  await page.goto("/#/library");
  await page.getByRole("link", { name: title, exact: true }).click();
  await expect(page).toHaveURL(/#\/read\//);
  const match = /#\/read\/([^?]+)/u.exec(page.url());
  if (match === null || match[1] === undefined) throw new Error(`the reader did not open: ${page.url()}`);
  return decodeURIComponent(match[1]);
}

/** The summary drawer, opened from the reader's own control. */
async function openDrawer(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Summarize" }).click();
  const drawer = page.getByRole("complementary", { name: "Summary" });
  await expect(drawer).toBeVisible();
  return drawer;
}

test("brief and detailed summaries, and a reopen that shows the cached one", async ({ page }) => {
  await connect(page);
  await open(page, BRIEF_TITLE, BRIEF_TEXT);
  const drawer = await openDrawer(page);
  await expect(drawer.locator('[data-summary-state="none"]')).toBeVisible();

  await drawer.getByRole("button", { name: "Generate summary" }).click();
  await expect(drawer.locator('[data-summary-state="running"]')).toBeVisible();
  await expect(drawer.locator('[data-summary-state="done"]')).toBeVisible({ timeout: 60_000 });

  const brief = await drawer.locator("[data-takeaway]").allTextContents();
  expect(brief.length).toBeGreaterThanOrEqual(3);
  const briefText = await drawer.locator("[data-summary-text]").textContent();
  expect(briefText?.trim()).not.toBe("");
  await expect(drawer.locator("[data-summary-model]")).not.toBeEmpty();

  // The other length is a different job with a result of its own.
  await drawer.getByRole("button", { name: "Detailed" }).click();
  await expect(drawer.locator('[data-summary-state="none"]')).toBeVisible();
  await drawer.getByRole("button", { name: "Generate summary" }).click();
  await expect(drawer.locator('[data-summary-state="done"]')).toBeVisible({ timeout: 60_000 });
  const detailed = await drawer.locator("[data-takeaway]").allTextContents();
  expect(detailed.length).toBeGreaterThan(brief.length);
  expect(await drawer.locator("[data-summary-text]").textContent()).not.toBe(briefText);

  // Reopening reads the hub rather than asking it again: the brief result is drawn, and nothing runs.
  await drawer.getByRole("button", { name: "Close summary" }).click();
  await expect(page.getByRole("complementary", { name: "Summary" })).toHaveCount(0);
  const reopened = await openDrawer(page);
  await expect(reopened.locator('[data-summary-state="done"]')).toBeVisible();
  await expect(reopened.locator('[data-summary-state="running"]')).toHaveCount(0);
  expect(await reopened.locator("[data-takeaway]").allTextContents()).toEqual(brief);
});

test("listening to a summary files it in Summaries and reads it", async ({ page }) => {
  await connect(page);
  await open(page, LISTEN_TITLE, LISTEN_TEXT);
  const drawer = await openDrawer(page);
  await drawer.getByRole("button", { name: "Generate summary" }).click();
  await expect(drawer.locator('[data-summary-state="done"]')).toBeVisible({ timeout: 60_000 });

  // F§9's listen control is only offered once there is something to read.
  const listen = drawer.getByRole("button", { name: "Listen" });
  await expect(listen).toBeEnabled();
  await listen.click();

  // F§10.1's `?autoplay=1`: the summary opens as a document and starts reading itself.
  await expect(page).toHaveURL(/#\/read\/[0-9a-f]{32}\?autoplay=1/u);
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 30_000 });

  // It is filed in a folder of its own, under the name of the document it summarizes.
  await page.goto("/#/library");
  await expect(page.locator(".lectern-library__folder-row[data-folder-id]", { hasText: "Summaries" })).toHaveCount(1);
  await expect(page.getByRole("link", { name: `Summary of ${LISTEN_TITLE}`, exact: true })).toBeVisible();
});

test("a document the model cannot answer for ends in the error state with a retry", async ({ page }) => {
  await connect(page);
  await open(page, BROKEN_TITLE, BROKEN_TEXT);
  const drawer = await openDrawer(page);
  await drawer.getByRole("button", { name: "Generate summary" }).click();

  await expect(drawer.locator('[data-summary-state="running"]')).toBeVisible();
  await expect(drawer.locator('[data-summary-state="error"]')).toBeVisible({ timeout: 60_000 });
  await expect(drawer.getByRole("alert")).not.toBeEmpty();
  await expect(drawer.getByRole("button", { name: "Retry" })).toBeEnabled();
  await expect(drawer.getByRole("button", { name: "Listen" })).toBeDisabled();
});
