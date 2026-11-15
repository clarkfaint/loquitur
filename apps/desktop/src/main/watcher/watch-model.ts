/**
 * What a folder's contents mean (F§10.3): which of the files in a watched folder the shell imports on its own,
 * how one of them is identified, whether it has been seen before, and the type it is handed to the app as.
 *
 * Everything here is a decision about a path and a few numbers, so the whole module is pure: no Electron, no
 * clock, no filesystem. `./file-watcher` is what reads the disk and hangs a watcher on a folder; this is the
 * part that can be held still and asked, which is why the contract asks for it separately and asks it to be
 * unit-tested.
 *
 * Four rules, and each is a sentence of F§10.3 or of this unit's *Forbidden Actions*:
 *
 * - **Six extensions are imported, and nothing else.** F§10.3's list is `pdf, epub, docx, txt, md, html`; a
 *   `.zip`, a `.png` or a file with no extension at all is left where it is. The comparison folds case, because
 *   a name written on another platform can arrive as `Report.PDF`.
 * - **A file that is not finished is not a document.** F§10.3's watcher "waits for writes to finish", which is
 *   a property of the watcher (`./file-watcher`), but a name that *says* it is unfinished is left alone
 *   whatever the watcher thinks: a browser's `.crdownload`, a downloader's `.part`, a scratch `.tmp`, and the
 *   `~$` marker a word processor writes beside a document it has open. That marker is real on this class of
 *   feature: the file appears before the document is written and disappears afterwards.
 * - **Hidden files are the operator's own business.** A name that begins with a dot is not a document the
 *   operator dropped in for reading; it is a folder's own bookkeeping, and F§10.3 files what arrives in a
 *   watched folder into the library.
 * - **Anything past 100 MB is refused before it is read.** A watched folder is a folder, not a queue: the whole
 *   file is held in memory to hand it to the app, and the contract's ceiling is what keeps that bounded.
 *
 * The key of a file is its path, its size and its modification time together, which is what makes a *change* to
 * a file a new key and a file that is merely seen again the same key: re-reading a document the operator has not
 * touched is exactly what the ledger exists to prevent, and reading one they have changed is the whole point of
 * watching. The ledger itself is a flat list of keys, newest first, and it is capped by `./file-watcher`.
 */

import { basename, extname } from "node:path";

/** The extensions F§10.3's watcher imports, in the order F§10.3 names them. */
export const IMPORTABLE_EXTENSIONS = ["pdf", "epub", "docx", "txt", "md", "html"] as const;

/** One of the six. */
export type ImportableExtension = (typeof IMPORTABLE_EXTENSIONS)[number];

/** The largest file the shell reads on its own: the contract's 100 MB, and a file of exactly that is taken. */
export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;

/** The suffixes a file wears while it is still being written, from the contract's own list. */
export const PARTIAL_SUFFIXES = [".crdownload", ".part", ".tmp"] as const;

/** The prefix a word processor gives its own lock file, which sits beside the document that is open. */
export const PARTIAL_PREFIX = "~$";

/** What each of the six is handed over as. F§5.4 decides the document from its bytes; this is the name's hint. */
const MIME_TYPES: Readonly<Record<ImportableExtension, string>> = {
  pdf: "application/pdf",
  epub: "application/epub+zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
};

/** What a file with none of the six extensions is handed over as (`@lectern/web`'s own fallback). */
export const FALLBACK_MIME = "application/octet-stream";

/** Whether a string is one of the six, as a test the compiler can narrow with. */
function isImportableExtension(value: string): value is ImportableExtension {
  return IMPORTABLE_EXTENSIONS.some((extension) => extension === value);
}

/** The extension a name ends in, without its dot and folded to lower case, whether or not it is importable. */
function bareExtension(path: string): string {
  return extname(basename(path)).slice(1).toLowerCase();
}

/**
 * `isImportable(path, sizeBytes)` — whether the shell reads this file on its own.
 *
 * The size is passed in rather than read here, because it is the one fact about a file this module cannot know
 * by looking at its name: the caller has just asked the disk for it. A size that is not a real byte count is
 * refused rather than trusted, so a caller that hands over `NaN` from a failed read imports nothing.
 */
export function isImportable(path: string, sizeBytes: number): boolean {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_IMPORT_BYTES) return false;
  const name = basename(path);
  if (name === "" || name.startsWith(".") || name.startsWith(PARTIAL_PREFIX)) return false;
  if (PARTIAL_SUFFIXES.some((suffix) => name.toLowerCase().endsWith(suffix))) return false;
  return isImportableExtension(bareExtension(path));
}

/**
 * `fileKey(path, size, mtimeMs)` — what one reading of one file is remembered by.
 *
 * The three parts are joined with a colon, path last, so the key is readable in the shell's own settings file
 * and two readings of the same path are the same key only when the file is the same size *and* holds the same
 * modification time. The time is truncated to whole milliseconds because that is the resolution the ledger can
 * keep: a fraction of a millisecond is not something an operator can act on, and it is a string in the end.
 */
export function fileKey(path: string, size: number, mtimeMs: number): string {
  return `${size}:${Math.trunc(mtimeMs)}:${path}`;
}

/**
 * `shouldProcess(key, processed)` — whether a file with this key still has to be imported.
 *
 * The ledger is the list the shell keeps in `DesktopSettings.processedFiles`; a key it holds has been imported
 * already, and one it does not is a file the shell has not read. Nothing here trims the ledger — the newest
 * 5 000 keys are `./file-watcher`'s business, because it is the thing that writes them.
 */
export function shouldProcess(key: string, processed: readonly string[]): boolean {
  return !processed.includes(key);
}

/**
 * `mimeForExtension(ext)` — the type a file of this extension is handed over as.
 *
 * The argument may carry its dot (`html` and `.html` are the same extension) and may be written in either case,
 * because a caller that has a file's name usually has its extension with the dot: the mapping is stated once
 * here rather than at each call site. An extension that is none of the six answers the generic type rather than
 * refusing, so a caller with a file in hand always has a type to send — F§5.4 reads the bytes anyway.
 */
export function mimeForExtension(ext: string): string {
  const bare = (ext.startsWith(".") ? ext.slice(1) : ext).toLowerCase();
  return isImportableExtension(bare) ? MIME_TYPES[bare] : FALLBACK_MIME;
}
