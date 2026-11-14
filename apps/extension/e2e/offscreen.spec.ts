/**
 * The offscreen audio host, end to end (F§10.2, F§13 phase 2).
 *
 * One case drives the whole path this unit builds: a view asks the extension to read a document, the service
 * worker relays it to the offscreen document, that document plays it through the hub's mock engine, and its
 * state comes back through the worker. Nothing here is stubbed except the hub's engine, which is F§7.1's own.
 *
 * Two things about the platform decide how the case is written, both measured in this session. A service worker
 * cannot send a message to itself — `chrome.runtime` excludes the sender's own context — so the request cannot
 * originate in the worker, and it is sent from the extension's own popup page instead. And a `chrome.runtime`
 * message is delivered to every context but the sender's, so a page's copy of a command reaches the offscreen
 * document too; the document deliberately obeys only the relay it receives without a tab, which is what makes a
 * single `pause` in this case a single pause in the player.
 */

import { buildDocument, type DocumentModel, type PlayerSnapshot } from "@lectern/core";
import type { Worker } from "@playwright/test";
import type { ExtMessage } from "../src/messages";
import { expect, test } from "./fixtures";

/** The three sentences the offscreen document is asked to read. */
const SENTENCES = ["The harbour holds the light.", "Boats wait for the tide.", "Nothing here is in a hurry."];

/** The document this case hands over, built by core's own builder so its shape cannot drift from the model's. */
const DOCUMENT: DocumentModel = buildDocument([{ kind: "paragraph", text: SENTENCES.join(" ") }], {
  title: "Harbour Light",
  source: { kind: "txt" },
});

declare global {
  /** The snapshots the service worker received, recorded by the case below. */
  var __lecternSnapshots: PlayerSnapshot[] | undefined;
}

/** The snapshots the service worker has received. */
async function received(worker: Worker): Promise<PlayerSnapshot[]> {
  return await worker.evaluate(() => globalThis.__lecternSnapshots ?? []);
}

/** The last snapshot the service worker received, or `null` before the first. */
async function latest(worker: Worker): Promise<PlayerSnapshot | null> {
  const snapshots = await received(worker);
  return snapshots[snapshots.length - 1] ?? null;
}

/** How many offscreen documents the extension has open right now. */
async function offscreenDocuments(worker: Worker): Promise<number> {
  return await worker.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length);
}

test("reads a document in the offscreen document and relays its state", async ({ context, serviceWorker, extensionId, configure }) => {
  await configure();

  // The extension's popup page is the view that asks for a reading. It is also the only context that can reach
  // the service worker with a message (see this file's note on the platform).
  const view = await context.newPage();
  await view.goto(`chrome-extension://${extensionId}/popup.html`);

  // What "snapshots reach the service worker" means: a listener in the worker records what arrives.
  await serviceWorker.evaluate(() => {
    globalThis.__lecternSnapshots = [];
    chrome.runtime.onMessage.addListener((raw) => {
      if (raw?.type === "ext/snapshot") globalThis.__lecternSnapshots?.push(raw.snapshot);
    });
  });

  const asked = await view.evaluate(async (message) => await chrome.runtime.sendMessage(message), {
    type: "ext/read-document",
    document: DOCUMENT,
  } satisfies ExtMessage);
  expect(asked).toMatchObject({ ok: true });

  // Exactly one offscreen document, and it is reading: the player is playing and the sentence index has moved.
  await expect.poll(async () => await offscreenDocuments(serviceWorker)).toBe(1);
  await expect.poll(async () => (await latest(serviceWorker))?.state, { timeout: 30_000 }).toBe("playing");
  expect((await latest(serviceWorker))?.docId).toBe(DOCUMENT.docId);
  await expect.poll(async () => (await latest(serviceWorker))?.sentenceIndex ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);

  // A pause travels the same relay, and the state it produces is what the worker sees next.
  const paused = await view.evaluate(async (message) => await chrome.runtime.sendMessage(message), {
    type: "ext/command",
    command: { type: "pause" },
  } satisfies ExtMessage);
  expect(paused).toMatchObject({ ok: true });
  await expect.poll(async () => (await latest(serviceWorker))?.state).toBe("paused");

  // Stopping settles the player, and the document is kept for a moment rather than closed at once.
  const stopped = await view.evaluate(async (message) => await chrome.runtime.sendMessage(message), {
    type: "ext/stop",
  } satisfies ExtMessage);
  expect(stopped).toMatchObject({ ok: true });
  await expect.poll(async () => (await latest(serviceWorker))?.state).toBe("idle");
  expect(await offscreenDocuments(serviceWorker)).toBe(1);

  // Nothing the worker sent itself: every snapshot it recorded came from the offscreen document.
  expect((await received(serviceWorker)).length).toBeGreaterThan(1);
});
