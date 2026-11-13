/**
 * The HTML parser (F§5.4, HTML / URL row): Readability over a linkedom document, mapped by
 * `html-map.ts`.
 *
 * Two properties matter. Extraction is *passive*: the document is parsed, never executed — linkedom
 * loads no subresource and runs no script, so a `<script>` in the input stays inert text in the tree
 * and never reaches a block. And extraction is *total*: when Readability finds no article (`parse()`
 * returns `null`, which it does for a page whose prose is too thin or too unstructured to be an
 * article), the document's own block-level text is mapped instead, so such a page is still read.
 *
 * Readability is asked for the article *node*, not for its serialized HTML (its `serializer` option
 * is what decides): handing the node straight to the walker keeps the article in the tree it was
 * extracted from, and spares the parser a second trip through linkedom.
 */

import { Readability } from "@mozilla/readability";
import { DOMParser } from "linkedom";
import type { RawBlock } from "../builder";
import { mapElementToRawBlocks } from "./html-map";

/** The MIME type that picks linkedom's HTML parser. */
const HTML_MIME = "text/html";

/** What `parseHtml` accepts besides the markup itself. */
export interface ParseHtmlOptions {
  /**
   * The address the markup came from, when it has one. F§5.4 keeps no link data, so this only makes
   * the document's relative references resolvable while it is parsed.
   */
  url?: string;
}

/** What every parser hands to `buildDocument` (F§5.4): raw blocks plus the document's metadata. */
export interface ParsedHtml {
  rawBlocks: RawBlock[];
  title: string;
  lang: string | undefined;
}

/**
 * A linkedom document as the DOM `Document` interface Readability declares, and a linkedom element
 * as the DOM `Element` interface the walker declares. linkedom is a second implementation of those
 * interfaces: the two libraries agree on every member read here, and only the declaration of it
 * differs.
 */
function asNode<T>(node: unknown): T {
  return node as T;
}

/** Parse one HTML string with linkedom. */
function parseDocument(html: string): Document {
  return asNode<Document>(new DOMParser().parseFromString(html, HTML_MIME));
}

/** Readability's article node, as the walker wants it. */
function asArticle(node: Node): Element {
  return asNode<Element>(node);
}

/**
 * The root to map when there is no article: the `body` when it holds the document's text, else the
 * document's root element. Markup that is a fragment rather than a whole document (no `html`
 * element) is a tree linkedom hangs off the first element it meets, with an empty `body`, and the
 * text of such a fragment must still be read.
 */
function rootOf(document: Document): Element | null {
  const body = document.querySelector("body");
  if (body !== null && (body.textContent ?? "").trim() !== "") return asNode<Element>(body);
  const root = document.querySelector("html") ?? document.documentElement;
  return root === null ? null : asNode<Element>(root);
}

/** The document's declared language, trimmed, or `undefined` when it declares none. */
function declaredLang(document: Document): string | undefined {
  const root = document.querySelector("html");
  const trimmed = (root === null ? "" : (root.getAttribute("lang") ?? "")).trim();
  return trimmed === "" ? undefined : trimmed;
}

/** The document's `title` element text, which is the last resort for a title. */
function declaredTitle(document: Document): string {
  const title = document.querySelector("title");
  return (title?.textContent ?? "").trim();
}

/**
 * Give the document the address its markup came from, unless it carries a `<base>` of its own: a
 * `<base href>` is how a URL reaches the relative references inside the document. An address that
 * cannot be parsed as a URL is ignored, because a malformed one must not cost the reader its text.
 */
function applyBaseUrl(document: Document, url: string): void {
  if (!URL.canParse(url)) return;
  const head = document.querySelector("head");
  if (head === null || head.querySelector("base") !== null) return;
  const base = document.createElement("base");
  base.setAttribute("href", url);
  head.appendChild(base);
}

/**
 * Parse HTML into raw blocks and metadata (F§5.4). Readability decides what the article is; a
 * document it refuses is mapped whole, minus the furniture the walker never reads.
 */
export function parseHtml(html: string, options: ParseHtmlOptions = {}): ParsedHtml {
  const document = parseDocument(html);
  if (options.url !== undefined) applyBaseUrl(document, options.url);

  const article = new Readability<Element>(document, { serializer: asArticle }).parse();
  const content = article?.content ?? null;
  const root = content ?? rootOf(document);

  const articleTitle = (article?.title ?? "").trim();
  const articleLang = (article?.lang ?? "").trim();

  return {
    rawBlocks: root === null ? [] : mapElementToRawBlocks(root),
    title: articleTitle === "" ? declaredTitle(document) : articleTitle,
    lang: articleLang === "" ? declaredLang(document) : articleLang,
  };
}
