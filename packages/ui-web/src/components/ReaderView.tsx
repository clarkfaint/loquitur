/**
 * The reader view (F§10.1, F§5.1): the document's blocks as semantic elements, the sentence and the word
 * being read painted through the CSS Custom Highlight API, a click on the text seeking to the word under
 * the pointer, and the active line kept in the upper part of the viewport until the reader scrolls by hand.
 *
 * The component owns no playback state, exactly as the player bar does not: it draws the `active` position
 * it is handed and reports a click as a seek. Three properties of the rendering are load-bearing. A block
 * is one element holding one text node, which is what makes a highlight nothing but a pair of offsets into
 * that node. The list of blocks is computed once per document and per furniture setting, and the component
 * that draws it is memoised on that list, so a new active position rewrites highlight ranges in an effect
 * and never rebuilds the text — the number of elements in the reader is the same after a thousand words as
 * it was after the first. And the page's own scrolling is told apart from the reader's by remembering where
 * the last programmatic scroll landed, because a scroll the reader performs is what suspends auto-scroll
 * for four seconds (F§10.1).
 */

import type { Block, DocumentModel, Sentence } from "@lectern/core";
import { type MouseEvent, memo, type ReactElement, useEffect, useMemo, useRef } from "react";
import { clearHighlight, isHighlightSupported, SENTENCE_HIGHLIGHT, setHighlight, WORD_HIGHLIGHT } from "../highlight/highlight-registry";
import { positionFromPoint, rangeForSentence, rangeForWord, type TextPosition } from "../highlight/locate";
import { type AutoScrollPolicy, createAutoScroll } from "../scroll/auto-scroll";

/** How long a manual scroll suspends auto-scroll (F§10.1). */
const SUSPEND_MS = 4000;

/** How far furniture is dimmed when the reader asks to see it. */
const SKIPPED_OPACITY = 0.55;

/** A scroll this close to the position the reader itself asked for is the reader's own, not the user's. */
const SELF_SCROLL_TOLERANCE_PX = 1;

/** The id of the `<style>` element the two highlight rules live in. */
const HIGHLIGHT_STYLE_ID = "lectern-reader-highlights";

/** The two highlight rules, in the tokens U-023's stylesheet declares, so no colour is invented here. */
const HIGHLIGHT_RULES = [
  `::highlight(${SENTENCE_HIGHLIGHT}) { background-color: var(--lectern-sentence); }`,
  `::highlight(${WORD_HIGHLIGHT}) { background-color: var(--lectern-word); }`,
].join("\n");

/** The clock auto-scroll reads: `performance.now()` is monotonic, so a clock change cannot move the page. */
const BROWSER_CLOCK = { now: () => performance.now() };

/** The attributes every block element carries, including the ones furniture adds. */
interface BlockAttributes {
  "data-block": number;
  "data-skipped"?: "true";
  className: string;
  style?: { opacity: number };
}

/** One run of blocks the renderer draws: a list (all of its items together) or a single block. */
type Renderable = { kind: "list"; items: Block[] } | { kind: "block"; block: Block };

/** The two ranges the active position marks: the sentence always, the word when it has one. */
interface ActiveRanges {
  sentence: Range;
  word: Range | null;
}

export interface ReaderViewProps {
  /** The document to draw (F§5.1). */
  document: DocumentModel;
  /** The word being read, or `null` when nothing is playing. */
  active: TextPosition | null;
  /** Whether furniture is shown dimmed or hidden altogether (F§5.4). */
  showSkipped: boolean;
  /** Where a click on the text wants playback to go. */
  onSeek: (position: TextPosition) => void;
}

/** The block attributes: every block is addressable by its index, furniture is marked and dimmed. */
function blockAttributes(block: Block): BlockAttributes {
  if (!block.skip) return { "data-block": block.index, className: "lectern-reader__block" };
  return {
    "data-block": block.index,
    "data-skipped": "true",
    className: "lectern-reader__block lectern-reader__block--skipped",
    style: { opacity: SKIPPED_OPACITY },
  };
}

/** Add the highlight rules once per document. */
function ensureHighlightRules(owner: Document): void {
  if (owner.getElementById(HIGHLIGHT_STYLE_ID) !== null) return;
  const style = owner.createElement("style");
  style.id = HIGHLIGHT_STYLE_ID;
  style.textContent = HIGHLIGHT_RULES;
  owner.head.append(style);
}

/** The blocks to draw, in document order, with furniture dropped when the reader does not want it. */
function renderable(model: DocumentModel, showSkipped: boolean): Renderable[] {
  const entries: Renderable[] = [];
  for (const block of model.blocks) {
    if (block.skip && !showSkipped) continue;
    const last = entries.at(-1);
    if (block.kind === "list-item" && last !== undefined && last.kind === "list") {
      last.items.push(block);
      continue;
    }
    entries.push(block.kind === "list-item" ? { kind: "list", items: [block] } : { kind: "block", block });
  }
  return entries;
}

/** The sentence with a global index, and the block holding it, among the blocks that are drawn. */
function locateSentence(entries: Renderable[], sentenceIndex: number): { block: Block; sentence: Sentence } | null {
  for (const entry of entries) {
    for (const block of entry.kind === "list" ? entry.items : [entry.block]) {
      for (const sentence of block.sentences) {
        if (sentence.index === sentenceIndex) return { block, sentence };
      }
    }
  }
  return null;
}

/** Resolve the active position against the drawn blocks, or `null` when it cannot be placed. */
function rangesFor(root: Element, entries: Renderable[], active: TextPosition): ActiveRanges | null {
  const found = locateSentence(entries, active.sentenceIndex);
  if (found === null) return null;
  const blockEl = root.querySelector(`[data-block="${found.block.index}"]`);
  if (blockEl === null) return null;
  const word = found.sentence.words[active.wordIndex];
  return {
    sentence: rangeForSentence(blockEl, found.sentence),
    word: word === undefined ? null : rangeForWord(blockEl, found.sentence, word),
  };
}

/** One heading, at the level F§5.1 gives it. */
function headingElement(block: Block, attributes: BlockAttributes): ReactElement {
  const text = block.text;
  switch (block.level ?? 1) {
    case 2:
      return (
        <h2 {...attributes} key={block.index}>
          {text}
        </h2>
      );
    case 3:
      return (
        <h3 {...attributes} key={block.index}>
          {text}
        </h3>
      );
    case 4:
      return (
        <h4 {...attributes} key={block.index}>
          {text}
        </h4>
      );
    case 5:
      return (
        <h5 {...attributes} key={block.index}>
          {text}
        </h5>
      );
    case 6:
      return (
        <h6 {...attributes} key={block.index}>
          {text}
        </h6>
      );
    default:
      return (
        <h1 {...attributes} key={block.index}>
          {text}
        </h1>
      );
  }
}

/**
 * One block as the element its kind asks for (F§5.1): a heading, a paragraph, a quote — or, for the kinds
 * that have no element of their own (a caption, and the furniture kinds), a paragraph. Every one of them
 * holds a single text node.
 */
function blockElement(block: Block): ReactElement {
  const attributes = blockAttributes(block);
  if (block.kind === "heading") return headingElement(block, attributes);
  if (block.kind === "quote")
    return (
      <blockquote {...attributes} key={block.index}>
        {block.text}
      </blockquote>
    );
  return (
    <p {...attributes} key={block.index}>
      {block.text}
    </p>
  );
}

/** Draw one run: a list wraps its items, everything else is a block on its own. */
function drawEntry(entry: Renderable): ReactElement {
  if (entry.kind === "block") return blockElement(entry.block);
  const first = entry.items[0];
  return (
    <ul className="lectern-reader__list" key={`list-${first === undefined ? 0 : first.index}`}>
      {entry.items.map((block) => (
        <li {...blockAttributes(block)} key={block.index}>
          {block.text}
        </li>
      ))}
    </ul>
  );
}

/**
 * The text of the document. Memoised on the list of blocks, so a position change re-renders this component
 * only when the text itself changed — which is what keeps a highlight update from touching an element.
 */
const ReaderBlocks = memo(function ReaderBlocks({ entries }: { entries: Renderable[] }) {
  return <>{entries.map(drawEntry)}</>;
});

/**
 * The reader. It draws the document, keeps the highlights on the active sentence and word, follows the
 * active line while it is playing, and turns a click into a seek — and it does nothing else, because the
 * player, not the reader, owns playback.
 */
export function ReaderView({ document: model, active, showSkipped, onSeek }: ReaderViewProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const policyRef = useRef<AutoScrollPolicy | null>(null);
  policyRef.current ??= createAutoScroll({ clock: BROWSER_CLOCK, suspendMs: SUSPEND_MS });
  const activeRangeRef = useRef<Range | null>(null);
  const expectedScrollRef = useRef<number | null>(null);
  const entries = useMemo(() => renderable(model, showSkipped), [model, showSkipped]);

  // Highlights are ranges, not markup: a new position rewrites the two registered ranges and nothing else.
  useEffect(() => {
    const root = rootRef.current;
    const supported = isHighlightSupported();
    if (supported) ensureHighlightRules(document);
    const ranges = root === null || active === null ? null : rangesFor(root, entries, active);
    activeRangeRef.current = ranges === null ? null : ranges.word;
    if (!supported) return;
    if (ranges === null) {
      clearHighlight(SENTENCE_HIGHLIGHT);
      clearHighlight(WORD_HIGHLIGHT);
      return;
    }
    setHighlight(SENTENCE_HIGHLIGHT, [ranges.sentence]);
    if (ranges.word === null) {
      clearHighlight(WORD_HIGHLIGHT);
      return;
    }
    setHighlight(WORD_HIGHLIGHT, [ranges.word]);
  }, [entries, active]);

  // The active line is followed every frame, and the reader's own scrolling suspends that for four seconds.
  useEffect(() => {
    const policy = policyRef.current;
    if (policy === null) return;
    const follow = (): void => {
      const range = activeRangeRef.current;
      if (range === null) return;
      const delta = policy.target(range.getBoundingClientRect(), window.innerHeight);
      if (delta === null) return;
      const before = window.scrollY;
      window.scrollBy(0, delta);
      const after = window.scrollY;
      expectedScrollRef.current = after === before ? null : after;
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
  }, []);

  const handleClick = (event: MouseEvent<HTMLElement>): void => {
    const root = rootRef.current;
    const target = event.target;
    if (root === null || !(target instanceof Element)) return;
    // Furniture is shown for reference, not for playback (F§5.4): a click on it seeks nowhere.
    if (target.closest('[data-skipped="true"]') !== null) return;
    const point = positionFromPoint(root, model, event.clientX, event.clientY);
    if (point === null) return;
    onSeek(point);
  };

  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the text is not a control, so it takes no keyboard handler of its own; the keyboard path to the same seek is the player bar's sentence skip (F§10.1). */}
      <article className="lectern-reader" onClick={handleClick} ref={rootRef}>
        <ReaderBlocks entries={entries} />
      </article>
    </>
  );
}
