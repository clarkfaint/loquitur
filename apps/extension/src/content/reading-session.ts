/**
 * The page's half of a reading (F§10.2): extract what the reader is looking at, hand the document to the
 * extension, and paint what the player reports.
 *
 * The content script is the only context that can see the page, and it is the only context that cannot play
 * audio or call the hub, so its job is symmetric: text out, positions back in.
 *
 * - `startPageReading` extracts the article (U-033's `extractPageDocument`), keeps the `TextMap` beside the
 *   model it built, and sends `ext/read-document`; `startSelectionReading` does the same for the reader's own
 *   selection, which F§10.2 stores as a document of its own kind.
 * - an incoming `ext/snapshot` is the *only* thing that moves a highlight. The player lives in the offscreen
 *   document and publishes F§5.6's position; this module resolves that position through the map, paints it,
 *   and asks `@lectern/ui-web`'s auto-scroll policy where the page should be so the line stays in view.
 * - `readFromPoint` is `Alt`+click: it maps synchronously (so the click can be consumed before the page acts on
 *   it) and then starts a reading from the sentence the point names.
 * - `pagehide` ends the reading, because the page the document was extracted from is going away.
 *
 * The whole platform is injected — the document, what can be measured about it, the transport, the clock and
 * the scroll box — so every one of those decisions is a function of values a caller can supply, and the browser
 * only ever supplies them from `entrypoints/content/index.ts`.
 */

import type { DocumentModel, PlayerSnapshot } from "@lectern/core";
import { type AutoScrollPolicy, createAutoScroll, type ScrollClock } from "@lectern/ui-web";
import { type ExtMessage, type ExtReply, failReply, messageOf, okReply } from "../messages";
import { isReadFromHereClick, type PagePosition, positionForPoint } from "./click-to-read";
import { createHighlighter, type PageHighlighter } from "./highlighter";
import { type Extraction, extractPageDocument, extractSelectionDocument } from "./page-document";
import type { TextMap } from "./text-map";
import type { ReadableEnv } from "./visibility";

/** How long the reader's own scrolling suspends auto-scroll (F§10.1's four seconds). */
const SUSPEND_MS = 4000;

/** The answer a selection request gets when there is nothing selected to read. */
export const NO_SELECTION = "NO_SELECTION";

/** The answer a request gets when the message could not be delivered to the extension at all. */
export const NOT_DELIVERED = "NOT_DELIVERED";

/** The answer a message this feature does not answer gets, so the sender learns that rather than nothing. */
export const NOT_HANDLED = "NO_HANDLER";

/** What the content script needs from its page, injected so the reading can be driven without a browser. */
export interface ContentContext {
  /** The page being read. */
  readonly document: Document;
  /** What can be measured about that page: a content script has a layout engine. */
  readonly env: ReadableEnv;
  /** Send one message to the extension's service worker. */
  send(message: ExtMessage): Promise<ExtReply>;
  /** Answer the messages the extension sends to this tab. */
  listen(handler: (message: ExtMessage) => ExtReply | Promise<ExtReply>): void;
  /** The monotonic clock the auto-scroll policy reads. */
  readonly clock: ScrollClock;
  /** The page's own scroll box. */
  readonly view: PageView;
}

/** The scroll box an auto-scroll policy needs, as a page's window provides it. */
export interface PageView {
  /** The viewport height, in pixels. */
  height(): number;
  /** Where the page is scrolled to now, in pixels. */
  scrollY(): number;
  /** Move the page by a number of pixels. */
  scrollBy(deltaY: number): void;
  /** Watch the reader's own scrolling. */
  onScroll(listener: () => void): void;
}

/** What a page's reading offers the rest of the content script. */
export interface PageReadingSession {
  /** Read the page, from its first sentence or from the one the click named. */
  startPageReading(startSentence?: number): Promise<ExtReply>;
  /** Read what the reader has selected. */
  startSelectionReading(): Promise<ExtReply>;
  /** Stop reading the page, and take the highlight down with it. */
  stop(): Promise<ExtReply>;
  /**
   * `Alt`+click: map the point and, when it names a readable word, start reading from there. Answers the
   * position it used — synchronously, so the caller can consume the click — or `null` when the point names
   * nothing the document has.
   */
  readFromPoint(x: number, y: number): PagePosition | null;
  /** Apply the player's state: paint what it is reading, and keep that line in view. */
  apply(snapshot: PlayerSnapshot): void;
}

/**
 * `createReadingSession(context)` — the page's reading over one injected context.
 *
 * One extraction lives at a time, with the highlighter built from the same map, so the ranges a snapshot paints
 * can never belong to a document the player is not reading. Between readings there is nothing: no map, no
 * stylesheet, no listener of its own beyond the two the installation added.
 */
export function createReadingSession(ctx: ContentContext): PageReadingSession {
  const policy: AutoScrollPolicy = createAutoScroll({ clock: ctx.clock, suspendMs: SUSPEND_MS });
  let extraction: Extraction | null = null;
  let highlighter: PageHighlighter | null = null;
  /** The scroll offset the last programmatic move landed on, so it is not mistaken for the reader's own. */
  let landedScrollY: number | null = null;

  /** Nothing is being read: no highlight, no map, no remembered scroll. */
  function forget(): void {
    highlighter?.clear();
    highlighter = null;
    extraction = null;
    landedScrollY = null;
  }

  /** Hand one document to the extension and keep the map its highlights will be resolved through. */
  async function read(source: Extraction, startSentence: number | undefined): Promise<ExtReply> {
    forget();
    extraction = source;
    highlighter = createHighlighter(source.textMap, source.document);
    const message: ExtMessage =
      startSentence === undefined
        ? { type: "ext/read-document", document: source.document }
        : { type: "ext/read-document", document: source.document, startSentence };
    try {
      return await ctx.send(message);
    } catch (cause) {
      return failReply(NOT_DELIVERED, messageOf(cause));
    }
  }

  /** Ask the policy where the page should be for the active word, and move it there if it says so. */
  function follow(sentenceIndex: number, wordIndex: number): void {
    const current = extraction;
    if (current === null) return;
    const range = rangeOf(current.textMap, current.document, sentenceIndex, wordIndex);
    if (range === null) return;
    const delta = policy.target(range.getBoundingClientRect(), ctx.view.height());
    if (delta === null) return;
    const before = ctx.view.scrollY();
    ctx.view.scrollBy(delta);
    const after = ctx.view.scrollY();
    // A page that could not move did not scroll, so nothing is remembered and no later scroll is swallowed.
    landedScrollY = after === before ? null : after;
  }

  ctx.view.onScroll(() => {
    const at = ctx.view.scrollY();
    const wasOurs = landedScrollY !== null && Math.abs(at - landedScrollY) <= 1;
    landedScrollY = null;
    if (!wasOurs) policy.onUserScroll();
  });

  return {
    startPageReading: async (startSentence) => await read(extractPageDocument(ctx.document, ctx.env), startSentence),

    startSelectionReading: async () => {
      const selection = ctx.document.getSelection();
      if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) {
        return failReply(NO_SELECTION, "nothing is selected on this page");
      }
      return await read(extractSelectionDocument(selection, ctx.env), undefined);
    },

    stop: async () => {
      const wasReading = extraction !== null;
      forget();
      if (!wasReading) return okReply(null);
      try {
        return await ctx.send({ type: "ext/stop" });
      } catch (cause) {
        return failReply(NOT_DELIVERED, messageOf(cause));
      }
    },

    readFromPoint: (x, y) => {
      // The extraction is synchronous — Readability over a clone, then core's builder — so a click can be
      // consumed in the same turn it arrived in, and the page never sees a click this reading used.
      const source = extraction ?? extractPageDocument(ctx.document, ctx.env);
      const position = positionForPoint(source.textMap, source.document, x, y);
      if (position === null) return null;
      void read(source, position.sentenceIndex).catch(() => undefined);
      return position;
    },

    apply: (snapshot) => {
      if (snapshot.state === "idle" || snapshot.state === "ended") {
        highlighter?.clear();
        return;
      }
      highlighter?.show(snapshot.sentenceIndex, snapshot.wordIndex);
      follow(snapshot.sentenceIndex, snapshot.wordIndex);
    },
  };
}

/**
 * Install the page's reading on a content script: answer the three messages the page handles, read from an
 * `Alt`+click, and stop when the page is going away.
 *
 * The messages are registered by this function rather than declared in the service worker's registry, because
 * they are this context's own: the router answers what the *extension* is asked, and a page answers what is
 * sent to it. A message this feature does not answer is refused by name so its sender is never left guessing.
 */
export function installReadingSession(ctx: ContentContext): void {
  const session = createReadingSession(ctx);

  ctx.listen((message) => {
    if (message.type === "ext/read-active-tab") return session.startPageReading();
    if (message.type === "ext/read-selection") return session.startSelectionReading();
    if (message.type === "ext/snapshot") {
      session.apply(message.snapshot);
      return okReply(null);
    }
    return failReply(NOT_HANDLED, `the page's reading does not answer ${message.type}`);
  });

  ctx.document.addEventListener("click", (event) => {
    if (!isReadFromHereClick(event)) return;
    if (session.readFromPoint(event.clientX, event.clientY) === null) return;
    event.preventDefault();
    event.stopPropagation();
  });

  ctx.document.defaultView?.addEventListener("pagehide", () => {
    void session.stop();
  });
}

/**
 * The range the active position covers: the word's own characters when the model has that word, else its
 * sentence — a player that reports a position past the last word still names a line worth keeping in view.
 */
function rangeOf(textMap: TextMap, model: DocumentModel, sentenceIndex: number, wordIndex: number): Range | null {
  for (const block of model.blocks) {
    for (const sentence of block.sentences) {
      if (sentence.index !== sentenceIndex) continue;
      const word = sentence.words[wordIndex];
      if (word === undefined) return textMap.rangeFor(block.index, sentence.charStart, sentence.charEnd);
      return textMap.rangeFor(block.index, sentence.charStart + word.charStart, sentence.charStart + word.charEnd);
    }
  }
  return null;
}
