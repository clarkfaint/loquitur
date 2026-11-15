/**
 * `BlobFs` over `expo-file-system` (F§5.9, F§10.4): the bytes a reader plays, as files in the app's own
 * private document directory under `blobs/`.
 *
 * The directory is the app's own — `Paths.document`, never external storage and never a permission — so
 * nothing here asks the reader for anything, and a cache cleared by the reader from Settings is the only way
 * these bytes can disappear.
 *
 * **The platform module is loaded when a cache is built, not when this module is imported**, and that is why
 * `createExpoBlobFs` is asynchronous: the diagnostics registry reaches this module, and the registry is
 * imported by a Node test where `expo-file-system` (and, through it, `react-native`) cannot be parsed.
 *
 * **A key is mapped onto one file name by percent-encoding it**, byte by byte over its UTF-8 form. Keys are
 * the cache's own and contain slashes (`orig/<docId>`, `anchors/<docId>`), which a flat directory cannot
 * hold, and the mapping has to be injective — two keys must never share a file — and readable in a log. The
 * one name the encoding could still produce dangerously is `.` or `..`, so those two are escaped explicitly;
 * nothing else can leave the directory, because `/`, `\` and every other separator become `%XX`.
 */

import type { BlobFs } from "@lectern/store-sql";
import type { Directory, File } from "expo-file-system";

/** The directory the cache keeps its files in, inside the app's document directory. */
export const BLOBS_DIRECTORY_NAME = "blobs";

/** The characters a key may keep as they are. Everything else is written as `%XX`. */
const SAFE_CHARACTER = /[A-Za-z0-9._-]/;

/** A file name of exactly `.` or `..` would name the directory itself, so its dots are escaped. */
const DIRECTORY_NAMES = [".", ".."];

/**
 * `fileNameForKey(key)` — one key's file name. Two different keys cannot produce the same name, because every
 * byte outside `[A-Za-z0-9._-]` is written as the two hex digits of its own value.
 */
export function fileNameForKey(key: string): string {
  let name = "";
  for (const byte of new TextEncoder().encode(key)) {
    const character = String.fromCharCode(byte);
    name += SAFE_CHARACTER.test(character) ? character : `%${byte.toString(16).padStart(2, "0")}`;
  }
  return DIRECTORY_NAMES.includes(name) ? name.replaceAll(".", "%2e") : name;
}

/**
 * `createExpoBlobFs(directoryName?)` — a `BlobFs` over one directory in the app's document directory,
 * `blobs/` unless the caller names another. The diagnostics check names a scratch directory of its own per
 * case, so a run never touches the bytes the reader is listening to.
 */
export async function createExpoBlobFs(directoryName: string = BLOBS_DIRECTORY_NAME): Promise<BlobFs> {
  const fileSystem: typeof import("expo-file-system") = await import("expo-file-system");
  const directory: Directory = new fileSystem.Directory(fileSystem.Paths.document, directoryName);

  /** The file one key lives in. The `File` is a path, not a handle: it need not exist yet. */
  const fileFor = (key: string): File => new fileSystem.File(directory, fileNameForKey(key));

  /** Make sure the directory is there before anything is written into it. */
  const ensure = (): void => {
    if (!directory.exists) directory.create({ intermediates: true, idempotent: true });
  };

  return {
    async write(key, bytes) {
      ensure();
      const file = fileFor(key);
      if (!file.exists) file.create();
      await file.write(bytes);
    },

    async read(key) {
      const file = fileFor(key);
      return file.exists ? await file.bytes() : null;
    },

    async remove(key) {
      const file = fileFor(key);
      if (file.exists) file.delete();
    },

    async exists(key) {
      return fileFor(key).exists;
    },

    async uri(key) {
      const file = fileFor(key);
      return file.exists ? file.uri : null;
    },
  };
}

/** `removeExpoDirectory(name)` — delete a directory and everything inside it, by the name it was built from. */
export async function removeExpoDirectory(directoryName: string): Promise<void> {
  const fileSystem: typeof import("expo-file-system") = await import("expo-file-system");
  const directory = new fileSystem.Directory(fileSystem.Paths.document, directoryName);
  if (directory.exists) directory.delete();
}
