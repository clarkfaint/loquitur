/**
 * Saving a page to the library, end to end (F§10.2, Phase 5).
 *
 * One case drives the whole path this unit builds: the widget's Save button keeps the page in the extension's
 * own library, F§8.2's round carries it to the hub, and the reader's place follows it. Nothing is stubbed — the
 * hub is the real one `global-setup.ts` starts, the document is the article `pages/article.html` serves, and the
 * assertions are made against the hub's own change log through `GET /v1/sync/pull`, which is the same route
 * another device would read.
 *
 * Three platform facts decide how the case is written, and all three are U-034's and U-036's measurements. The
 * page's own world has no `chrome` object, so the widget is driven with ordinary clicks and the player's state is
 * read from the *worker*, which every published snapshot passes through. The extension is only loaded into the
 * persistent context the fixture builds. And the settings record the fixture writes turns the widget off, so the
 * case turns it on the way the popup's form would and reloads nothing, because it does that before the page is
 * opened.
 *
 * The whole suite is the unit's own gate — this file adds a case to it rather than replacing any — so the four
 * specs that were here before still run in the same command.
 */

import { gunzipSync } from "node:zlib";
import { DocumentModelSchema, type PlayerSnapshot } from "@lectern/core";
import type { APIRequestContext, Worker } from "@playwright/test";
import { expect, type TestEnvironment, test, testEnvironment } from "./fixtures";

/** The key the extension's settings record lives under (`apps/extension/src/settings.ts`). */
const SETTINGS_KEY = "lectern.extension.settings";

/** How long a case waits for the player, the widget or the hub. */
const OBSERVE_MS = 30_000;

/** How often the hub is asked again while a case waits for a change to arrive. */
const POLL_MS = 500;

/** The widget's Save control before the page is in the library (its `aria-label`). */
const SAVE_LABEL = "Save this page to the library";

/** The same control once the page is in the library. */
const SAVED_LABEL = "Saved to the library";

/** One change as `GET /v1/sync/pull` answers it (F§8.2; U-054's op schema is the hub's own). */
interface SyncChange {
  entity: string;
  entityId: string;
  kind: string;
  ts: number;
  record: unknown;
}

/** The title a change's record carries, or `null` when it carries something that has none. */
function recordTitle(record: unknown): string | null {
  if (typeof record !== "object" || record === null) return null;
  const title = (record as { title?: unknown }).title;
  return typeof title === "string" ? title : null;
}

/** Every change the run's hub holds, read the way another device would read them. */
async function allChanges(request: APIRequestContext, environment: TestEnvironment): Promise<SyncChange[]> {
  const answer = await request.get(`${environment.hubUrl}/v1/sync/pull?since=0`, {
    headers: { authorization: `Bearer ${environment.token}` },
  });
  if (!answer.ok()) throw new Error(`the hub refused the pull with ${answer.status()}`);
  const body = (await answer.json()) as { changes: SyncChange[] };
  return body.changes;
}

/** Wait for a change the hub does not hold yet, asking it again until the deadline. */
async function waitForChange(read: () => Promise<SyncChange | null>, what: string): Promise<SyncChange> {
  const deadline = Date.now() + OBSERVE_MS;
  for (;;) {
    const found = await read();
    if (found !== null) return found;
    if (Date.now() > deadline) throw new Error(`the hub never held ${what}`);
    await new Promise((resolve) => {
      setTimeout(resolve, POLL_MS);
    });
  }
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

/** Record every snapshot the worker receives, so a case can read the player's own state. */
async function recordSnapshots(worker: Worker): Promise<void> {
  await worker.evaluate(() => {
    globalThis.__lecternSavePageSnapshots = [];
    chrome.runtime.onMessage.addListener((raw: unknown) => {
      const message = raw as { type?: string; snapshot?: PlayerSnapshot } | null;
      if (message?.type === "ext/snapshot" && message.snapshot !== undefined) {
        globalThis.__lecternSavePageSnapshots?.push(message.snapshot);
      }
    });
  });
}

/** The last snapshot the worker received, or `null` before the first. */
async function latest(worker: Worker): Promise<PlayerSnapshot | null> {
  const snapshots = await worker.evaluate(() => globalThis.__lecternSavePageSnapshots ?? []);
  return snapshots[snapshots.length - 1] ?? null;
}

declare global {
  /** The snapshots the service worker received, recorded by `recordSnapshots`. */
  var __lecternSavePageSnapshots: PlayerSnapshot[] | undefined;
}

test("saves the page from the widget, syncs it, and keeps the reader's place", async ({ context, serviceWorker, configure, request }) => {
  await configure();
  await autoShowWidget(serviceWorker);
  const environment = await testEnvironment();

  const page = await context.newPage();
  await page.goto(`${environment.pagesUrl}/article.html`);
  const title = (await page.title()).trim();
  expect(title.length).toBeGreaterThan(0);

  await recordSnapshots(serviceWorker);

  // A reading, started from the widget's own play control, so what the extension saves is the page the reader
  // is looking at rather than a document this case built by hand.
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await latest(serviceWorker))?.state, { timeout: OBSERVE_MS }).toBe("playing");

  // Save, from the widget's own control in the bar it expands into, and read the state back off the button:
  // the widget shows the saved state only because the offscreen document published it with a snapshot.
  await page.getByRole("button", { name: "Expand the player" }).click();
  await expect(page.getByRole("button", { name: SAVE_LABEL })).toBeEnabled({ timeout: OBSERVE_MS });
  await page.getByRole("button", { name: SAVE_LABEL }).click();
  await expect(page.getByRole("button", { name: SAVED_LABEL })).toBeVisible({ timeout: OBSERVE_MS });

  // The hub holds the document: a `document` change titled like the article...
  const saved = await waitForChange(async () => {
    const changes = await allChanges(request, environment);
    return changes.find((change) => change.entity === "document" && change.kind === "put" && recordTitle(change.record) === title) ?? null;
  }, `a document change titled ${title}`);

  // ...and F§5.1's model behind it, under the identifier the change names.
  const model = await request.get(`${environment.hubUrl}/v1/library/documents/${saved.entityId}/model`, {
    headers: { authorization: `Bearer ${environment.token}` },
  });
  expect(model.ok()).toBe(true);
  const parsed = DocumentModelSchema.safeParse(JSON.parse(gunzipSync(await model.body()).toString("utf8")) as unknown);
  expect(parsed.success).toBe(true);
  expect(parsed.success ? parsed.data.docId : null).toBe(saved.entityId);

  // The reader's place travels too, and pausing is what puts it on the wire.
  await page.getByRole("button", { name: "Collapse the player" }).click();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(async () => (await latest(serviceWorker))?.state, { timeout: OBSERVE_MS }).toBe("paused");

  const place = await waitForChange(async () => {
    const changes = await allChanges(request, environment);
    return changes.find((change) => change.entity === "progress" && change.entityId === saved.entityId) ?? null;
  }, `a progress change for ${saved.entityId}`);
  expect(place.kind).toBe("put");
});
