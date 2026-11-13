/**
 * The DOCX parser (F§5.4, DOCX row): `mammoth.convertToHtml` over the package, then the same HTML
 * mapping a web page goes through.
 *
 * Three properties matter. The conversion belongs to mammoth, which is the point of the row: this
 * module never reads `word/document.xml`, so a package's markup is the library's problem, and
 * nothing else in the container is acted on — no macro is run and no image is embedded, because the
 * mapping keeps text alone. The article walker is deliberately not Readability: a Word document is
 * already one article, and a readability pass over it could only discard a short or unusual one.
 * And the title is read from the package's core properties, which is where a DOCX keeps it:
 * `convertToHtml` returns body markup alone, so its output carries no title.
 *
 * mammoth's output is an HTML *fragment* — a run of block elements with no `html` or `body` — and
 * linkedom parses a fragment into a document whose root element is the first element it met, which
 * would leave every block after the first outside the tree that is mapped. The fragment is wrapped
 * in a minimal document before it is parsed, so the body holds all of it.
 */

import { strFromU8, unzipSync } from "fflate";
import { DOMParser } from "linkedom";
import mammoth from "mammoth";
import type { RawBlock } from "../builder";
import { mapElementToRawBlocks } from "./html-map";

/** The MIME type of a WordprocessingML package (OOXML). */
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** The part every DOCX keeps its document properties in (OOXML). */
const CORE_PROPERTIES_PATH = "docProps/core.xml";

/** The MIME type that picks linkedom's HTML parser: mammoth's output is HTML. */
const HTML_MIME = "text/html";

/** The MIME type that picks linkedom's XML parser: the core properties are XML. */
const XML_MIME = "text/xml";

/**
 * The bytes an OLE2 compound file opens with: the container a legacy `.doc` is written in. F§5.4
 * reads WordprocessingML only, so this signature is a refusal rather than something to interpret.
 */
const OLE2_SIGNATURE: readonly number[] = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** The refusal F§5.4 names for input this parser does not read. */
export type DocxErrorCode = "UNSUPPORTED_FORMAT";

/** A DOCX this module refuses, carrying F§5.4's code for the reason. */
export class DocxParseError extends Error {
  readonly code: DocxErrorCode;

  constructor(code: DocxErrorCode, message: string) {
    super(message);
    this.name = "DocxParseError";
    this.code = code;
  }
}

/** What `parseDocx` hands to `buildDocument` (F§5.4): raw blocks plus the document's own metadata. */
export interface ParsedDocx {
  rawBlocks: RawBlock[];
  title: string;
}

/** Whether the bytes open with the OLE2 signature of a legacy `.doc`. */
function isLegacyDoc(bytes: Uint8Array): boolean {
  if (bytes.length < OLE2_SIGNATURE.length) return false;
  return OLE2_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

/**
 * The local part of an element's name. The core properties are parsed as XML, where the element for
 * `dc:title` keeps its prefix in the name, while a package that declares the Dublin Core namespace
 * as its default writes the same element as `title`. Reading the local name also keeps a colon out
 * of every lookup, and a colon is a pseudo-class to a selector engine.
 */
function localNameOf(element: Element): string {
  const name = element.localName;
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

/** The title the package's core properties declare, trimmed, or `""` when they declare none. */
function coreTitle(bytes: Uint8Array): string {
  // Only the properties part is inflated: a package's images and its other parts are never read.
  const parts = unzipSync(bytes, { filter: (file) => file.name === CORE_PROPERTIES_PATH });
  const markup = parts[CORE_PROPERTIES_PATH];
  if (markup === undefined) return "";
  const document = new DOMParser().parseFromString(strFromU8(markup), XML_MIME) as unknown as Document;
  const declared = [...document.querySelectorAll("*")].find((element) => localNameOf(element) === "title");
  return (declared?.textContent ?? "").trim();
}

/** The root mammoth's fragment is mapped from: the body of a minimal document holding it. */
function bodyOf(fragment: string): Element | null {
  const markup = `<!doctype html><html><body>${fragment}</body></html>`;
  const document = new DOMParser().parseFromString(markup, HTML_MIME) as unknown as Document;
  return document.querySelector("body");
}

/**
 * Parse a DOCX into raw blocks and metadata (F§5.4). The bytes are only ever read from: the
 * conversion is mammoth's, and the one other part this module looks at is the properties file.
 */
export async function parseDocx(bytes: Uint8Array): Promise<ParsedDocx> {
  if (isLegacyDoc(bytes)) {
    throw new DocxParseError("UNSUPPORTED_FORMAT", "a legacy .doc compound file is not a WordprocessingML package");
  }
  const converted = await mammoth.convertToHtml({ buffer: bytes });
  const body = bodyOf(converted.value);
  return { rawBlocks: body === null ? [] : mapElementToRawBlocks(body), title: coreTitle(bytes) };
}
