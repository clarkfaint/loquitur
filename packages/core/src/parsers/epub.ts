/**
 * The EPUB parser (F§5.4, EPUB row): `META-INF/container.xml` → the OPF → the spine's documents in
 * spine order, each one mapped by `html-map.ts` exactly as a web page is.
 *
 * Three properties matter. The container is read *in place*: every byte comes out of the caller's ZIP
 * and no reference is ever followed, so an item whose `href` carries a scheme, a `//host`, or enough
 * `..` segments to climb out of the container is left alone rather than fetched — a book cannot make
 * the hub read something the book does not contain. Navigation and cover documents never reach a
 * block, which is not a detail: a mapped navigation document reads the whole table of contents, every
 * chapter title a second time, as prose. And an encrypted content document is a refusal rather than a
 * puzzle to work around: when `META-INF/encryption.xml` names one, this module fails with
 * `DRM_PROTECTED` before it maps anything, and nothing is ever decrypted.
 *
 * The container file and the OPF are XML, so they are parsed as XML — linkedom's `XMLDocument`, whose
 * elements keep a `dc:` prefix in `tagName`, which is why every name is matched on its local part. A
 * spine document is XHTML and is parsed as HTML, the tree `html-map.ts` walks. Readability is
 * deliberately *not* used here: a chapter is already the article, and asking a readability pass to
 * find it again would let a short or unusual chapter be discarded.
 */

import { strFromU8, unzipSync } from "fflate";
import { DOMParser } from "linkedom";
import type { RawBlock } from "../builder";
import { mapElementToRawBlocks } from "./html-map";

/** The MIME type of an EPUB container (OCF). */
export const EPUB_MIME = "application/epub+zip";

/** The container file every EPUB carries: it names the package document (OCF). */
const CONTAINER_PATH = "META-INF/container.xml";

/** The file that lists a book's encrypted resources, when the book has any (OCF). */
const ENCRYPTION_PATH = "META-INF/encryption.xml";

/** Media types whose documents hold prose. A spine entry of any other type contributes no block. */
const CONTENT_MEDIA_TYPES: ReadonlySet<string> = new Set<string>(["application/xhtml+xml", "image/svg+xml", "text/html"]);

/** The MIME type that picks linkedom's HTML parser, the tree `html.ts` gives a web page. */
const HTML_MIME = "text/html";

/** The MIME type that picks linkedom's XML parser: the container file and the OPF are XML. */
const XML_MIME = "text/xml";

/** A reference that names another protocol rather than a file inside the container. */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** The two MIME types this module parses, as linkedom's parser declares them. */
type MarkupMime = typeof HTML_MIME | typeof XML_MIME;

/** The two refusals F§5.4 names. */
export type EpubErrorCode = "DRM_PROTECTED" | "INVALID_EPUB";

/** An EPUB this module refuses, carrying F§5.4's code for the reason. */
export class EpubParseError extends Error {
  readonly code: EpubErrorCode;

  constructor(code: EpubErrorCode, message: string) {
    super(message);
    this.name = "EpubParseError";
    this.code = code;
  }
}

/** What `parseEpub` hands to `buildDocument` (F§5.4): raw blocks plus the book's own metadata. */
export interface ParsedEpub {
  rawBlocks: RawBlock[];
  title: string;
  lang: string | undefined;
}

/** A container's entries, keyed exactly as the archive stores them. */
type Container = Record<string, Uint8Array>;

/** One `item` of the OPF manifest, with its `href` already resolved inside the container. */
interface ManifestItem {
  id: string;
  path: string;
  mediaType: string;
  /** The manifest's `properties` tokens, which is how EPUB 3 marks a navigation document. */
  properties: string[];
}

/** An error's message, whatever was thrown. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The local part of an element's name. The container file and the OPF are parsed as XML, where the
 * element for `dc:title` carries a prefix in its name, while a document that declares the Dublin Core
 * namespace as its default writes the same element as `title`. The local name is read rather than
 * `tagName`, because an HTML document (which is how a spine document is parsed) uppercases its tag
 * names while keeping the local name in the document's own case.
 */
function localNameOf(element: Element): string {
  const name = element.localName;
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

/** Every element of a subtree whose local name is exactly `name`, in document order. */
function elementsNamed(parent: ParentNode, name: string): Element[] {
  return [...parent.querySelectorAll("*")].filter((element) => localNameOf(element) === name);
}

/** Parse markup with linkedom. Its trees are a second implementation of the DOM interfaces read here. */
function parseMarkup(markup: string, mimeType: MarkupMime): Document {
  return new DOMParser().parseFromString(markup, mimeType) as unknown as Document;
}

/** An element's text, trimmed, never `null`. */
function textOf(element: Element): string {
  return (element.textContent ?? "").trim();
}

/** The trimmed text of the first element whose local name is `name`, or `""` when there is none. */
function firstText(document: ParentNode, name: string): string {
  const element = elementsNamed(document, name)[0];
  return element === undefined ? "" : textOf(element);
}

/** One entry's text, or `undefined` when the container holds no entry of that name. */
function entryText(container: Container, path: string): string | undefined {
  const entry = container[path];
  return entry === undefined ? undefined : strFromU8(entry);
}

/** The directory part of a container path: `OEBPS` for `OEBPS/content.opf`, `""` for `content.opf`. */
function directoryOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** A path's file name without its extension: the `chapter-1` of `OEBPS/chapter-1.xhtml`. */
function stemOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}

/**
 * Percent-decode a reference, because OCF writes a name's reserved and non-ASCII characters escaped
 * while a ZIP entry name is the raw bytes. A malformed escape is not a path, so the raw text stands.
 */
function decodeReference(reference: string): string {
  try {
    return decodeURIComponent(reference);
  } catch {
    return reference;
  }
}

/**
 * Resolve a container reference against a directory inside the container, or `null` when it names no
 * entry this module may read: a scheme (`http:`, `data:`), a protocol-relative `//host`, an empty
 * reference, or a `..` that would climb past the root of the container. A fragment or a query is
 * dropped, and a reference that begins with `/` is read from the container's root, which is where an
 * OCF `CipherReference` URI is measured from.
 */
function resolvePath(baseDirectory: string, reference: string): string | null {
  const trimmed = reference.trim();
  if (trimmed === "" || trimmed.startsWith("//") || SCHEME.test(trimmed)) return null;
  const withoutFragment = trimmed.split("#")[0] ?? "";
  const path = decodeReference(withoutFragment.split("?")[0] ?? "");
  const segments = path.startsWith("/") ? [] : baseDirectory.split("/").filter((segment) => segment !== "");
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? null : segments.join("/");
}

/** The container's entries, or `INVALID_EPUB` when the bytes are not a ZIP archive at all. */
function openContainer(bytes: Uint8Array): Container {
  try {
    return unzipSync(bytes);
  } catch (error) {
    throw new EpubParseError("INVALID_EPUB", `not a readable ZIP container: ${messageOf(error)}`);
  }
}

/**
 * The package document: the OPF path named by `META-INF/container.xml`, and its text. The first
 * `rootfile` that resolves to an entry the container actually holds wins, which is what OCF's
 * "rootfiles" list is for.
 */
function loadPackageDocument(container: Container): { path: string; xml: string } {
  const containerXml = entryText(container, CONTAINER_PATH);
  if (containerXml === undefined) {
    throw new EpubParseError("INVALID_EPUB", `the container has no ${CONTAINER_PATH}`);
  }
  const document = parseMarkup(containerXml, XML_MIME);
  for (const rootfile of elementsNamed(document, "rootfile")) {
    const path = resolvePath("", rootfile.getAttribute("full-path") ?? "");
    if (path === null) continue;
    const xml = entryText(container, path);
    if (xml === undefined) continue;
    return { path, xml };
  }
  throw new EpubParseError("INVALID_EPUB", `no rootfile in ${CONTAINER_PATH} names a package document the container holds`);
}

/** The OPF's manifest, with each item's `href` resolved against the package document's directory. */
function readManifest(document: ParentNode, baseDirectory: string): ManifestItem[] {
  const items: ManifestItem[] = [];
  for (const element of elementsNamed(document, "item")) {
    const id = element.getAttribute("id");
    const path = resolvePath(baseDirectory, element.getAttribute("href") ?? "");
    if (id === null || path === null) continue;
    items.push({
      id,
      path,
      mediaType: (element.getAttribute("media-type") ?? "").trim().toLowerCase(),
      properties: (element.getAttribute("properties") ?? "")
        .trim()
        .split(/\s+/)
        .filter((token) => token !== ""),
    });
  }
  return items;
}

/** The `idref`s of the OPF's spine, in reading order. */
function readSpine(document: ParentNode): string[] {
  return elementsNamed(document, "itemref")
    .map((element) => element.getAttribute("idref"))
    .filter((idref): idref is string => idref !== null);
}

/** Whether EPUB 3 marks this item as the book's navigation document (F§5.4 drops it). */
function isNavigationDocument(item: ManifestItem): boolean {
  return item.properties.includes("nav");
}

/**
 * Whether this item is the book's cover (F§5.4 drops it). EPUB 3 marks the cover *image* with a
 * property, but an image is never a content document, so the rule that decides prose is the document
 * convention EPUB 2 established and EPUB 3 kept: a cover document is one its package calls `cover`.
 */
function isCoverDocument(item: ManifestItem): boolean {
  return item.id.toLowerCase() === "cover" || stemOf(item.path).toLowerCase() === "cover";
}

/**
 * The documents the spine actually contributes, in spine order: every `itemref` whose manifest item
 * is a content document, not the navigation, not the cover, and resolvable inside the container. An
 * `itemref` the manifest does not define, or one naming a file outside the container, is passed over
 * rather than failing the whole book.
 */
function spineDocuments(items: ManifestItem[], spine: string[]): string[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const paths: string[] = [];
  for (const idref of spine) {
    const item = byId.get(idref);
    if (item === undefined) continue;
    if (isNavigationDocument(item) || isCoverDocument(item)) continue;
    if (!CONTENT_MEDIA_TYPES.has(item.mediaType)) continue;
    paths.push(item.path);
  }
  return paths;
}

/**
 * F§5.4's refusal: when `META-INF/encryption.xml` lists a content document, the parse stops with
 * `DRM_PROTECTED` and no attempt is made to read or decrypt it. A resource that is not a content
 * document — the cover image of a book whose text is unobfuscated, say — is not a refusal, which is
 * why the check resolves each encrypted URI against the manifest instead of rejecting any encrypted
 * book outright. OCF measures a `CipherReference` URI from the root of the container.
 */
function assertUnencrypted(container: Container, items: ManifestItem[], spinePaths: string[]): void {
  const encryptionXml = entryText(container, ENCRYPTION_PATH);
  if (encryptionXml === undefined) return;
  const document = parseMarkup(encryptionXml, XML_MIME);
  for (const reference of elementsNamed(document, "CipherReference")) {
    const path = resolvePath("", reference.getAttribute("URI") ?? reference.getAttribute("uri") ?? "");
    if (path === null) continue;
    const item = items.find((candidate) => candidate.path === path);
    const isContentDocument = spinePaths.includes(path) || (item !== undefined && CONTENT_MEDIA_TYPES.has(item.mediaType));
    if (isContentDocument) {
      throw new EpubParseError("DRM_PROTECTED", `${path} is an encrypted content document, which this parser never decrypts`);
    }
  }
}

/**
 * The element a spine document's blocks are mapped from: the `body` when it holds the document's
 * text, else the document's root element. An XHTML file that is a bare fragment rather than a whole
 * document is a tree linkedom hangs off the first element it meets, with an empty `body`, and the
 * text of such a document must still be read.
 */
function contentRootOf(document: Document): Element | null {
  const body = document.querySelector("body");
  if (body !== null && (body.textContent ?? "").trim() !== "") return body;
  return document.documentElement;
}

/**
 * Parse an EPUB into raw blocks and metadata (F§5.4). The bytes are only ever read from: no reference
 * is followed, no remote resource is loaded, and the caller's array is left as it was.
 */
export async function parseEpub(bytes: Uint8Array): Promise<ParsedEpub> {
  const container = openContainer(bytes);
  const packageDocument = loadPackageDocument(container);
  const opf = parseMarkup(packageDocument.xml, XML_MIME);
  const directory = directoryOf(packageDocument.path);

  const items = readManifest(opf, directory);
  const spinePaths = spineDocuments(items, readSpine(opf));
  assertUnencrypted(container, items, spinePaths);

  const rawBlocks: RawBlock[] = [];
  const documentTitles: string[] = [];
  for (const path of spinePaths) {
    const markup = entryText(container, path);
    if (markup === undefined) {
      throw new EpubParseError("INVALID_EPUB", `the spine names ${path}, which the container does not hold`);
    }
    const document = parseMarkup(markup, HTML_MIME);
    const root = contentRootOf(document);
    if (root !== null) rawBlocks.push(...mapElementToRawBlocks(root));
    documentTitles.push(firstText(document, "title"));
  }

  const declaredTitle = firstText(opf, "title");
  const title = declaredTitle === "" ? (documentTitles.find((candidate) => candidate !== "") ?? "") : declaredTitle;
  const lang = firstText(opf, "language");
  return { rawBlocks, title, lang: lang === "" ? undefined : lang };
}
