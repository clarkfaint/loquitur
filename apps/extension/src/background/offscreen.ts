/**
 * The offscreen document (F§10.2): its life, and the one channel its settings arrive on.
 *
 * The service worker owns exactly two things here. It decides *whether* the document exists — creating it only
 * when `chrome.runtime.getContexts` shows none, which is what keeps one document at a time — and it decides how
 * long it stays: `closeOffscreenLater()` schedules the close the contract asks for 30 s after a reading stops or
 * ends, and opening the document again cancels a pending close.
 *
 * It also owns the settings channel, for a reason that is a property of the platform rather than a preference.
 * An offscreen document is a constrained realm: measured on this host, `Object.keys(chrome)` inside it is
 * `["loadTimes", "csi", "runtime"]` — no `storage`, no `tabs`, no `offscreen`, no `permissions`. It therefore
 * cannot read the settings record the popup writes. What it can do is hold a `chrome.runtime` port, so the
 * worker pushes the fields the host needs (the hub address and token, the voice, the speed, the furniture rule)
 * when the document connects and again whenever the record changes. The document's first push is also the
 * readiness signal `ensureOffscreen()` waits for: a relay sent into a document whose script has not run yet is
 * answered by nobody.
 */

import { z } from "zod";
import { getSettings, onSettingsChanged } from "../settings";

/** The document's own page, as WXT builds it from `entrypoints/offscreen/`. */
export const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";

/** The name of the port the offscreen document opens to the service worker. */
export const OFFSCREEN_PORT = "lectern-offscreen";

/** F§10.2's reason for the document: it is there to play audio. */
const OFFSCREEN_REASON = "AUDIO_PLAYBACK";

/** What the document is for, in the words Chrome may show a reader. */
const OFFSCREEN_JUSTIFICATION = "Lectern reads a document aloud, and a service worker cannot hold audio.";

/** How long a document with nothing loaded is kept before it is closed (the contract's own rule). */
const IDLE_CLOSE_MS = 30_000;

/** How long `ensureOffscreen()` waits for the document's port before calling it unusable. */
const CONNECT_TIMEOUT_MS = 5_000;

/**
 * What the offscreen host is built from: the fields of the settings record it needs, and nothing else. The
 * token is here because the document is the only context that calls the hub (F§10.2) and F§11 authenticates
 * every one of those calls; it travels over the port, never in a URL.
 */
export const OffscreenSettingsSchema = z.strictObject({
  hubUrl: z.string(),
  token: z.string(),
  voiceId: z.string(),
  rate: z.number(),
  skipFurniture: z.boolean(),
});

/** The settings a hub client and a player are built from. */
export type OffscreenSettings = z.infer<typeof OffscreenSettingsSchema>;

/** The one message the worker sends over the port, and the schema the document validates it with. */
export const OffscreenSettingsMessageSchema = z.strictObject({
  type: z.literal("settings"),
  settings: OffscreenSettingsSchema,
});

/** The settings the record currently holds, as the document needs them. */
export async function offscreenSettings(): Promise<OffscreenSettings> {
  const settings = await getSettings();
  return {
    hubUrl: settings.hubUrl,
    token: settings.token,
    voiceId: settings.voiceId,
    rate: settings.rate,
    skipFurniture: settings.skipFurniture,
  };
}

/** The connected document's end of the port, while it is connected. */
let port: chrome.runtime.Port | null = null;

/** Callers of `ensureOffscreen()` waiting for a port to arrive. */
let waiting: (() => void)[] = [];

/** A scheduled close, or `null` when none is pending. (`globalThis.setTimeout`'s own handle type is the one
 * this program resolves — with node's declarations reachable it is not a `number`, so it is not spelled as one.) */
let closeHandle: ReturnType<typeof globalThis.setTimeout> | null = null;

/** Resolve everyone waiting for the document's port. */
function settle(): void {
  const pending = waiting;
  waiting = [];
  for (const resolve of pending) resolve();
}

/** Wait for a port, and answer whether one arrived. */
async function waitForPort(timeoutMs: number): Promise<boolean> {
  if (port !== null) return true;
  const arrived = await new Promise<boolean>((resolve) => {
    const handle = globalThis.setTimeout(() => resolve(false), timeoutMs);
    waiting.push(() => {
      globalThis.clearTimeout(handle);
      resolve(true);
    });
  });
  return arrived;
}

/** Whether an offscreen document exists right now. */
async function documentExists(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  return contexts.length > 0;
}

/** Send the current settings to the connected document, if there is one. */
export async function pushOffscreenSettings(): Promise<void> {
  const live = port;
  if (live === null) return;
  try {
    live.postMessage({ type: "settings", settings: await offscreenSettings() } satisfies z.infer<typeof OffscreenSettingsMessageSchema>);
  } catch {
    // The document went away between the check and the send; the next connect pushes again.
  }
}

/**
 * Install the settings channel. Called once when the service worker starts, so the port the document opens on
 * its own first line always finds a listener: a connection nothing listens for is closed immediately.
 */
export function installOffscreenBridge(): void {
  chrome.runtime.onConnect.addListener((candidate) => {
    if (candidate.name !== OFFSCREEN_PORT) return;
    port = candidate;
    candidate.onDisconnect.addListener(() => {
      if (port === candidate) port = null;
    });
    settle();
    void pushOffscreenSettings();
  });
  onSettingsChanged(() => {
    void pushOffscreenSettings();
  });
}

/** Cancel a pending close: the document is wanted again. */
export function cancelOffscreenClose(): void {
  if (closeHandle === null) return;
  globalThis.clearTimeout(closeHandle);
  closeHandle = null;
}

/**
 * `ensureOffscreen()` — make sure one document is open and ready to receive, and answer whether it is.
 *
 * A document from an earlier service-worker life has no port (the port dies with its worker), and nothing can
 * be sent to it; the one recovery attempt below closes it and opens a fresh one rather than waiting out a
 * second timeout. Never more than one document is open at a time: the existing one is checked first, and the
 * replacement is opened only after it is closed.
 */
export async function ensureOffscreen(): Promise<boolean> {
  cancelOffscreenClose();
  if (port !== null) {
    await pushOffscreenSettings();
    return true;
  }
  if (!(await documentExists())) await openDocument();
  if (await waitForPort(CONNECT_TIMEOUT_MS)) {
    await pushOffscreenSettings();
    return true;
  }
  if (await documentExists()) {
    await chrome.offscreen.closeDocument();
    await openDocument();
  }
  return await waitForPort(CONNECT_TIMEOUT_MS);
}

/** Open the document with F§10.2's reason. */
async function openDocument(): Promise<void> {
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: [OFFSCREEN_REASON],
    justification: OFFSCREEN_JUSTIFICATION,
  });
}

/**
 * `closeOffscreenLater()` — keep the document for 30 s after a reading stops or ends, and close it then if
 * nothing has started in the meantime. The document holds a port while it is open, which is also what keeps
 * the worker alive long enough to run this timer; once the document is closed, the worker is free to idle.
 */
export function closeOffscreenLater(): void {
  cancelOffscreenClose();
  closeHandle = globalThis.setTimeout(() => {
    closeHandle = null;
    void closeOffscreen();
  }, IDLE_CLOSE_MS);
}

/** Close the document, if one is open. */
async function closeOffscreen(): Promise<void> {
  const live = port;
  port = null;
  live?.disconnect();
  if (await documentExists()) await chrome.offscreen.closeDocument();
}
