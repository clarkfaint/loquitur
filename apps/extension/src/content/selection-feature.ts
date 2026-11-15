/**
 * The widget's error state (F§10.2), and the reader's selection's place in the content script.
 *
 * F§10.2 stores a selection as a document of its own kind, and the request that asks for one is
 * `ext/read-selection`. Two facts decide what this file does with it.
 *
 * The request is already answered, by U-035's reading session: `reading-session.ts` registers the page's one
 * responder and answers `ext/read-active-tab`, `ext/read-selection` and `ext/snapshot` with the extraction
 * this page already has. A second session built over the same selection is not a second *answer* — it is a
 * second *relay*: measured in this unit's rehearsal, one click then sends `ext/read-document` twice and the two
 * relays race each other's offscreen document, the second answering `OFFSCREEN_UNAVAILABLE` ("only a single
 * offscreen document may be created"). This file therefore leaves the selection request to the file that owns
 * it and answers no message at all — see `watchMessages` for why a content-script feature may not be the
 * second responder either, and `docs/evidence/U-037.md` §7 for the proposal that would let one file own it.
 *
 * What this file does own is the part of a reading a *view* has to show: the widget's error state. When a
 * snapshot arrives carrying `PlayerSnapshot.error`, the failure is drawn inside the widget's own shadow root,
 * because that is where the reader is looking when a reading does not start. The banner is mounted, updated and
 * taken down from here because `Widget.tsx` is U-036's frozen file (R6) and because F§10.2 asks for the
 * widget's shadow root to be *open* — the one surface a feature that is not the widget may add to. Its styles
 * name the widget's own `--lectern-*` tokens, so it looks like the widget without a stylesheet this file has
 * nowhere to put.
 *
 * Note on timing, measured: the service worker forwards the player's state to the tab only while it has an
 * active reading tab, and it records that tab *after* the load it is relaying has answered — so a first
 * attempt that fails while loading is not forwarded, and the widget shows the error from the next snapshot that
 * is (the reader's second press of play). Filed as a deviation proposal with the measurement.
 */

import type { PlayerSnapshot } from "@lectern/core";
import { type ExtMessage, parseExtMessage } from "../messages";
import type { ContentContext } from "./reading-session";
import { WIDGET_HOST_TAG } from "./widget/mount";

/** The attribute that finds the widget's error banner, and that carries the player's error code. */
export const WIDGET_ERROR_ATTRIBUTE = "data-lectern-widget-error";

/** What the banner says in front of the player's own message. */
export const WIDGET_ERROR_TEXT = "This page could not be read aloud.";

/** The banners this page has mounted, by the shadow root that holds each one. */
const banners = new WeakMap<ShadowRoot, HTMLElement>();

/**
 * Show, update or take down the widget's error banner for one player snapshot.
 *
 * A snapshot with no error clears it: the player leaving `error` is the reader's cue that the next press of
 * play is worth trying. A page with no widget on it has nowhere to show the state, and the next snapshot tries
 * again — the widget mounts on demand, so a failure that arrives before it is offered is not lost.
 */
export function applyWidgetError(ctx: ContentContext, error: PlayerSnapshot["error"]): void {
  const root = ctx.document.querySelector(WIDGET_HOST_TAG)?.shadowRoot ?? null;
  const mounted = root === null ? undefined : banners.get(root);
  if (error === null) {
    if (root !== null && mounted !== undefined) {
      mounted.remove();
      banners.delete(root);
    }
    return;
  }
  if (root === null) return;
  const banner = mounted ?? createBanner(ctx.document);
  if (mounted === undefined) {
    root.append(banner);
    banners.set(root, banner);
  }
  banner.setAttribute(WIDGET_ERROR_ATTRIBUTE, error.code);
  banner.textContent = `${WIDGET_ERROR_TEXT} ${error.message}`;
}

/**
 * The banner element: one block of the widget's own tokens, drawn from the host rather than from a stylesheet,
 * because the stylesheets inside that shadow root are U-036's files.
 */
function createBanner(doc: Document): HTMLElement {
  const banner = doc.createElement("div");
  banner.setAttribute(WIDGET_ERROR_ATTRIBUTE, "");
  banner.setAttribute("role", "status");
  const style = banner.style;
  style.background = "var(--lectern-surface)";
  style.border = "1px solid var(--lectern-danger)";
  style.borderRadius = "var(--lectern-radius-2)";
  style.boxSizing = "border-box";
  style.color = "var(--lectern-danger)";
  style.display = "block";
  style.font = "500 0.8125rem/1.4 var(--lectern-font)";
  style.inlineSize = "16rem";
  // A page's own `text-align` and `direction` are inherited across a shadow boundary; both are pinned here so
  // the widget's text reads the same on any page.
  style.textAlign = "start";
  style.marginBlockStart = "var(--lectern-space-2)";
  style.padding = "var(--lectern-space-2) var(--lectern-space-3)";
  return banner;
}

/**
 * Watch the messages the extension sends to this tab, without answering any of them.
 *
 * `ctx.listen` is a *responder*: it registers one more `chrome.runtime.onMessage` listener that answers every
 * message of the protocol, and a tab is reached with `chrome.tabs.sendMessage`, whose reply is a race between
 * the listeners that answer it. U-036 measured what that costs — a second responder refused
 * `ext/read-active-tab` with `NO_HANDLER` before the page's reading session could answer, and the caller read
 * that refusal as a failure of the reading. The page has exactly one responder (U-035's reading session); this
 * listener returns nothing, so it competes with nobody and only acts.
 */
function watchMessages(handler: (message: ExtMessage) => void): void {
  chrome.runtime.onMessage.addListener((raw: unknown) => {
    const message = parseExtMessage(raw);
    if (message === null) return;
    handler(message);
  });
}

/** Install the feature on a content script: show a reading that failed, in the widget the reader is using. */
export function installSelectionFeature(ctx: ContentContext): void {
  watchMessages((message) => {
    if (message.type === "ext/snapshot") applyWidgetError(ctx, message.snapshot.error);
  });
}
