/**
 * The context menu (F§10.2): the two items the extension adds to a page's own menu.
 *
 * The work is one table and one relay. An item's id names the message the clicked tab's content script is
 * sent — "Read selection" asks for the reader's own selection, "Read from here" asks the page's reading to
 * begin — because F§10.2's other paths send exactly those messages, so the menu needs no vocabulary of its
 * own. The relay then names the tab: the service worker cannot read a page, so it asks the content script
 * in the tab the reader is looking at, and reports whatever came back. A tab that answers nothing — no
 * content script, or a page the extension may not script — is refused with the reason the platform gave,
 * which is U-035's own conclusion for the same situation.
 *
 * Three platform facts shape the file, all of them Chrome's rather than Lectern's. The items are created on
 * install and the extension's previous set is removed first, because a reinstalled or updated worker runs
 * its features again and two items with one id would be two entries in the reader's menu. A click names an
 * item and the tab it happened in, and the message a click produces carries no payload at all — a selection
 * is read from the page's own state, never from `info.selectionText`. And the menu belongs to the browser's
 * chrome, which no test in this repository can click: the only handle Chrome offers is
 * `chrome.contextMenus.onClicked`, an event with no way to raise it. The route is therefore published on the
 * worker's own global (`lecternMenuClick`) so that `e2e/full.spec.ts` can drive the very function the
 * browser calls — the same reason F§10.2 asks for the widget's shadow root to be *open*.
 */

import { type ExtMessage, type ExtReply, failReply, messageOf, parseExtReply } from "../messages";
import { NO_ACTIVE_TAB, NO_CONTENT_SCRIPT } from "./read-active-tab";

/** The selection item's id, of Lectern's own naming so no other extension's id can mean it. */
export const READ_SELECTION_ITEM = "lectern-read-selection";

/** The page item's id. */
export const READ_FROM_HERE_ITEM = "lectern-read-from-here";

/** The answer a click on an item this extension does not know gets. */
export const UNKNOWN_ITEM = "UNKNOWN_ITEM";

/**
 * What each item asks the tab for, by the id Chrome reports in `OnClickData`.
 *
 * The page item asks for the page's reading — the one page-reading request the message protocol defines
 * (`ext/read-active-tab`) — because a click carries no hit point: `OnClickData` has no coordinates, so
 * "from here" cannot name a sentence from the menu alone. The alternative would be a fourth message type in
 * a frozen protocol, which this unit may not add.
 */
const ITEM_MESSAGES: Readonly<Record<string, ExtMessage>> = {
  [READ_SELECTION_ITEM]: { type: "ext/read-selection" },
  [READ_FROM_HERE_ITEM]: { type: "ext/read-active-tab" },
};

/** The one field of a click this feature reads: which item the reader chose. */
export interface MenuClick {
  readonly menuItemId: number | string;
}

/** One menu item to create. */
export interface MenuItem {
  readonly id: string;
  readonly title: string;
  /** The one context the item appears in (F§10.2): a text selection, or the page. */
  readonly context: chrome.contextMenus.ContextType;
}

/** What this feature needs from the extension platform, injected so it can be driven without a browser. */
export interface ContextMenuPlatform {
  /** Add one item to the menu. */
  createItem(item: MenuItem): void;
  /** Remove every item this extension has added, so a reload leaves no duplicates. */
  removeAll(): Promise<void>;
  /** Watch clicks. */
  onClicked(listener: (info: MenuClick) => void): void;
  /** The tab the reader is looking at. */
  activeTab(): Promise<number | null>;
  /** Send one message to a tab's content script. */
  toTab(tabId: number, message: ExtMessage): Promise<unknown>;
}

/** The platform of a real extension: `chrome.contextMenus` and `chrome.tabs`. */
export const chromeContextMenuPlatform: ContextMenuPlatform = {
  createItem: (item) => {
    chrome.contextMenus.create({ id: item.id, title: item.title, contexts: [item.context] });
  },
  removeAll: async () => {
    await chrome.contextMenus.removeAll();
  },
  // The click's own tab is not read: F§10.2's rule is "the tab the reader is looking at", and the menu a
  // click came from is that tab's own window.
  onClicked: (listener) => {
    chrome.contextMenus.onClicked.addListener((info) => listener({ menuItemId: info.menuItemId }));
  },
  activeTab: async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id ?? null,
  toTab: async (tabId, message) => await chrome.tabs.sendMessage(tabId, message),
};

/**
 * `routeMenuClick(click, platform)` — do what one click asks, and answer with what the tab said.
 *
 * Every refusal is the protocol's own reply rather than an exception, because a click has no caller to
 * catch one: the answer is read by nothing but a test, and a menu item that did nothing at all would leave
 * the reader guessing.
 */
export async function routeMenuClick(click: MenuClick, platform: ContextMenuPlatform = chromeContextMenuPlatform): Promise<ExtReply> {
  const message = ITEM_MESSAGES[String(click.menuItemId)];
  if (message === undefined) return failReply(UNKNOWN_ITEM, `no item is named ${String(click.menuItemId)}`);
  let target: number | null;
  try {
    target = await platform.activeTab();
  } catch (cause) {
    return failReply(NO_ACTIVE_TAB, messageOf(cause));
  }
  if (target === null) return failReply(NO_ACTIVE_TAB, "there is no tab to read");
  try {
    return parseExtReply(await platform.toTab(target, message));
  } catch (cause) {
    return failReply(NO_CONTENT_SCRIPT, messageOf(cause));
  }
}

declare global {
  /**
   * A menu click, routed as `chrome.contextMenus.onClicked` routes it.
   *
   * Published by `installContextMenu` because a context menu is browser chrome and Playwright has no way to
   * click it: this is the seam an end-to-end case drives instead, and it is the same function the browser's
   * own click calls.
   */
  var lecternMenuClick: ((click: MenuClick) => Promise<ExtReply>) | undefined;
}

/**
 * Install the feature: create the two items and route their clicks. Run once when the service worker starts.
 */
export function installContextMenu(platform: ContextMenuPlatform = chromeContextMenuPlatform): void {
  void platform.removeAll().catch(() => undefined);
  platform.createItem({ id: READ_SELECTION_ITEM, title: "Read selection", context: chrome.contextMenus.ContextType.SELECTION });
  platform.createItem({ id: READ_FROM_HERE_ITEM, title: "Read from here", context: chrome.contextMenus.ContextType.PAGE });
  platform.onClicked((info) => {
    void routeMenuClick(info, platform);
  });
  globalThis.lecternMenuClick = async (click) => await routeMenuClick(click, platform);
}
