/**
 * Page and selection documents (F§10.2, F§5.4): the two ways the extension turns what a user is looking at
 * into a `DocumentModel`.
 *
 * The conversion goes through core, never around it. `buildDocument` is what normalizes the block text
 * again, classifies furniture, tokenizes, numbers sentences across the document and hashes the result into
 * `docId` (F§5.2) — re-implementing any of that here would be a second tokenizer to keep in step with the
 * first. This module's whole job is to hand the builder the blocks and the metadata, and to keep the text
 * map that says where each of those characters came from.
 *
 * A page reads as F§5.1's `html` source and carries the page's own address, so two documents read from
 * different URLs with the same text are still one document by `docId` — the address is where they came
 * from, not what they are. A selection reads as `selection`, because it is a fragment of a page the reader
 * chose by hand and must not be identified with the whole of it.
 */

import { buildDocument, type DocumentModel, type RawBlock, type Source } from "@lectern/core";
import { findArticleRoot } from "./article-root";
import { buildSelectionTextMap, buildTextMap, type TextMap } from "./text-map";
import type { ReadableEnv } from "./visibility";

/** What one extraction produced: the model a reader plays, and the map its highlights are drawn from. */
export interface Extraction {
  document: DocumentModel;
  textMap: TextMap;
}

/**
 * Read the page a document belongs to (F§10.2): find the article root, map its readable text, and build
 * the model. Reading starts at the article root, so a page's chrome is never part of the document.
 */
export function extractPageDocument(doc: Document, env: ReadableEnv): Extraction {
  const root = findArticleRoot(doc);
  const textMap = buildTextMap(root, env);
  return { document: modelOf(textMap, pageSourceOf(doc), titleOf(doc)), textMap };
}

/**
 * Read what a user selected (F§10.2): the ranges of the selection, mapped the same way, as a document of
 * kind `selection`. The selection's own document supplies the language and the title, when it has one.
 */
export function extractSelectionDocument(selection: Selection, env: ReadableEnv): Extraction {
  const ranges = rangesOf(selection);
  const textMap = buildSelectionTextMap(ranges, env);
  const doc = ranges.length === 0 ? null : (ranges[0]?.startContainer.ownerDocument ?? null);
  const source: Source = { kind: "selection" };
  return { document: modelOf(textMap, source, titleOf(doc)), textMap };
}

/** The selection's ranges, in the order the browser keeps them. */
function rangesOf(selection: Selection): Range[] {
  const ranges: Range[] = [];
  for (let index = 0; index < selection.rangeCount; index += 1) ranges.push(selection.getRangeAt(index));
  return ranges;
}

/** Build the model from the map (F§5.4), leaving every identifier and offset to core's builder. */
function modelOf(textMap: TextMap, source: Source, title: string | undefined): DocumentModel {
  const blocks: RawBlock[] = [];
  for (const block of textMap.blocks) {
    blocks.push(
      block.level === undefined ? { kind: block.kind, text: block.text } : { kind: block.kind, level: block.level, text: block.text },
    );
  }
  return buildDocument(blocks, title === undefined ? { source } : { title, source });
}

/** F§5.1's source for a page: `html`, with the page's own address when the document has one. */
function pageSourceOf(doc: Document): Source {
  const uri = uriOf(doc);
  return uri === null ? { kind: "html" } : { kind: "html", uri };
}

/** The address a document is served from, or `null` when it has none to give. */
function uriOf(doc: Document): string | null {
  const href = (doc.defaultView?.location.href ?? "").trim();
  return href === "" ? null : href;
}

/** A document's title, trimmed, or `undefined` when it has none to offer. */
function titleOf(doc: Document | null): string | undefined {
  const title = (doc?.title ?? "").trim();
  return title === "" ? undefined : title;
}
