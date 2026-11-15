/**
 * The PDF hand-off (F§10.2): a PDF tab cannot be read in place, so it is handed to the web app that can.
 *
 * Chrome's built-in viewer is not scriptable, so nothing this extension does can highlight a PDF page or
 * find its text; what it *can* do is recognise that the reader is looking at one and open the web app's
 * import route with that address. The document is then fetched, parsed and read by the hub and the web app,
 * which is exactly what F§10.2 asks: the extension never fetches, parses or renders a PDF itself.
 *
 * Three refusals are the contract's own, and each is a sentence rather than a silent no-op, because the
 * popup shows whatever this handler answers:
 *
 * - `LOCAL_FILE` — a `file:` (or otherwise non-`http(s)`) address, or a tab in a private window. Neither is
 *   something the web app can read: its own origin cannot fetch a path on this computer, and a private
 *   window's page is not the reader's to hand on.
 * - `NOT_A_PDF` — an ordinary page. The extension has nothing to hand off.
 * - `NO_WEB_APP` — no web app address is configured, so there is nowhere to open.
 *
 * The order matters and is fixed here: the address's own eligibility is decided first (a local `…/paper.pdf`
 * is `LOCAL_FILE`, not a hand-off), then whether it is a PDF at all, then whether there is a reader to open
 * it in. The detector reads the URL's *path* and nothing else — a query string that happens to end in `.pdf`
 * is not a PDF, and a path with `.pdf` in the middle is not one either.
 *
 * The handler is added to the service worker's registry at installation rather than written into
 * `handlers.ts`, which is U-032's file and whose frozen test asserts that the registry *as declared* refuses
 * every type but `ext/get-status`. The operator ratified that pattern in U-034 (see `docs/evidence/U-034.md`
 * §7); what the running worker answers is this installation's business.
 */

import { type ExtReply, failReply, messageOf, okReply } from "../messages";
import { getSettings, isHttpUrl } from "../settings";
import { handlers } from "./handlers";
import { NO_ACTIVE_TAB } from "./read-active-tab";
import type { Handler } from "./router";

/** The answer when there is no web app configured to open the hand-off in. */
export const NO_WEB_APP = "NO_WEB_APP";

/** The answer when the tab is not showing a PDF. */
export const NOT_A_PDF = "NOT_A_PDF";

/** The answer when the address is one the web app could not read: a file on this computer, or a private window. */
export const LOCAL_FILE = "LOCAL_FILE";

/** A message that is not this handler's own, which can only happen if the router misroutes it. */
const BAD_MESSAGE = "BAD_MESSAGE";

/** The tab a hand-off is asked for: what the extension needs to know about it, and nothing else. */
export interface HandoffTab {
  /** The address the tab is showing. */
  readonly url: string;
  /** Whether the tab is in a private window. */
  readonly incognito: boolean;
}

/** What this feature needs from the extension platform, injected so it can be driven without a browser. */
export interface PdfHandoffPlatform {
  /** The tab the reader is looking at, or `null` when there is none. */
  activeTab(): Promise<HandoffTab | null>;
  /** Open one address in a new tab. */
  openTab(url: string): Promise<void>;
  /** The web app's address, or empty when none is configured. */
  webAppUrl(): Promise<string>;
}

/** The platform of a real extension: `chrome.tabs` and the settings record. */
export const chromePdfHandoffPlatform: PdfHandoffPlatform = {
  activeTab: async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.url === undefined) return null;
    return { url: tab.url, incognito: tab.incognito };
  },
  openTab: async (url) => {
    await chrome.tabs.create({ url });
  },
  webAppUrl: async () => (await getSettings()).webAppUrl,
};

/** Whether an address names a PDF, judged by its path alone. Anything that is not an absolute URL is not one. */
export function isPdfUrl(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  return path.toLowerCase().endsWith(".pdf");
}

/**
 * `handoffUrl(webAppUrl, pdfUrl)` — the address the web app is opened at: F§10.1's import route with the
 * PDF's own address encoded as its one query parameter, so a URL with a query string of its own arrives
 * intact. A trailing slash on the web app's address is trimmed rather than doubled.
 */
export function handoffUrl(webAppUrl: string, pdfUrl: string): string {
  return `${webAppUrl.replace(/\/+$/u, "")}/#/import?url=${encodeURIComponent(pdfUrl)}`;
}

/**
 * `handoffActiveTab(platform)` — hand the active tab's PDF to the web app, or say why it cannot be.
 */
export async function handoffActiveTab(platform: PdfHandoffPlatform = chromePdfHandoffPlatform): Promise<ExtReply> {
  let tab: HandoffTab | null;
  try {
    tab = await platform.activeTab();
  } catch (cause) {
    return failReply(NO_ACTIVE_TAB, messageOf(cause));
  }
  if (tab === null) return failReply(NO_ACTIVE_TAB, "there is no tab to hand off");
  if (tab.incognito) return failReply(LOCAL_FILE, "a private window's page is not handed to the web app");
  if (!isHttpUrl(tab.url)) return failReply(LOCAL_FILE, "a file on this computer cannot be opened by the web app");
  if (!isPdfUrl(tab.url)) return failReply(NOT_A_PDF, "the active tab is not showing a PDF");

  let webAppUrl: string;
  try {
    webAppUrl = await platform.webAppUrl();
  } catch (cause) {
    return failReply(NO_WEB_APP, messageOf(cause));
  }
  if (webAppUrl === "") return failReply(NO_WEB_APP, "no web app address is configured to open a PDF in");

  const url = handoffUrl(webAppUrl, tab.url);
  try {
    await platform.openTab(url);
  } catch (cause) {
    return failReply(NO_WEB_APP, `the web app could not be opened — ${messageOf(cause)}`);
  }
  return okReply({ url });
}

declare global {
  /**
   * The hand-off, driven from a tab a caller names.
   *
   * Chrome hands an extension the active tab's *URL* only when the reader has invoked it — the toolbar button,
   * a context-menu item or a keyboard shortcut all grant `activeTab` for that tab — and a browser test can do
   * none of those things (measured on this host: the accelerator never reaches the extension, and
   * `chrome.tabs.query` reports every tab with no `url` at all). This seam supplies the one value the platform
   * would have supplied — the tab, and its address — while everything else in the handler stays real: the
   * refusals, the hand-off address and the tab that `chrome.tabs.create` opens.
   */
  var lecternPdfHandoff: ((tab: HandoffTab) => Promise<ExtReply>) | undefined;
}

/**
 * Install the feature: register `ext/open-pdf` in the service worker's handler registry, and publish the
 * seam above. Run once when the service worker starts.
 */
export function installPdfHandoff(platform: PdfHandoffPlatform = chromePdfHandoffPlatform): void {
  const answer: Handler = async (message) => {
    if (message.type !== "ext/open-pdf") return failReply(BAD_MESSAGE, "not a PDF hand-off");
    return await handoffActiveTab(platform);
  };
  Object.assign(handlers, { "ext/open-pdf": answer } satisfies Partial<Record<"ext/open-pdf", Handler>>);
  globalThis.lecternPdfHandoff = async (tab) => await handoffActiveTab({ ...platform, activeTab: async () => tab });
}
