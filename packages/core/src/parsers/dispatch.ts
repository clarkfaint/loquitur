/**
 * The unified document dispatcher (F§5.4's *Dispatcher* paragraph): one entry point that takes the
 * bytes of an uploaded file and decides, on evidence, which parser reads them.
 *
 * The order of evidence is the paragraph's and is load-bearing. Magic bytes come first, because they
 * are a property of the bytes themselves and a name or a declared type is only a claim about them;
 * the declared MIME type comes second, and the file extension last. A file whose bytes are a PDF is
 * read as a PDF whatever it is called. Only when none of the three identifies the input does the
 * text fallback apply: bytes that decode as UTF-8 without a replacement character are text.
 *
 * Two container formats share a signature, so a ZIP's entries are read to tell them apart — a
 * `mimetype` entry makes it an EPUB, a `word/document.xml` entry makes it a DOCX. The entry names
 * are collected through `unzipSync`'s filter, which is called for every entry before its data is
 * expanded and skipped when it answers `false`, so nothing is inflated to sniff a container.
 *
 * Failures are never swallowed: every error a parser raises is mapped to a `ParseError` carrying one
 * of the five codes F§5.4 names, with the original message kept.
 */

import { unzipSync } from "fflate";
import type { RawBlock } from "../builder";
import { buildDocument } from "../builder";
import type { DocumentModel, PdfAnchor, SourceKind } from "../model";
import type { OcrEngine } from "../ocr";
import { parseMarkdown } from "../text";
import { DOCX_MIME, DocxParseError, parseDocx } from "./docx";
import { EPUB_MIME, EpubParseError, parseEpub } from "./epub";
import { parseHtml } from "./html";
import { parseImage } from "./image";
import { anchorsFor, PDF_MIME, parsePdf } from "./pdf";

/** The MIME type F§5.4's text fallback produces. */
const TEXT_MIME = "text/plain";

/** The MIME type a web page is read as, whether it arrived as a file or at an address. */
const HTML_MIME = "text/html";

/** The image types F§5.4 names as signatures, and the MIME each one is recorded as. */
const PNG_MIME = "image/png";
const JPEG_MIME = "image/jpeg";
const WEBP_MIME = "image/webp";

/** The entry that tells an EPUB from every other ZIP (F§5.4). */
const EPUB_MIMETYPE_ENTRY = "mimetype";

/** The entry that tells a DOCX from every other ZIP (F§5.4). */
const DOCX_DOCUMENT_ENTRY = "word/document.xml";

/** How many bytes of a JPEG's own signature are fixed. */
const JPEG_SIGNATURE: readonly number[] = [0xff, 0xd8, 0xff];

/** How many bytes of a PNG's own signature are fixed. */
const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Every ZIP starts with these two bytes; which container it is takes the entry list (F§5.4). */
const ZIP_SIGNATURE: readonly number[] = [0x50, 0x4b];

/**
 * The markup a web page opens with, in lower case. F§5.4's signature list names the binary formats,
 * because those are the ones a byte test can settle; a page's own opening markup is the same kind of
 * evidence, and without it a page that arrives with no declared type would be read as prose — the
 * contract requires every fixture to be identified from its bytes alone. The two prefixes below are
 * the ones a document that *is* a web page opens with; a fragment of markup is not one.
 */
const MARKUP_SIGNATURES: readonly string[] = ["<!doctype html", "<html"];

/** The one format the dispatcher resolves to that F§5.1's `SourceKind` has no member for. */
export type ImageKind = "image";

/** What `sniffFormat` answers with: a source kind, the image marker, or `null` when unidentified. */
export type SniffedFormat = SourceKind | ImageKind;

/** The formats the dispatcher reads, which are F§5.1's byte-borne source kinds plus an image. */
type ByteFormat = "pdf" | "epub" | "docx" | "html" | "txt" | ImageKind;

/** A format and the MIME type the bytes are recorded as (F§5.1's `source.mime`). */
interface Identified {
  format: ByteFormat;
  mime: string;
}

/** What `sniffFormat` and `parseDocument` may be told about the bytes besides the bytes. */
export interface FormatHint {
  /** The MIME type the caller declares for the input. */
  mime?: string;
  /** The file name the input arrived under, whose extension is the last resort. */
  filename?: string;
}

/** The five refusals F§5.4 gives the dispatcher. */
export type ParseErrorCode = "UNSUPPORTED_FORMAT" | "INVALID_EPUB" | "DRM_PROTECTED" | "PARSE_FAILED" | "EMPTY_DOCUMENT";

/** A refused document: F§5.4's code for the reason, and the message that explains it. */
export class ParseError extends Error {
  readonly code: ParseErrorCode;

  constructor(code: ParseErrorCode, message: string) {
    super(message);
    this.name = "ParseError";
    this.code = code;
  }
}

/** What `parseDocument` is given: the bytes, and whatever the caller knows about them. */
export interface ParseDocumentInput {
  bytes: Uint8Array;
  /** The declared MIME type, which is evidence only when the bytes identify nothing. */
  mime?: string;
  /** The name the bytes arrived under, whose extension is the last resort. */
  filename?: string;
  /** The address the bytes came from, recorded as F§5.1's `source.uri`. */
  url?: string;
}

/** What `parseDocument` may be given besides the input: the engine F§5.5's OCR path needs. */
export interface ParseDocumentDeps {
  /** The OCR engine an image or a scanned page is read with. Without one, neither can be read. */
  ocr?: OcrEngine;
}

/** Everything a parse hands back: the document, and the anchors a paged source produced. */
export interface ParsedDocument {
  document: DocumentModel;
  /** Present for PDFs only; F§5.4 gives anchors to the text layer of a paged source. */
  anchors?: PdfAnchor[];
}

/** The MIME types F§5.4's formats are declared as, keyed by the normalized type. */
const MIME_FORMATS: Readonly<Record<string, ByteFormat>> = {
  "application/pdf": "pdf",
  "application/epub+zip": "epub",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "text/html": "html",
  "application/xhtml+xml": "html",
  "text/plain": "txt",
  "text/markdown": "txt",
  "text/x-markdown": "txt",
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
};

/** The file extensions F§5.4's formats are named with, and the MIME each one stands for. */
const EXTENSION_FORMATS: Readonly<Record<string, Identified>> = {
  ".pdf": { format: "pdf", mime: PDF_MIME },
  ".epub": { format: "epub", mime: EPUB_MIME },
  ".docx": { format: "docx", mime: DOCX_MIME },
  ".html": { format: "html", mime: HTML_MIME },
  ".htm": { format: "html", mime: HTML_MIME },
  ".xhtml": { format: "html", mime: HTML_MIME },
  ".txt": { format: "txt", mime: TEXT_MIME },
  ".text": { format: "txt", mime: TEXT_MIME },
  ".md": { format: "txt", mime: TEXT_MIME },
  ".markdown": { format: "txt", mime: TEXT_MIME },
  ".png": { format: "image", mime: PNG_MIME },
  ".jpg": { format: "image", mime: JPEG_MIME },
  ".jpeg": { format: "image", mime: JPEG_MIME },
  ".webp": { format: "image", mime: WEBP_MIME },
};

/** Whether the bytes begin with an exact byte sequence. */
function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

/** Whether the bytes carry `text`, as ASCII, at `offset`. */
function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[index + offset] !== text.charCodeAt(index)) return false;
  }
  return true;
}

/** A MIME type without its parameters, trimmed and lower-cased, which is how the tables are keyed. */
function normalizeMime(mime: string): string {
  const [type] = mime.split(";");
  return (type ?? "").trim().toLowerCase();
}

/** How much of a document's head is read when looking for an opening markup prefix. */
const MARKUP_HEAD_LENGTH = 32;

/** Whether a byte may precede a document's first element: the ASCII whitespace of a text file. */
function isAsciiSpace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x0c;
}

/**
 * The document's opening bytes as lower-cased ASCII, past any leading whitespace, or `""` when it
 * opens with a non-ASCII byte. Only an ASCII head can carry a markup prefix, so a byte above the
 * ASCII range ends the read rather than being decoded into one.
 */
function asciiHead(bytes: Uint8Array, length: number): string {
  let offset = 0;
  while (offset < bytes.length && isAsciiSpace(bytes[offset] ?? 0)) offset += 1;
  let head = "";
  for (let index = offset; index < bytes.length && head.length < length; index += 1) {
    const byte = bytes[index] ?? 0;
    if (byte > 0x7e) break;
    head += String.fromCharCode(byte);
  }
  return head.toLowerCase();
}

/** Whether the bytes open with the markup of a web page rather than with prose. */
function opensWithMarkup(bytes: Uint8Array): boolean {
  const head = asciiHead(bytes, MARKUP_HEAD_LENGTH);
  return MARKUP_SIGNATURES.some((signature) => head.startsWith(signature));
}

/** The lower-cased extension of a file name, or `""` when it carries none. */
function extensionOf(filename: string): string {
  const name = filename.trim().toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  const separator = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  return dot < separator ? "" : name.slice(dot);
}

/**
 * Every entry name a ZIP holds, read from its central directory with nothing expanded. The filter
 * runs for each entry before its data is touched and answers `false` for all of them, so the archive
 * is listed rather than unpacked. An archive whose directory cannot be read at all is not a
 * container this dispatcher can name: the answer is `null`, and the refusal surfaces from whichever
 * parser the declared type or the extension selects next, or as `UNSUPPORTED_FORMAT`.
 */
function zipEntryNames(bytes: Uint8Array): string[] | null {
  const names: string[] = [];
  try {
    unzipSync(bytes, {
      filter: (file) => {
        names.push(file.name);
        return false;
      },
    });
  } catch {
    return null;
  }
  return names;
}

/** The container a ZIP is, by the entries F§5.4 names, or `null` when it is neither of them. */
function zipFormat(bytes: Uint8Array): Identified | null {
  const names = zipEntryNames(bytes);
  if (names === null) return null;
  if (names.includes(EPUB_MIMETYPE_ENTRY)) return { format: "epub", mime: EPUB_MIME };
  if (names.includes(DOCX_DOCUMENT_ENTRY)) return { format: "docx", mime: DOCX_MIME };
  return null;
}

/** The format the bytes' own signatures identify, or `null` when none of them matches. */
function magicFormat(bytes: Uint8Array): Identified | null {
  if (asciiAt(bytes, 0, "%PDF")) return { format: "pdf", mime: PDF_MIME };
  if (startsWith(bytes, PNG_SIGNATURE)) return { format: "image", mime: PNG_MIME };
  if (startsWith(bytes, JPEG_SIGNATURE)) return { format: "image", mime: JPEG_MIME };
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) return { format: "image", mime: WEBP_MIME };
  if (startsWith(bytes, ZIP_SIGNATURE)) return zipFormat(bytes);
  if (opensWithMarkup(bytes)) return { format: "html", mime: HTML_MIME };
  return null;
}

/** The format the caller's declarations identify: the MIME type first, then the extension. */
function hintFormat(hint: FormatHint): Identified | null {
  if (hint.mime !== undefined) {
    const declared = normalizeMime(hint.mime);
    const format = MIME_FORMATS[declared];
    if (format !== undefined) return { format, mime: declared };
  }
  if (hint.filename !== undefined) {
    const named = EXTENSION_FORMATS[extensionOf(hint.filename)];
    if (named !== undefined) return named;
  }
  return null;
}

/** Whether the bytes are UTF-8 text: a strict decode, so a replacement character is a refusal. */
function decodesAsUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * What the input is, in F§5.4's order: the bytes' signatures, then the declared MIME type, then the
 * extension, and last the text fallback. `null` means the input is neither a format this dispatcher
 * reads nor UTF-8 text.
 */
function resolve(bytes: Uint8Array, hint: FormatHint): Identified | null {
  const magic = magicFormat(bytes);
  if (magic !== null) return magic;
  const declared = hintFormat(hint);
  if (declared !== null) return declared;
  return decodesAsUtf8(bytes) ? { format: "txt", mime: TEXT_MIME } : null;
}

/**
 * Identify the input's format without parsing it (F§5.4): `'image'` for an image, a `SourceKind`
 * for everything else this dispatcher reads, and `null` for bytes that are neither a known format
 * nor UTF-8 text. Nothing here reads the content of a document, so the answer is cheap and safe to
 * ask for before deciding to parse at all.
 */
export function sniffFormat(bytes: Uint8Array, hint: FormatHint = {}): SniffedFormat | null {
  const resolved = resolve(bytes, hint);
  return resolved === null ? null : resolved.format;
}

/** The bytes as UTF-8 text, refusing — rather than replacing — anything that is not. */
function textOf(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** An error's message, whatever was thrown. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Map every parser failure to F§5.4's own refusals, keeping the original message. A refusal this
 * module already made passes through untouched, an EPUB's two codes and a DOCX's one are kept as
 * they are, and anything else — a library's own throw, a strict decode, a malformed container — is
 * a `PARSE_FAILED`. Nothing is swallowed and nothing is guessed at.
 */
function toParseError(error: unknown): ParseError {
  if (error instanceof ParseError) return error;
  if (error instanceof EpubParseError) return new ParseError(error.code, error.message);
  if (error instanceof DocxParseError) return new ParseError(error.code, error.message);
  return new ParseError("PARSE_FAILED", messageOf(error));
}

/** The F§5.1 `source.uri` for a caller-supplied address, or nothing when there is none. */
function uriOf(input: ParseDocumentInput): { uri?: string } {
  return input.url === undefined ? {} : { uri: input.url };
}

/**
 * The title a parser found, as `buildDocument` wants it. A parser that found none hands over an
 * empty string, which is not a title: it is left out so F§5.1's own rule applies — the first
 * heading, else the first 60 characters of the first block.
 */
function titleOf(title: string): { title?: string } {
  return title === "" ? {} : { title };
}

/** Refuse a document that carries no text: F§5.4's `EMPTY_DOCUMENT`. */
function assertNotEmpty(document: DocumentModel): DocumentModel {
  if (document.blocks.length === 0) {
    throw new ParseError("EMPTY_DOCUMENT", "the input holds no text the reader could read");
  }
  return document;
}

/** Read a PDF, with the OCR engine when the caller supplied one, and anchor its words (F§5.4). */
async function parseAsPdf(input: ParseDocumentInput, deps: ParseDocumentDeps): Promise<ParsedDocument> {
  const parsed = await parsePdf(input.bytes, deps.ocr === undefined ? {} : { ocr: deps.ocr });
  const document = assertNotEmpty(
    buildDocument(parsed.rawBlocks, {
      ...titleOf(parsed.title),
      source: { kind: "pdf", mime: PDF_MIME, ...uriOf(input), pageCount: parsed.pageCount },
    }),
  );
  return { document, anchors: anchorsFor(document, parsed.wordAnchors) };
}

/** Read an EPUB (F§5.4), keeping the book's own language when it declares one. */
async function parseAsEpub(input: ParseDocumentInput): Promise<ParsedDocument> {
  const parsed = await parseEpub(input.bytes);
  const document = assertNotEmpty(
    buildDocument(parsed.rawBlocks, {
      ...titleOf(parsed.title),
      ...(parsed.lang === undefined ? {} : { lang: parsed.lang }),
      source: { kind: "epub", mime: EPUB_MIME, ...uriOf(input) },
    }),
  );
  return { document };
}

/** Read a DOCX (F§5.4). */
async function parseAsDocx(input: ParseDocumentInput): Promise<ParsedDocument> {
  const parsed = await parseDocx(input.bytes);
  const document = assertNotEmpty(
    buildDocument(parsed.rawBlocks, {
      ...titleOf(parsed.title),
      source: { kind: "docx", mime: DOCX_MIME, ...uriOf(input) },
    }),
  );
  return { document };
}

/**
 * Read HTML or a web page (F§5.4's HTML / URL row). An input that came from an address is recorded
 * as a `url`, which is what that kind is for; markup read from a file is `html`.
 */
function parseAsHtml(input: ParseDocumentInput): ParsedDocument {
  const parsed = parseHtml(textOf(input.bytes), input.url === undefined ? {} : { url: input.url });
  const source =
    input.url === undefined ? { kind: "html" as const, mime: HTML_MIME } : { kind: "url" as const, mime: HTML_MIME, uri: input.url };
  const document = assertNotEmpty(
    buildDocument(parsed.rawBlocks, {
      ...titleOf(parsed.title),
      ...(parsed.lang === undefined ? {} : { lang: parsed.lang }),
      source,
    }),
  );
  return { document };
}

/**
 * Read plain text or Markdown (F§5.4's TXT / Markdown row). The row gives both formats one set of
 * rules — a blank line separates paragraphs, `#`…`######` open headings, list markers and `>` open
 * list items and quotes, and inline markers are stripped — so one reader serves them, and the two
 * renderings of one document read back as the same document.
 */
function parseAsText(input: ParseDocumentInput): ParsedDocument {
  const rawBlocks: RawBlock[] = parseMarkdown(textOf(input.bytes));
  const document = assertNotEmpty(buildDocument(rawBlocks, { source: { kind: "txt", mime: TEXT_MIME, ...uriOf(input) } }));
  return { document };
}

/**
 * Read an image through the OCR engine (F§5.5). An image has no text layer and no other way in, so
 * without an engine there is nothing to read and the refusal says so.
 */
async function parseAsImage(input: ParseDocumentInput, deps: ParseDocumentDeps, mime: string): Promise<ParsedDocument> {
  const ocr = deps.ocr;
  if (ocr === undefined) {
    throw new ParseError("PARSE_FAILED", "reading an image needs an OCR engine, and none was supplied");
  }
  const parsed = await parseImage(input.bytes, ocr);
  const document = assertNotEmpty(
    buildDocument(parsed.rawBlocks, {
      ...titleOf(parsed.title),
      source: { kind: "ocr", mime, ...uriOf(input) },
    }),
  );
  return { document };
}

/** Read the identified format (F§5.4), one branch per format the dispatcher resolves. */
function parseAs(identified: Identified, input: ParseDocumentInput, deps: ParseDocumentDeps): Promise<ParsedDocument> {
  switch (identified.format) {
    case "pdf":
      return parseAsPdf(input, deps);
    case "epub":
      return parseAsEpub(input);
    case "docx":
      return parseAsDocx(input);
    case "html":
      return Promise.resolve(parseAsHtml(input));
    case "txt":
      return Promise.resolve(parseAsText(input));
    case "image":
      return parseAsImage(input, deps, identified.mime);
  }
}

/**
 * Parse any document Lectern accepts (F§5.4): sniff what the bytes are, read them with the parser
 * that owns that format, build the `DocumentModel`, and answer with it and — for a paged source —
 * the word anchors. Every failure comes back as a `ParseError` with one of F§5.4's five codes.
 */
export async function parseDocument(input: ParseDocumentInput, deps: ParseDocumentDeps = {}): Promise<ParsedDocument> {
  const hint: FormatHint = {
    ...(input.mime === undefined ? {} : { mime: input.mime }),
    ...(input.filename === undefined ? {} : { filename: input.filename }),
  };
  const identified = resolve(input.bytes, hint);
  if (identified === null) {
    throw new ParseError("UNSUPPORTED_FORMAT", "the bytes are neither a format Loquitur reads nor UTF-8 text");
  }
  try {
    return await parseAs(identified, input, deps);
  } catch (error) {
    throw toParseError(error);
  }
}
