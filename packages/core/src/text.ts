/**
 * The plain-text and Markdown readers (F§5.4, the `TXT / Markdown` row): both are pure text passes with
 * no library behind them, and both return `RawBlock[]` for `buildDocument` to normalize, classify and
 * tokenize.
 *
 * The row's rules are small and are implemented literally: a blank line separates paragraphs, one to
 * six `#` characters open a heading, `-`, `*` or a numbered marker open a list item, `>` opens a quote,
 * and inline Markdown markers are stripped. Code spans are lifted out before the other inline patterns
 * run, so `snake_case_text` inside backticks survives instead of losing the middle of its name.
 */

import type { HeadingLevel, RawBlock } from "./builder";

/** One to six `#` characters, then a space and the heading's text (F§5.4 names no more than six). */
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/u;

/** `-`, `*` or `1.` / `1)` followed by a space, then the item's text. */
const LIST_ITEM = /^ {0,3}(?:[-*]|\d{1,9}[.)])[ \t]+(.*)$/u;

/** `>` followed by the quoted line. */
const QUOTE = /^ {0,3}>[ \t]?(.*)$/u;

/** `![alt](source)` — stripped to its alt text, and before `LINK`, whose pattern it contains. */
const IMAGE = /!\[([^\]]*)\]\([^)]*\)/gu;

/** `[text](target)` — stripped to its text. */
const LINK = /\[([^\]]*)\]\([^)]*\)/gu;

const BOLD_STAR = /\*\*([^\s*][^*\n]*?)\*\*/gu;

const BOLD_UNDERSCORE = /(^|[^_\p{L}\p{N}])__([^_\s][^_\n]*?)__(?![_\p{L}\p{N}])/gu;

const STRIKE = /~~([^~\s][^~\n]*?)~~/gu;

const ITALIC_STAR = /\*([^\s*][^*\n]*?)\*/gu;

const ITALIC_UNDERSCORE = /(^|[^_\p{L}\p{N}])_([^_\s][^_\n]*?)_(?![_\p{L}\p{N}])/gu;

/** A code span, split around so that its content is never read as emphasis. */
const CODE_SPAN = /`([^`\n]+)`/u;

/** Heading levels by hash count, so a level is a lookup rather than a cast (F§5.1, F§5.4). */
const HEADING_LEVELS: ReadonlyArray<HeadingLevel> = [1, 2, 3, 4, 5, 6];

/** The heading level a run of `count` hashes opens, clamped to the six F§5.4 defines. */
function headingLevel(count: number): HeadingLevel {
  return HEADING_LEVELS[count - 1] ?? 1;
}

/** Every inline marker outside a code span, replaced by the text it wraps. */
function stripEmphasis(text: string): string {
  return text
    .replace(IMAGE, "$1")
    .replace(LINK, "$1")
    .replace(BOLD_STAR, "$1")
    .replace(BOLD_UNDERSCORE, "$1$2")
    .replace(STRIKE, "$1")
    .replace(ITALIC_STAR, "$1")
    .replace(ITALIC_UNDERSCORE, "$1$2");
}

/** The input's lines with every line-ending form unified to `\n`. */
function linesOf(input: string): string[] {
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

/** The runs of non-blank lines, each joined back into one string. */
function paragraphsOf(lines: string[]): string[] {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (current.length > 0) paragraphs.push(current.join("\n"));
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) paragraphs.push(current.join("\n"));
  return paragraphs;
}

/**
 * Strip the inline Markdown markers F§5.4 names — emphasis, strong emphasis, strikethrough, inline code,
 * links and images — leaving their text. The text is split around its code spans, so a span's content is
 * never read as emphasis while the backticks that delimit it still go; `_` markers additionally need a
 * non-word character on the outside, so an ordinary `snake_case_name` is not mistaken for emphasis.
 */
export function stripInlineMarkers(text: string): string {
  return text
    .split(CODE_SPAN)
    .map((part, index) => (index % 2 === 1 ? part : stripEmphasis(part)))
    .join("");
}

/**
 * Read a plain-text document (F§5.4): each run of non-blank lines is one paragraph, its lines kept and
 * joined with a newline, and inline Markdown markers are stripped because the row shares that rule
 * with Markdown. Blocks whose text is empty after stripping are not emitted.
 */
export function parseText(input: string): RawBlock[] {
  const blocks: RawBlock[] = [];
  for (const paragraph of paragraphsOf(linesOf(input))) {
    const text = stripInlineMarkers(paragraph);
    if (text !== "") blocks.push({ kind: "paragraph", text });
  }
  return blocks;
}

/**
 * Read a Markdown document (F§5.4): headings by hash run, list items by marker, quotes by `>`, and
 * everything else as paragraphs. Blocks are emitted in document order; a run of consecutive `>` lines is
 * one quote block, and a heading, list item or quote always ends the paragraph that preceded it.
 */
export function parseMarkdown(input: string): RawBlock[] {
  const blocks: RawBlock[] = [];
  let paragraph: string[] = [];
  let quote: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const text = stripInlineMarkers(paragraph.join("\n"));
    if (text !== "") blocks.push({ kind: "paragraph", text });
    paragraph = [];
  };

  const flushQuote = (): void => {
    if (quote.length === 0) return;
    const text = stripInlineMarkers(quote.join("\n"));
    if (text !== "") blocks.push({ kind: "quote", text });
    quote = [];
  };

  for (const line of linesOf(input)) {
    if (line.trim() === "") {
      flushParagraph();
      flushQuote();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      flushParagraph();
      flushQuote();
      const text = stripInlineMarkers(heading[2] ?? "");
      if (text !== "") blocks.push({ kind: "heading", level: headingLevel((heading[1] ?? "").length), text });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item !== null) {
      flushParagraph();
      flushQuote();
      const text = stripInlineMarkers(item[1] ?? "");
      if (text !== "") blocks.push({ kind: "list-item", text });
      continue;
    }
    const quoted = QUOTE.exec(line);
    if (quoted !== null) {
      flushParagraph();
      const text = quoted[1] ?? "";
      if (text.trim() !== "") quote.push(text);
      continue;
    }
    flushQuote();
    paragraph.push(line);
  }

  flushParagraph();
  flushQuote();
  return blocks;
}
