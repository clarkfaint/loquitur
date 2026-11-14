/**
 * The PDF page view (F§10.1): the document's own pages, drawn by pdfjs, with the sentence and the word
 * being read painted on the text layer above them from F§5.1's anchors.
 *
 * A page here is two renderings of one thing — a raster on a canvas, and the page's text items as
 * spans over it. Because those spans are the page's own items in order and an anchor names one of them
 * by index, an anchored word is a range inside one span, exactly as a word of the reflowed reader is a
 * range inside one block, and the CSS Custom Highlight API paints both the same way under the same two
 * names. Nothing here parses the document a second time and nothing here decides what is read: the
 * anchors are F§5.1's, from the hub, and the page view only draws them.
 *
 * Four properties are load-bearing.
 *
 * - **Only the pages near the viewport are drawn.** Every page has a box of its own size, so the
 *   document's scroll height is right before anything is rendered; a page is built when its box comes
 *   within one page height of the viewport, and its canvas, its text layer and its pdfjs page are
 *   released when it leaves — the contract's "never more than the visible pages plus one on each side".
 * - **The spans of a page are found, not searched for.** The text layer makes one span per item that
 *   carries a string, so the span an `itemIndex` names is the *k*-th span, where *k* counts those items
 *   before it. That map is built once, as the page is drawn, and kept.
 * - **One scale decides everything.** The page box, the canvas's backing store and the text layer's
 *   `--total-scale-factor` are all functions of the `scale` this view is handed, so a page drawn at a
 *   scale has its text layer in the same coordinates as its raster.
 * - **The reader's place decides the page.** A word whose page is not drawn brings that page's box to
 *   the middle of the viewport, which is what makes the page enter the drawn window; the word itself is
 *   then placed by F§10.1's own auto-scroll policy, the one the reflowed reader uses.
 */

import type { PdfAnchor } from "@lectern/core";
import {
  type AutoScrollPolicy,
  clearHighlight,
  createAutoScroll,
  isHighlightSupported,
  SENTENCE_HIGHLIGHT,
  setHighlight,
  type TextPosition,
  WORD_HIGHLIGHT,
} from "@lectern/ui-web";
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy, type PDFPageProxy, TextLayer } from "pdfjs-dist";
import { type MouseEvent, type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { anchorKey, indexAnchors, rangeForAnchor, rectsForAnchor, sentenceAnchors, type TextLayerSpans } from "./pdf-anchors";

/** The id of the `<style>` element this view's rules live in, as the other screens do it. */
const STYLE_ID = "lectern-pdf-view-styles";

/**
 * The worker pdfjs reads a document in. Its address is built from this module's own, so the bundler
 * emits the worker beside the app's assets and the page loads it from where the app is served — never
 * from a content-delivery network (the contract's first *Forbidden Action*).
 */
const WORKER_SOURCE = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).href;

/** How far beyond the viewport a page is drawn, in page heights: one page on each side. */
const DRAW_MARGIN_PAGES = 1;

/** How long a scroll the reader makes by hand suspends the follow (F§10.1). */
const SUSPEND_MS = 4000;

/** The clock the auto-scroll policy reads (F§10.1): monotonic, so a clock change cannot move a page. */
const BROWSER_CLOCK = { now: () => performance.now() };

/** How far a page box may be from the middle of the viewport before it is moved there. */
const PAGE_CENTRE_TOLERANCE_PX = 2;

/**
 * A scroll this close to the position this view itself asked for is its own scroll, not the reader's:
 * a programmatic `scrollBy` raises exactly one `scroll` event, and treating it as the reader's would
 * suspend the follow for four seconds every time it moved the page.
 */
const SELF_SCROLL_TOLERANCE_PX = 1;

/**
 * The rules this view's DOM needs, in the tokens U-023's stylesheet declares.
 *
 * The page box and the canvas are this view's own; the text layer's declarations are its counterpart of
 * the ones the viewer stylesheet ships for `TextLayer`, which positions spans as percentages of the page
 * box, sizes them from the `--font-height` it writes on each span and the `--total-scale-factor` this
 * view writes on the container, and rotates and stretches them through `--rotate` and `--scale-x`. They
 * are written here, scoped to this view, because R6 freezes both stylesheets of the frozen units.
 *
 * The two `::highlight()` rules are what actually paint the word and the sentence. They are injected by
 * whichever reader component is mounted, so a reader who opens the page view without ever mounting the
 * reflowed one still sees a highlight.
 */
const RULES = [
  ".lectern-pdf { align-items: center; display: flex; flex-direction: column; gap: var(--lectern-space-5);",
  "  overflow-x: auto; }",
  ".lectern-pdf__problem { color: var(--lectern-danger); margin: 0; }",
  ".lectern-pdf__pages { align-items: center; display: flex; flex-direction: column; gap: var(--lectern-space-5); }",
  ".lectern-pdf-page { background: var(--lectern-paper); border: 1px solid var(--lectern-line); position: relative; }",
  ".lectern-pdf-page__canvas { display: block; height: 100%; width: 100%; }",
  ".lectern-pdf-page__text { --min-font-size: 1;",
  "  --min-font-size-inv: calc(1 / var(--min-font-size));",
  "  --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));",
  "  forced-color-adjust: none; inset: 0; letter-spacing: normal; line-height: 1; overflow: clip;",
  "  position: absolute; text-align: initial; text-size-adjust: none; transform-origin: 0 0;",
  "  word-spacing: normal; }",
  ".lectern-pdf-page__text span, .lectern-pdf-page__text br { color: transparent; cursor: text; position: absolute;",
  "  transform-origin: 0% 0%; user-select: text; white-space: pre; }",
  ".lectern-pdf-page__text > :not(.markedContent), .lectern-pdf-page__text .markedContent span:not(.markedContent) {",
  "  --font-height: 0; --rotate: 0deg; --scale-x: 1; font-size: calc(var(--text-scale-factor) * var(--font-height));",
  "  transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv)); z-index: 1; }",
  ".lectern-pdf-page__text .markedContent { display: contents; }",
  `::highlight(${SENTENCE_HIGHLIGHT}) { background-color: var(--lectern-sentence); }`,
  `::highlight(${WORD_HIGHLIGHT}) { background-color: var(--lectern-word); }`,
].join("\n");

/** One page's text content, as the page's own `getTextContent()` answers it (F§5.4's item list). */
type PageTextContent = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;

/** One page's size at the scale this view renders at, in CSS pixels. */
interface PageSize {
  width: number;
  height: number;
}

/** A page that is drawn right now: the pdfjs page it came from, and its text layer's spans. */
interface DrawnPage {
  page: PDFPageProxy;
  spans: TextLayerSpans;
}

/** What the page view is handed (F§10.1, F§5.1). */
export interface PdfPageViewProps {
  /** The document's original bytes, as the library holds them (F§5.9). */
  pdfBytes: Uint8Array;
  /** Where every word of the document was drawn (F§5.1). */
  anchors: readonly PdfAnchor[];
  /** The word being read, or `null` before anything has been loaded (F§5.6(d)). */
  active: TextPosition | null;
  /** The scale the pages are laid out and rendered at. */
  scale: number;
  /** Where a click on the page's text wants playback to go. */
  onSeek: (position: TextPosition) => void;
}

/**
 * The text layer's spans, indexed the way a `PdfAnchor` indexes a page's items: the layer makes one
 * span per item carrying a string, so the *k*-th such item's span is found by counting.
 */
function spansOf(items: PageTextContent["items"], spans: readonly HTMLElement[]): TextLayerSpans {
  const byItem: (HTMLElement | null)[] = [];
  let taken = 0;
  for (const item of items) {
    if (!("str" in item) || typeof item.str !== "string") {
      byItem.push(null);
      continue;
    }
    byItem.push(spans[taken] ?? null);
    taken += 1;
  }
  return byItem;
}

/** Every anchor under the page it was drawn on, so a click resolves against one page's items. */
function anchorsByPage(anchors: readonly PdfAnchor[]): Map<number, PdfAnchor[]> {
  const pages = new Map<number, PdfAnchor[]>();
  for (const anchor of anchors) {
    const page = pages.get(anchor.page);
    if (page === undefined) pages.set(anchor.page, [anchor]);
    else page.push(anchor);
  }
  return pages;
}

/**
 * The anchor a click at `offset` of one item resolves to: the word the offset is inside, or the word
 * before it when the offset falls in the whitespace a word's anchor stops short of. A click before the
 * item's first anchor resolves to nothing rather than to a word it is not on.
 */
function anchorAt(pageAnchors: readonly PdfAnchor[], itemIndex: number, offset: number): PdfAnchor | null {
  let before: PdfAnchor | null = null;
  for (const anchor of pageAnchors) {
    if (anchor.itemIndex !== itemIndex) continue;
    if (offset >= anchor.charStart && offset < anchor.charEnd) return anchor;
    if (anchor.charStart <= offset) before = anchor;
  }
  return before;
}

/** Keep one element of a page in the map the effects read, or forget it once it is gone. */
function register<T extends HTMLElement>(map: Map<number, T>, pageNumber: number, element: T | null): void {
  if (element === null) map.delete(pageNumber);
  else map.set(pageNumber, element);
}

/** The page's number, as one of its own elements carries it. */
function pageNumberOf(element: Element): number | null {
  const pageNumber = Number(element.getAttribute("data-pdf-page"));
  return Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : null;
}

/**
 * The pages of one document (F§10.1). It draws what is near the viewport, follows the word being read,
 * and turns a click into a seek — and it owns no playback state at all, because the player does.
 */
export function PdfPageView({ pdfBytes, anchors, active, scale, onSeek }: PdfPageViewProps): ReactElement {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<readonly PageSize[]>([]);
  const [drawn, setDrawn] = useState<readonly number[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  const index = useMemo(() => indexAnchors(anchors), [anchors]);
  const byPage = useMemo(() => anchorsByPage(anchors), [anchors]);
  const activeRef = useRef(active);
  const boxesRef = useRef<Map<number, HTMLElement>>(new Map());
  const canvasesRef = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const layersRef = useRef<Map<number, HTMLElement>>(new Map());
  const pagesRef = useRef<Map<number, DrawnPage>>(new Map());
  const expectedScrollRef = useRef<number | null>(null);
  const policyRef = useRef<AutoScrollPolicy | null>(null);
  policyRef.current ??= createAutoScroll({ clock: BROWSER_CLOCK, suspendMs: SUSPEND_MS });

  // The screen's own rules, once per document (R6 freezes the frozen units' stylesheets).
  useEffect(() => {
    const owner = globalThis.document;
    if (owner.getElementById(STYLE_ID) !== null) return;
    const style = owner.createElement("style");
    style.id = STYLE_ID;
    style.textContent = RULES;
    owner.head.append(style);
  }, []);

  // One pdfjs document per set of bytes, at one scale. The bytes are copied because pdfjs transfers the
  // buffer it is given to its worker (U-007 measured that a second read of the same array then throws).
  useEffect(() => {
    let live = true;
    GlobalWorkerOptions.workerSrc = WORKER_SOURCE;
    const task = getDocument({ data: new Uint8Array(pdfBytes) });

    void (async () => {
      const loaded = await task.promise;
      const pageSizes: PageSize[] = [];
      for (let pageNumber = 1; pageNumber <= loaded.numPages; pageNumber += 1) {
        const page = await loaded.getPage(pageNumber);
        const viewport = page.getViewport({ scale });
        pageSizes.push({ width: viewport.width, height: viewport.height });
      }
      if (!live) return;
      setPdf(loaded);
      setSizes(pageSizes);
    })().catch((cause: unknown) => {
      if (live) setProblem(cause instanceof Error ? cause.message : String(cause));
    });

    return () => {
      live = false;
      setPdf(null);
      setSizes([]);
      setDrawn([]);
      pagesRef.current.clear();
      void task.destroy();
    };
  }, [pdfBytes, scale]);

  // Which boxes are on the screen, watched with one page height of margin on each side. The observer
  // reports what changed, so the set is kept here and every change re-states the drawn pages.
  useEffect(() => {
    if (pdf === null || sizes.length === 0) return;
    const margin = Math.round(Math.max(...sizes.map((size) => size.height)) * DRAW_MARGIN_PAGES);
    const onScreen = new Set<number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageNumber = pageNumberOf(entry.target as Element);
          if (pageNumber === null) continue;
          if (entry.isIntersecting) onScreen.add(pageNumber);
          else onScreen.delete(pageNumber);
        }
        setDrawn([...onScreen].sort((left, right) => left - right));
      },
      { rootMargin: `${margin}px 0px` },
    );
    for (const box of boxesRef.current.values()) observer.observe(box);
    return () => observer.disconnect();
  }, [pdf, sizes]);

  /**
   * `paint(position)` — the active sentence and word as ranges on the text layer, registered under the
   * two frozen names. A page that is not drawn has no spans, so its part of a sentence is simply not
   * registered; a position with no anchor clears both rather than leaving a stale range behind.
   */
  const paint = useCallback(
    (position: TextPosition | null): void => {
      if (!isHighlightSupported()) return;
      clearHighlight(WORD_HIGHLIGHT);
      clearHighlight(SENTENCE_HIGHLIGHT);
      if (position === null) return;

      const word = index.get(anchorKey(position.sentenceIndex, position.wordIndex));
      if (word !== undefined) {
        const range = rangeForAnchor(pagesRef.current.get(word.page)?.spans ?? [], word);
        if (range !== null) setHighlight(WORD_HIGHLIGHT, [range]);
      }

      const ranges: Range[] = [];
      for (const anchor of sentenceAnchors(anchors, position.sentenceIndex)) {
        const range = rangeForAnchor(pagesRef.current.get(anchor.page)?.spans ?? [], anchor);
        if (range !== null) ranges.push(range);
      }
      if (ranges.length > 0) setHighlight(SENTENCE_HIGHLIGHT, ranges);
    },
    [anchors, index],
  );

  // The drawing of the pages that are on the screen, and the release of the ones that left it.
  useEffect(() => {
    if (pdf === null) return;
    let live = true;
    const wanted = new Set(drawn);
    const outputScale = globalThis.devicePixelRatio || 1;

    const build = async (pageNumber: number): Promise<DrawnPage | null> => {
      const canvas = canvasesRef.current.get(pageNumber);
      const layer = layersRef.current.get(pageNumber);
      if (canvas === undefined || layer === undefined) return null;
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      await page.render({
        canvas,
        viewport,
        transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
      }).promise;
      // `getTextContent()` with no arguments, which is the hub parser's own call (U-007): the spans this
      // layer makes and the `itemIndex` F§5.1's anchors carry then count the very same items.
      const content = await page.getTextContent();
      layer.style.setProperty("--total-scale-factor", String(scale));
      const textLayer = new TextLayer({ container: layer, textContentSource: content, viewport });
      await textLayer.render();
      layer.style.width = "100%";
      layer.style.height = "100%";
      return { page, spans: spansOf(content.items, textLayer.textDivs) };
    };

    for (const [pageNumber, entry] of pagesRef.current) {
      if (wanted.has(pageNumber)) continue;
      pagesRef.current.delete(pageNumber);
      entry.page.cleanup();
    }

    void (async () => {
      for (const pageNumber of drawn) {
        if (pagesRef.current.has(pageNumber)) continue;
        const entry = await build(pageNumber);
        if (!live) {
          entry?.page.cleanup();
          return;
        }
        if (entry === null) continue;
        if (!wanted.has(pageNumber)) {
          entry.page.cleanup();
          continue;
        }
        pagesRef.current.set(pageNumber, entry);
      }
      if (live) paint(activeRef.current);
    })();

    return () => {
      live = false;
    };
  }, [drawn, paint, pdf, scale]);

  // F§5.6(d): the highlight follows the word being read, and a restored or seeked position paints
  // without playback having to start.
  useEffect(() => {
    activeRef.current = active;
    paint(active);
  }, [active, paint]);

  // F§10.1's auto-scroll, for a page rather than for reflowed text: the word being read is kept in the
  // upper part of the viewport, and a scroll the reader makes by hand suspends that for four seconds.
  useEffect(() => {
    const policy = policyRef.current;
    if (policy === null) return;

    const scrollBy = (delta: number): void => {
      const before = window.scrollY;
      window.scrollBy(0, delta);
      const after = window.scrollY;
      expectedScrollRef.current = after === before ? null : after;
    };

    const follow = (): void => {
      const position = activeRef.current;
      if (position === null) return;
      const anchor = index.get(anchorKey(position.sentenceIndex, position.wordIndex));
      if (anchor === undefined) return;
      const rects = rectsForAnchor(pagesRef.current.get(anchor.page)?.spans ?? [], anchor);
      const top = rects[0]?.top;
      if (top === undefined) {
        // The word's page is not drawn yet, so bring its box to the middle of the viewport: that is what
        // makes the page enter the drawn window, and the next frame places the word itself.
        const box = boxesRef.current.get(anchor.page);
        if (box === undefined) return;
        const rect = box.getBoundingClientRect();
        const delta = Math.round(rect.top + rect.height / 2 - window.innerHeight / 2);
        if (Math.abs(delta) > PAGE_CENTRE_TOLERANCE_PX) scrollBy(delta);
        return;
      }
      const delta = policy.target({ top }, window.innerHeight);
      if (delta !== null) scrollBy(delta);
    };

    const onScroll = (): void => {
      const expected = expectedScrollRef.current;
      if (expected !== null && Math.abs(window.scrollY - expected) <= SELF_SCROLL_TOLERANCE_PX) return;
      expectedScrollRef.current = null;
      policy.onUserScroll();
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    let frame = 0;
    const step = (): void => {
      follow();
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [index]);

  /**
   * A click on the page's text seeks to the word it landed on. The caret gives the node and the offset
   * inside it, the span that node belongs to gives the `itemIndex` an anchor names, and the anchored
   * word at that offset gives the sentence and the word — the anchors are the only map from the page
   * back to the document, so a click can never seek somewhere the model does not agree with.
   */
  const handleClick = (event: MouseEvent<HTMLElement>): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const layer = target.closest("[data-pdf-text-layer]");
    const box = layer === null ? null : layer.closest("[data-pdf-page]");
    const pageNumber = box === null ? null : pageNumberOf(box);
    if (layer === null || pageNumber === null) return;

    const caret = globalThis.document.caretPositionFromPoint?.(event.clientX, event.clientY) ?? null;
    if (caret === null) return;
    const node = caret.offsetNode;
    const parent = node instanceof Element ? node : node.parentElement;
    const span = parent === null ? null : parent.closest<HTMLElement>("[data-pdf-text-layer] span");
    const spans = pagesRef.current.get(pageNumber)?.spans;
    if (span === null || spans === undefined) return;

    const itemIndex = spans.indexOf(span);
    if (itemIndex < 0) return;
    const offset = node.nodeType === Node.TEXT_NODE ? caret.offset : 0;
    const chosen = anchorAt(byPage.get(pageNumber) ?? [], itemIndex, offset);
    if (chosen !== null) onSeek({ sentenceIndex: chosen.sentenceIndex, wordIndex: chosen.wordIndex });
  };

  return (
    <section className="lectern-pdf" data-pdf-scale={scale}>
      {problem === null ? null : (
        <p className="lectern-pdf__problem" role="alert">
          {problem}
        </p>
      )}
      <div className="lectern-pdf__pages">
        {sizes.map((size, position) => {
          const pageNumber = position + 1;
          const isDrawn = drawn.includes(pageNumber);
          return (
            <div
              className="lectern-pdf-page"
              data-pdf-page={pageNumber}
              data-rendered={isDrawn ? "true" : "false"}
              key={pageNumber}
              ref={(element) => {
                register(boxesRef.current, pageNumber, element);
              }}
              style={{ height: `${size.height}px`, width: `${size.width}px` }}
            >
              {isDrawn ? (
                <>
                  <canvas
                    className="lectern-pdf-page__canvas"
                    data-pdf-canvas="true"
                    ref={(element) => {
                      register(canvasesRef.current, pageNumber, element);
                    }}
                  />
                  {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: the page's text layer is a rendering artifact with no interactive role, so it carries neither a role nor a keyboard handler of its own; the keyboard path to the same seek is the player bar's sentence skip (F§10.1). */}
                  <div
                    className="lectern-pdf-page__text"
                    data-pdf-text-layer="true"
                    onClick={handleClick}
                    ref={(element) => {
                      register(layersRef.current, pageNumber, element);
                    }}
                  />
                </>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
