/**
 * The whole extension, end to end (F§10.2, F§13 phase 2).
 *
 * This is the suite the unit is named for: every path a reader can take into a reading, in one file, against
 * the built extension, a real hub and a real page server — the context menu's selection item, the keyboard
 * commands, the PDF hand-off, the tab that goes away, and a reading that fails. Each case is one numbered
 * behaviour of the contract, and each asserts the *extension's* own numbers: the player's state as the service
 * worker received it, the offscreen document's existence, the reply the extension's own message handlers gave.
 *
 * Three platform facts decide how the cases are written, all of them measured on this host (see
 * `docs/evidence/U-037.md` §2):
 *
 * 1. A manifest shortcut is delivered by the browser to a *focused browser window*, and Playwright's key events
 *    go to the page instead: pressing `Alt+Shift+R` on the article produced no message at all in the worker.
 *    A context menu is browser chrome with no clickable handle either. The extension publishes the two routes
 *    the browser would call — `lecternCommand` and `lecternMenuClick` — on the service worker's global, so a
 *    case drives the extension's own dispatch functions rather than a copy of them.
 * 2. `chrome.tabs.query` reports every tab with no `url` at all: reading a tab's address needs the `tabs`
 *    permission, a host permission or an `activeTab` grant, and the last of those is granted only when the
 *    reader *invokes* the extension — a toolbar click, a menu item or a shortcut. None of those can be
 *    performed by a test, and `chrome.permissions.request` cannot grant the origin either (without a gesture it
 *    throws; with one, the prompt never settles headlessly). `lecternPdfHandoff` therefore supplies the one
 *    value the platform would have supplied — the tab and its address — and the hand-off itself (the refusals,
 *    the address, the tab that is opened) is the extension's own code.
 * 3. The service worker's session forwards the player's state to the reading tab only once it has that tab, and
 *    it records the tab *after* the load it relays has answered. A reading that fails while loading is therefore
 *    inside that window: the widget shows the failure from the next state the worker forwards, which is the
 *    reader's second press of play. The failing case below asserts both halves of that, and §7 of the unit's
 *    evidence files it.
 */

import type { PlayerSnapshot } from "@lectern/core";
import type { Locator, Page, Worker } from "@playwright/test";
import { expect, test, testEnvironment } from "./fixtures";

/** The key the extension's settings record lives under (`apps/extension/src/settings.ts`). */
const SETTINGS_KEY = "lectern.extension.settings";

/** The verbatim name of the widget's error attribute (`src/content/selection-feature.ts`). */
const WIDGET_ERROR_ATTRIBUTE = "data-lectern-widget-error";

/** The item id the menu's selection entry carries (`src/background/context-menu.ts`). */
const READ_SELECTION_ITEM = "lectern-read-selection";

/** How long a case waits for the player to reach a state, and for the page to catch up with it. */
const OBSERVE_MS = 30_000;

/** How long the offscreen document may take to close after a reading ends: the contract's own ceiling. */
const OFFLINE_CLOSE_MS = 35_000;

/** How often a running reading is sampled while watching what the page paints. */
const SAMPLE_MS = 100;

/** The speed the cases read at that need the reading over quickly: F§10.1 allows up to 5.0. */
const FAST_RATE = 5;

/** A page the run's own server does not have, so navigating to it is a navigation and nothing else. */
const ELSEWHERE = "notes.txt";

/**
 * The PDF the hand-off case is handed: an `https` address whose path ends in the extension.
 *
 * A `.invalid` host can never resolve, and is served by this file's own route instead, so the case never
 * reaches the network. The web app it is handed to is this run's own page server, which answers the hand-off
 * address with its own 404 — a response is a load, and the address is what the case asserts.
 */
const PDF_URL = "https://harbour.example.invalid/notes/tide-tables.pdf";

declare global {
  /** The snapshots the service worker received, recorded by `recordSnapshots`. */
  var __lecternFullSnapshots: PlayerSnapshot[] | undefined;
}

/** Record every snapshot the worker receives, so a case can read the player's own numbers. */
async function recordSnapshots(worker: Worker): Promise<void> {
  await worker.evaluate(() => {
    globalThis.__lecternFullSnapshots = [];
    chrome.runtime.onMessage.addListener((raw: unknown) => {
      const message = raw as { type?: string; snapshot?: PlayerSnapshot } | null;
      if (message?.type === "ext/snapshot" && message.snapshot !== undefined) {
        globalThis.__lecternFullSnapshots?.push(message.snapshot);
      }
    });
  });
}

/** Every snapshot the worker has received. */
async function received(worker: Worker): Promise<PlayerSnapshot[]> {
  return await worker.evaluate(() => globalThis.__lecternFullSnapshots ?? []);
}

/** The last snapshot the worker received, or `null` before the first. */
async function latest(worker: Worker): Promise<PlayerSnapshot | null> {
  const snapshots = await received(worker);
  return snapshots.at(-1) ?? null;
}

/** The sentence the last snapshot reports, or `0` before the first one. */
async function sentenceIndex(worker: Worker): Promise<number> {
  return (await latest(worker))?.sentenceIndex ?? 0;
}

/** The furthest sentence the player has reported — how many sentences it has read across. */
async function furthestSentence(worker: Worker): Promise<number> {
  const indexes = (await received(worker)).map((snapshot) => snapshot.sentenceIndex);
  return indexes.length === 0 ? -1 : Math.max(...indexes);
}

/** How many offscreen documents the extension has open right now. */
async function offscreenDocuments(worker: Worker): Promise<number> {
  return await worker.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length);
}

/** Write one or more fields of the extension's settings record, as the popup's form would. */
async function writeSettings(worker: Worker, patch: Record<string, unknown>): Promise<void> {
  await worker.evaluate(
    async ([key, fields]) => {
      const stored = (await chrome.storage.local.get(key as string)) as Record<string, unknown>;
      const record = (stored[key as string] ?? {}) as Record<string, unknown>;
      await chrome.storage.local.set({ [key as string]: { ...record, ...(fields as Record<string, unknown>) } });
    },
    [SETTINGS_KEY, patch] as const,
  );
}

/** Drive one manifest shortcut, as the browser would when the reader presses it. */
async function runCommand(worker: Worker, name: string): Promise<void> {
  await worker.evaluate(async (command) => await globalThis.lecternCommand?.(command), name);
}

/** Choose the menu's selection item and answer with what the tab said. */
async function chooseReadSelection(worker: Worker): Promise<unknown> {
  return await worker.evaluate(async (item) => await globalThis.lecternMenuClick?.({ menuItemId: item }), READ_SELECTION_ITEM);
}

/** The text of the registered sentence highlight, or `null` while nothing is highlighting a sentence. */
async function highlightedSentence(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    const highlight = CSS.highlights.get("lectern-sentence");
    if (highlight === undefined) return null;
    for (const range of highlight) return range.toString();
    return null;
  });
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

/** The page's own article, opened and brought to the front: "the tab the reader is looking at". */
async function openArticle(context: { newPage(): Promise<Page> }, pagesUrl: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${pagesUrl}/article.html`);
  await page.bringToFront();
  return page;
}

/**
 * Collapse a run of whitespace into one space and trim the ends.
 *
 * The page's own markup carries the line breaks of its source, and the model collapses them (F§5.2) — so a
 * painted range, which is the page's own text, and the paragraph it was selected from are compared in the one
 * form both of them have.
 */
function normalized(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * Select one paragraph of the article and answer with its text, normalized the way the model normalizes it,
 * so a painted sentence can be compared with it.
 */
async function selectParagraph(page: Page, which: number): Promise<string> {
  const text = await page.evaluate((index) => {
    const paragraph = [...document.querySelectorAll("article p")][index];
    if (paragraph === undefined) return null;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return paragraph.textContent ?? "";
  }, which);
  if (text === null) throw new Error(`the fixture's article has no paragraph ${which}`);
  return normalized(text);
}

/** The widget's error banner, reached through the widget's open shadow root. */
function errorBanner(page: Page): Locator {
  return page.locator(`lectern-widget [${WIDGET_ERROR_ATTRIBUTE}]`);
}

test("reads the page across at least two sentences when the read-page command is run", async ({ context, serviceWorker, configure }) => {
  await configure({ rate: FAST_RATE });
  const environment = await testEnvironment();
  await recordSnapshots(serviceWorker);
  const page = await openArticle(context, environment.pagesUrl);

  // The shortcut the reader would press, dispatched by the extension's own command path.
  await runCommand(serviceWorker, "read-page");

  await expect.poll(async () => (await latest(serviceWorker))?.state, { timeout: OBSERVE_MS }).toBe("playing");
  // At least two sentences: the player has reported a sentence beyond the first.
  await expect.poll(async () => await furthestSentence(serviceWorker), { timeout: OBSERVE_MS }).toBeGreaterThanOrEqual(1);
  // And the reading is of *this* tab's article: the page paints the word it is reading.
  await expect.poll(async () => await highlightedWord(page), { timeout: OBSERVE_MS }).not.toBeNull();
  expect(await offscreenDocuments(serviceWorker)).toBe(1);
});

test("reads only the selected paragraph from the Read selection menu item, and reaches ended", async ({
  context,
  serviceWorker,
  configure,
}) => {
  await configure({ rate: FAST_RATE });
  const environment = await testEnvironment();
  await recordSnapshots(serviceWorker);
  const page = await openArticle(context, environment.pagesUrl);
  const paragraph = await selectParagraph(page, 1);

  const reply = await chooseReadSelection(serviceWorker);
  expect(reply).toMatchObject({ ok: true });

  // Watch what is painted while that paragraph is read: every sentence the page highlights must be one of the
  // paragraph's own, which is what "only that paragraph" means from the page.
  const painted: string[] = [];
  const deadline = Date.now() + OBSERVE_MS;
  let ended = false;
  while (Date.now() < deadline) {
    const sentence = await highlightedSentence(page);
    if (sentence !== null && painted.at(-1) !== sentence) {
      const painted_ = normalized(sentence);
      expect(paragraph.includes(painted_), `${painted_} is not part of the selected paragraph`).toBe(true);
      painted.push(painted_);
    }
    if ((await latest(serviceWorker))?.state === "ended") {
      ended = true;
      break;
    }
    await page.waitForTimeout(SAMPLE_MS);
  }

  expect(ended, "the selection reading did not reach ended").toBe(true);
  expect(painted.length).toBeGreaterThan(0);
  expect((await received(serviceWorker)).some((snapshot) => snapshot.state === "playing")).toBe(true);
});

test("answers toggle-play, next-sentence and previous-sentence with the snapshot they move", async ({
  context,
  serviceWorker,
  configure,
}) => {
  await configure();
  const environment = await testEnvironment();
  await recordSnapshots(serviceWorker);
  await openArticle(context, environment.pagesUrl);
  await runCommand(serviceWorker, "read-page");
  await expect.poll(async () => (await latest(serviceWorker))?.state, { timeout: OBSERVE_MS }).toBe("playing");

  // Pause, then resume: one command each way, and the state it moved to is the player's own.
  await runCommand(serviceWorker, "toggle-play");
  await expect.poll(async () => (await latest(serviceWorker))?.state, { timeout: OBSERVE_MS }).toBe("paused");
  await runCommand(serviceWorker, "toggle-play");
  await expect.poll(async () => (await latest(serviceWorker))?.state, { timeout: OBSERVE_MS }).toBe("playing");

  // One sentence forward, one back: the position follows the commands, and the reading is still playing.
  const before = await sentenceIndex(serviceWorker);
  await runCommand(serviceWorker, "next-sentence");
  await expect.poll(async () => await sentenceIndex(serviceWorker), { timeout: OBSERVE_MS }).toBeGreaterThan(before);
  const forward = await sentenceIndex(serviceWorker);
  await runCommand(serviceWorker, "previous-sentence");
  await expect.poll(async () => await sentenceIndex(serviceWorker), { timeout: OBSERVE_MS }).toBeLessThan(forward);
  expect((await latest(serviceWorker))?.state).toBe("playing");
});

test("opens the web app at the hand-off address for an https PDF, and refuses when it cannot read the tab", async ({
  context,
  serviceWorker,
  extensionId,
  configure,
}) => {
  await configure();
  const environment = await testEnvironment();
  const webApp = environment.pagesUrl;
  await writeSettings(serviceWorker, { webAppUrl: webApp });
  await context.route(PDF_URL, (route) => route.fulfill({ body: "<html><body>a PDF</body></html>", contentType: "text/html" }));

  const pdf = await context.newPage();
  await pdf.goto(PDF_URL);
  await pdf.bringToFront();

  // The handler the extension registered answers the reader's own message. The PDF is brought back to the
  // front first, because the view that asks is a tab of its own: the extension is told about a tab's address
  // only when the reader has invoked it, and a message from a tab carries no such grant — so the answer names
  // the tab it could not read rather than inventing a hand-off from the wrong one.
  const view = await context.newPage();
  await view.goto(`chrome-extension://${extensionId}/popup.html`);
  await pdf.bringToFront();
  const refused = await view.evaluate(async () => await chrome.runtime.sendMessage({ type: "ext/open-pdf" }));
  expect(refused).toMatchObject({ ok: false, code: "NO_ACTIVE_TAB" });

  // With the tab known, the same handler builds the address and opens it — in a real tab, as the reader sees.
  const expected = `${webApp}/#/import?url=${encodeURIComponent(PDF_URL)}`;
  const opened = context.waitForEvent("page");
  const handoff = await serviceWorker.evaluate(async (tab) => await globalThis.lecternPdfHandoff?.(tab), {
    url: PDF_URL,
    incognito: false,
  });
  expect(handoff).toMatchObject({ ok: true, data: { url: expected } });

  const reader = await opened;
  await reader.waitForLoadState("load");
  expect(reader.url()).toBe(expected);
});

test("ends the reading and closes the offscreen document when the reading tab navigates away", async ({
  context,
  serviceWorker,
  configure,
}) => {
  await configure();
  const environment = await testEnvironment();
  await recordSnapshots(serviceWorker);
  const page = await openArticle(context, environment.pagesUrl);
  await runCommand(serviceWorker, "read-page");
  await expect.poll(async () => (await latest(serviceWorker))?.state, { timeout: OBSERVE_MS }).toBe("playing");
  expect(await offscreenDocuments(serviceWorker)).toBe(1);

  // The reader leaves the page the document came from: what was extracted is gone, so the reading is over.
  await page.goto(`${environment.pagesUrl}/${ELSEWHERE}`);
  await expect.poll(async () => (await latest(serviceWorker))?.state, { timeout: OBSERVE_MS }).toBe("idle");
  await expect.poll(async () => await offscreenDocuments(serviceWorker), { timeout: OFFLINE_CLOSE_MS }).toBe(0);
});

test("surfaces a reading that failed in the widget, and plays nothing", async ({ context, serviceWorker, extensionId, configure }) => {
  const wrongToken = "not-the-hub-token-0123456789abcdef";
  await configure({ token: wrongToken });
  await writeSettings(serviceWorker, { autoShowWidget: true });
  const environment = await testEnvironment();
  await recordSnapshots(serviceWorker);

  const page = await openArticle(context, environment.pagesUrl);
  const widget = page.locator("lectern-widget");
  await expect(widget).toBeVisible();

  // What "no audio plays" rests on: this token buys nothing from the hub, so no chunk is ever synthesized.
  const view = await context.newPage();
  await view.goto(`chrome-extension://${extensionId}/popup.html`);
  const refused = await view.evaluate(
    async ([hubUrl, token]) => (await fetch(`${hubUrl}/v1/voices`, { headers: { authorization: `Bearer ${token}` } })).status,
    [environment.hubUrl, wrongToken] as const,
  );
  expect(refused).toBe(401);

  // The reader presses play. The reading fails while it is loading, and the player says so.
  await page.bringToFront();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await latest(serviceWorker))?.state, { timeout: OBSERVE_MS }).toBe("error");
  await expect.poll(async () => (await latest(serviceWorker))?.error?.code, { timeout: OBSERVE_MS }).toBe("CHUNK_FAILED");

  // The reader tries again, and this time the worker's own state reaches the tab: the widget shows why.
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(errorBanner(page)).toBeVisible({ timeout: OBSERVE_MS });
  await expect(errorBanner(page)).toHaveAttribute(WIDGET_ERROR_ATTRIBUTE, "CHUNK_FAILED");
  await expect(errorBanner(page)).toHaveText(/bearer token is not valid/u);

  // And nothing played: the player never reported `playing`, and never left the document's first word.
  const snapshots = await received(serviceWorker);
  expect(snapshots.some((snapshot) => snapshot.state === "playing")).toBe(false);
  expect(snapshots.every((snapshot) => snapshot.sentenceIndex === 0 && snapshot.wordIndex === 0)).toBe(true);
  expect(snapshots.some((snapshot) => snapshot.error !== null)).toBe(true);
});
