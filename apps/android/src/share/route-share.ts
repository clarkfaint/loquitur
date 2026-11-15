/**
 * What a share becomes (F§10.4).
 *
 * Android hands Lectern whatever another app sent it: a paragraph of text, an address, a file, or a handful of
 * photos at once. The handler screen does not decide any of that itself — this module answers, once and purely,
 * what each shared item becomes, so the screen can show the reader what is about to be imported before anything
 * is, and so the decision can be proved without a device.
 *
 * The payload shape is the installed `expo-sharing@58.0.23` typings' own `ResolvedSharePayload`, and the
 * three-way split below follows the module's resolved-payload parser, which is what makes the split possible at
 * all:
 *
 * - text arrives as a payload with no `contentUri`, and its `value` is the text;
 * - an address arrives as one whose `contentUri` is the `http(s)` address the platform resolved it to;
 * - a file or an image arrives as one whose `contentUri` is a copy of the bytes in this app's own cache, and
 *   whose `originalName` is the name it was shared under.
 *
 * The contract's rules then read:
 *
 * - text becomes `{ kind: "text" }` or `{ kind: "url" }` through `classifyPastedInput`, F§10.4's own classifier,
 *   because a shared paragraph and a pasted paragraph are the same question;
 * - an address becomes `{ kind: "url" }`: the hub fetches it (F§7.2) and this device never holds that page;
 * - a file the hub reads as a document (F§5.4's six formats, by declared type or by extension) becomes
 *   `{ kind: "file" }`;
 * - images become one `{ kind: "images" }` holding their copies in the order they were shared, because a
 *   multi-photo share is one intention and F§5.4 reads each image with the hub's OCR engine;
 * - everything else — audio and video above all, which F§10.4 does not accept — becomes
 *   `{ kind: "unsupported" }` with the sentence that says why.
 */

import type { ResolvedSharePayload } from "expo-sharing";
import { classifyPastedInput, type PastedInput } from "../import/classify-input";
import type { PickedFile } from "../import/import-service";

/** A file to import: the copy's URI, the name it was shared under, and the type it claims (F§5.4's hints). */
export type FileAction = PickedFile & { kind: "file" };

/** The images of one share, to import together, in the order they were shared. */
export interface ImagesAction {
  kind: "images";
  uris: string[];
}

/** An item this device will not import, and the sentence that says why. */
export interface UnsupportedAction {
  kind: "unsupported";
  reason: string;
}

/** What one shared item becomes. A text or an address action is `classifyPastedInput`'s own answer. */
export type ShareAction = PastedInput | FileAction | ImagesAction | UnsupportedAction;

/**
 * The six formats F§5.4 reads as documents, which are the ones `import-service.ts`'s `SUPPORTED_IMPORT_MIME_TYPES`
 * declares. They are written out here rather than imported because that module builds the hub client and opens
 * the stores when it is imported, and this module is loaded by the package's Node test program — importing it
 * under `vitest` dies parsing `react-native`. The two lists are the same six strings; a change to one is a change
 * to the other.
 */
const DOCUMENT_MIME_TYPES: readonly string[] = [
  "application/pdf",
  "application/epub+zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/html",
  "text/plain",
  "text/markdown",
];

/** The extensions those six types wear, for a share that declares no type of its own. */
const DOCUMENT_EXTENSIONS: readonly string[] = ["pdf", "epub", "docx", "html", "htm", "txt", "md", "markdown"];

/** What this app says about a share it will not read (F§10.4 accepts no audio and no video). */
const AUDIO_REASON = "Audio and video shares are not imported.";

/** What it says about a share that carried no text at all. */
const EMPTY_TEXT_REASON = "This share carried no text to import.";

/**
 * The last path part of a URI, which is where a shared file's own name is. Written with string arithmetic rather
 * than index access on purpose: the app's compiler settings leave an index read as `T`, and a helper that reads
 * the same under either setting is one fewer thing to get wrong.
 */
function lastSegmentOf(uri: string): string {
  const withoutQuery = uri.split("?", 1).join("");
  const slash = withoutQuery.lastIndexOf("/");
  return slash < 0 ? "" : withoutQuery.slice(slash + 1);
}

/** The part of a name after its last dot, lower-cased, or an empty string for a name with no extension. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** The MIME type a payload claims, without its parameters, lower-cased. */
function mimeOf(payload: ResolvedSharePayload): string {
  const declared = payload.contentMimeType ?? payload.mimeType ?? "";
  return declared.split(";", 1).join("").trim().toLowerCase();
}

/** The name a payload's file was shared under: the one it declared, or the last part of the copy's URI. */
function nameOf(payload: ResolvedSharePayload): string {
  const declared = payload.originalName ?? "";
  return declared === "" ? lastSegmentOf(payload.contentUri ?? "") : declared;
}

/** True when the hub reads these bytes as a document, by the type they claim or the extension they carry. */
function isDocument(mime: string, name: string): boolean {
  return DOCUMENT_MIME_TYPES.includes(mime) || DOCUMENT_EXTENSIONS.includes(extensionOf(name));
}

/** True for a payload this app refuses before looking at anything else (F§10.4, the contract's own rule). */
function isAudioOrVideo(payload: ResolvedSharePayload): boolean {
  if (payload.contentType === "audio" || payload.contentType === "video") return true;
  return payload.shareType === "audio" || payload.shareType === "video";
}

/**
 * The address the hub can fetch that a payload carries, or `null` when it carries none. The address the reader
 * actually shared is preferred, because that is the one F§7.2 fetches and follows; the resolved address is the
 * fallback, which is what a payload resolved from a redirect carries.
 */
function addressOf(payload: ResolvedSharePayload): string | null {
  const shared = classifyPastedInput(payload.value);
  if (shared.kind === "url") return shared.url;
  const resolved = classifyPastedInput(payload.contentUri ?? "");
  return resolved.kind === "url" ? resolved.url : null;
}

/**
 * The copy of the bytes the platform made in this app's cache, or `null` for a payload that holds no file — text,
 * or an address whose page stays on the hub. `file:/…` and `content://…` are both copies this app may read, and
 * neither is an address the hub fetches.
 */
function copyOf(payload: ResolvedSharePayload): string | null {
  const uri = payload.contentUri ?? "";
  if (uri === "") return null;
  return classifyPastedInput(uri).kind === "url" ? null : uri;
}

/** True when a payload is an image whose bytes this app holds a copy of. */
function isCopiedImage(payload: ResolvedSharePayload, copy: string | null): boolean {
  if (copy === null) return false;
  return payload.contentType === "image" || mimeOf(payload).startsWith("image/");
}

/** What an unreadable file is called in the sentence a reader sees. */
function unreadableReason(mime: string, name: string): string {
  if (mime !== "") return `The hub cannot read this file type (${mime}).`;
  if (name !== "") return `The hub cannot read this file (${name}).`;
  return "The hub cannot read this file.";
}

/** What one payload becomes, with images already set aside by `planShare`. */
function actionFor(payload: ResolvedSharePayload): ShareAction {
  if (isAudioOrVideo(payload)) return { kind: "unsupported", reason: AUDIO_REASON };
  const address = addressOf(payload);
  if (address !== null) return { kind: "url", url: address };
  const copy = copyOf(payload);
  if (copy === null) {
    const pasted = classifyPastedInput(payload.value);
    if (pasted.kind === "text" && pasted.text === "") return { kind: "unsupported", reason: EMPTY_TEXT_REASON };
    return pasted;
  }
  const mime = mimeOf(payload);
  const name = nameOf(payload);
  if (isDocument(mime, name)) return { kind: "file", uri: copy, name, mime };
  return { kind: "unsupported", reason: unreadableReason(mime, name) };
}

/**
 * `planShare(payloads)` — what a share is going to become, one action per shared item, in the order the platform
 * reported them, with every image of the share gathered into the one `images` action at the place the first image
 * held.
 */
export function planShare(payloads: readonly ResolvedSharePayload[]): ShareAction[] {
  const images: string[] = [];
  for (const payload of payloads) {
    const copy = copyOf(payload);
    if (!isAudioOrVideo(payload) && isCopiedImage(payload, copy) && copy !== null) images.push(copy);
  }

  const actions: ShareAction[] = [];
  let imagesPlaced = false;
  for (const payload of payloads) {
    const copy = copyOf(payload);
    if (!isAudioOrVideo(payload) && isCopiedImage(payload, copy)) {
      if (!imagesPlaced) {
        actions.push({ kind: "images", uris: images });
        imagesPlaced = true;
      }
      continue;
    }
    actions.push(actionFor(payload));
  }
  return actions;
}
