/**
 * The floating widget, end to end (F§10.2, F§13 phase 2).
 *
 * One case drives the whole path this unit builds, and two more cover the two things a widget on somebody
 * else's page has to get right — being moved, and being switched off. The first case is the reading: the
 * widget appears on load because the reader's own settings ask for it, its play control starts a reading that
 * the offscreen document plays through the hub's mock engine, the page's own word highlight appears, pause
 * stops the sentence the player reports from moving, and the speed control's `3×` preset is what the player
 * reports next.
 *
 * Three platform facts decide how the cases are written. The page's own world has no `chrome` object, so every
 * assertion about the *page* is made with `page.evaluate` and every assertion about the *extension* is made
 * through the worker or a `chrome-extension://` page. An unpacked extension is only loaded into the persistent
 * context the fixture builds, which is why the widget can be driven with ordinary mouse events at all. And the
 * settings record the fixture writes turns the widget off, so each case turns it on the way the popup's form
 * would — through `chrome.storage` — and then reloads the page the widget is expected on.
 *
 * The snapshot numbers are read from the worker, not from the page: `ext/snapshot` is what the offscreen
 * document publishes (F§5.7), and the worker is the context every copy passes through.
 */

import type { PlayerSnapshot } from "@lectern/core";
import type { Locator, Page, Worker } from "@playwright/test";
import { expect, test, testEnvironment } from "./fixtures";

/** The key the extension's settings record lives under (`apps/extension/src/settings.ts`). */
const SETTINGS_KEY = "lectern.extension.settings";

/** How long a case waits for the player to reach a state, and for the page to catch up with it. */
const OBSERVE_MS = 30_000;

/** How long the paused player is watched before its sentence index is called frozen. */
const PAUSE_MS = 3_000;

/** The widget's host element, as the page's own document has it. */
function widget(page: Page): Locator {
  return page.locator("lectern-widget");
}

/** The text of the registered word highlight, or `null` while nothing is highlighting a word. */
async function highlightedWord(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    const highlight = CSS.highlights.get("lectern-word");
    if (highlight === undefined) return null;
    for (const range of highlight) return range.toString();
    return null;
  });
}

/** The article's own markup: the widget sits outside it, and the reading must not edit it either way. */
async function articleHtml(page: Page): Promise<string> {
  return await page.evaluate(() => document.querySelector("article")?.innerHTML ?? "");
}

/** Turn the widget's auto-show setting on, as the popup's own form would. */
async function autoShowWidget(worker: Worker): Promise<void> {
  const written = await worker.evaluate(async (key) => {
    const stored = (await chrome.storage.local.get(key)) as Record<string, unknown>;
    const record = (stored[key] ?? {}) as Record<string, unknown>;
    await chrome.storage.local.set({ [key]: { ...record, autoShowWidget: true } });
    const read = (await chrome.storage.local.get(key)) as Record<string, { autoShowWidget?: boolean } | undefined>;
    return read[key]?.autoShowWidget ?? false;
  }, SETTINGS_KEY);
  if (!written) throw new Error("the settings record did not take autoShowWidget");
}

/** The host names the settings record has switched the widget off for. */
async function disabledSites(worker: Worker): Promise<string[]> {
  return await worker.evaluate(async (key) => {
    const stored = (await chrome.storage.local.get(key)) as Record<string, { disabledSites?: string[] } | undefined>;
    return stored[key]?.disabledSites ?? [];
  }, SETTINGS_KEY);
}

/** Record every snapshot the worker receives, so a case can read the player's own numbers. */
async function recordSnapshots(worker: Worker): Promise<void> {
  await worker.evaluate(() => {
    globalThis.__lecternWidgetSnapshots = [];
    chrome.runtime.onMessage.addListener((raw: unknown) => {
      const message = raw as { type?: string; snapshot?: PlayerSnapshot } | null;
      if (message?.type === "ext/snapshot" && message.snapshot !== undefined) {
        globalThis.__lecternWidgetSnapshots?.push(message.snapshot);
      }
    });
  });
}

/** The last snapshot the worker received, or `null` before the first. */
async function latest(worker: Worker): Promise<PlayerSnapshot | null> {
  const snapshots = await worker.evaluate(() => globalThis.__lecternWidgetSnapshots ?? []);
  return snapshots[snapshots.length - 1] ?? null;
}

declare global {
  /** The snapshots the service worker received, recorded by `recordSnapshots`. */
  var __lecternWidgetSnapshots: PlayerSnapshot[] | undefined;
}

test("offers one widget, reads the page from it, pauses where it is and takes a new speed", async ({
  context,
  serviceWorker,
  configure,
}) => {
  await configure();
  await autoShowWidget(serviceWorker);
  const environment = await testEnvironment();

  const page = await context.newPage();
  await page.goto(`${environment.pagesUrl}/article.html`);

  // The widget is offered on load — exactly once — and the page it sits on is untouched by that.
  const host = widget(page);
  await expect(host).toHaveCount(1);
  await expect(host).toBeVisible();
  const article = await articleHtml(page);
  expect(article.length).toBeGreaterThan(0);

  await recordSnapshots(serviceWorker);

  // The play control starts the reading: the page's own word highlight appears, and the page is still the
  // page it was — the widget adds a host element and nothing else.
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => await highlightedWord(page), { timeout: OBSERVE_MS }).not.toBeNull();
  await expect.poll(async () => (await latest(serviceWorker))?.state, { timeout: OBSERVE_MS }).toBe("playing");
  expect(await articleHtml(page)).toBe(article);
  await expect(host).toHaveCount(1);

  // The speed control's `3×` preset is a command to the player, and the next snapshot is where it shows.
  await page.getByRole("button", { name: "Expand the player" }).click();
  await page.getByRole("button", { name: "3×", exact: true }).click();
  await expect.poll(async () => (await latest(serviceWorker))?.rate, { timeout: OBSERVE_MS }).toBe(3);

  // The reading is really moving before it is paused, or "pause freezes it" would be true of a player that
  // had never started.
  await expect.poll(async () => (await latest(serviceWorker))?.sentenceIndex ?? 0, { timeout: OBSERVE_MS }).toBeGreaterThan(0);

  // Back to the pill, and pause: the sentence the player reports stops moving, and the page is unchanged.
  await page.getByRole("button", { name: "Collapse the player" }).click();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(async () => (await latest(serviceWorker))?.state, { timeout: OBSERVE_MS }).toBe("paused");
  const frozen = (await latest(serviceWorker))?.sentenceIndex;
  expect(frozen).toBeGreaterThan(0);
  await page.waitForTimeout(PAUSE_MS);
  expect((await latest(serviceWorker))?.sentenceIndex).toBe(frozen);
  expect(await articleHtml(page)).toBe(article);
});

test("moves the widget by its grip, and leaves it where it was put", async ({ context, serviceWorker, configure }) => {
  await configure();
  await autoShowWidget(serviceWorker);
  const environment = await testEnvironment();

  const page = await context.newPage();
  await page.goto(`${environment.pagesUrl}/article.html`);
  const host = widget(page);
  await expect(host).toBeVisible();
  // The default corner is measured rather than assumed: the widget is placed once the browser has laid it out.
  await expect.poll(async () => Math.round((await host.boundingBox())?.x ?? -1)).toBeGreaterThanOrEqual(0);
  const from = await host.boundingBox();
  if (from === null) throw new Error("the widget host has no box");

  const grip = page.locator("lectern-widget button[aria-label='Move the player']");
  const hold = await grip.boundingBox();
  if (hold === null) throw new Error("the widget's grip has no box");
  await page.mouse.move(hold.x + hold.width / 2, hold.y + hold.height / 2);
  await page.mouse.down();
  await page.mouse.move(hold.x + hold.width / 2 + 140, hold.y + hold.height / 2 - 90, { steps: 10 });
  await page.mouse.up();

  await expect.poll(async () => Math.round((await host.boundingBox())?.x ?? 0)).toBeGreaterThan(Math.round(from.x) + 100);
  const landed = await host.boundingBox();
  if (landed === null) throw new Error("the widget host has no box after the drag");
  expect(Math.round(landed.y)).toBeLessThan(Math.round(from.y));
  // It is still wholly inside the viewport, which is the one promise the drag makes.
  const view = page.viewportSize();
  if (view === null) throw new Error("the context has no viewport");
  expect(landed.x).toBeGreaterThanOrEqual(0);
  expect(landed.y).toBeGreaterThanOrEqual(0);
  expect(landed.x + landed.width).toBeLessThanOrEqual(view.width);
  expect(landed.y + landed.height).toBeLessThanOrEqual(view.height);

  // A reload is a new page and a new content script: the position is the one the reader left behind.
  await page.reload();
  await expect(host).toBeVisible();
  await expect.poll(async () => Math.round((await host.boundingBox())?.x ?? -1), { timeout: OBSERVE_MS }).toBe(Math.round(landed.x));
  const restored = await host.boundingBox();
  if (restored === null) throw new Error("the widget host has no box after the reload");
  expect(Math.round(restored.y)).toBe(Math.round(landed.y));
});

test("switches itself off on this site, and stays off", async ({ context, serviceWorker, configure }) => {
  await configure();
  await autoShowWidget(serviceWorker);
  const environment = await testEnvironment();

  const page = await context.newPage();
  await page.goto(`${environment.pagesUrl}/article.html`);
  const host = widget(page);
  await expect(host).toBeVisible();

  await page.getByRole("button", { name: "Expand the player" }).click();
  await page.getByRole("button", { name: "Disable the player on this site" }).click();
  await expect(host).toHaveCount(0);

  // What makes it stick is the settings record, not the unmount: the host name is in the list.
  expect(await disabledSites(serviceWorker)).toContain("127.0.0.1");

  await page.reload();
  await page.waitForLoadState("load");
  await page.waitForTimeout(2_000);
  await expect(host).toHaveCount(0);
});
