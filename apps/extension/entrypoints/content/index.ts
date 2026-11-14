/**
 * The content script (F§10.2): the only part of the extension that can see the page the reader is on.
 *
 * It does one thing — build the page's context and run every content feature against it — because everything
 * else is a feature's business. The context is the whole of this file's judgement: the real document, the
 * layout engine a content script has, the message transport to the service worker, a monotonic clock for the
 * auto-scroll policy, and the window's scroll box.
 *
 * `allFrames: false` is the contract's rule, not WXT's default spelled out for its own sake: a reading is of
 * the page the reader is looking at, and an advertisement in an iframe is not part of it. Nothing here starts a
 * reading — a page is read when a message asks for it, never because it loaded.
 */

import { defineContentScript } from "wxt/utils/define-content-script";
import { contentFeatures } from "../../src/content/features";
import type { ContentContext } from "../../src/content/reading-session";
import { onMessage, sendMessage } from "../../src/messages";

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",
  allFrames: false,
  main() {
    const ctx = contentContext();
    for (const feature of contentFeatures) feature(ctx);
  },
});

/** What this page gives a feature: its document, its messages, its clock and its scroll box. */
function contentContext(): ContentContext {
  return {
    document,
    env: { hasLayout: true },
    send: async (message) => await sendMessage(message),
    listen: (handler) => {
      onMessage((message) => handler(message));
    },
    clock: { now: () => performance.now() },
    view: {
      height: () => window.innerHeight,
      scrollY: () => window.scrollY,
      scrollBy: (deltaY) => {
        window.scrollBy(0, deltaY);
      },
      onScroll: (listener) => {
        window.addEventListener("scroll", listener, { passive: true });
      },
    },
  };
}
