/**
 * F§8.4's document files (U-055): a model and an original stored under `{DATA_DIR}/library/{docId}/`,
 * replaced whole, removed together, and refused when the id that would name their directory is not F§5.2's.
 *
 * Every case writes into a temporary data directory of its own and removes it afterwards, so no file
 * outlives the case that made it. The bytes are arbitrary: this module never parses a model, and the
 * original's mime type is carried beside it rather than guessed from its content.
 *
 * Reading the layout back needs `node:fs`, so this file stays outside the package's type-check program (its
 * test directories are excluded): vitest erases types instead of checking them and runs it as written.
 */

import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createDocumentFiles, type DocumentFiles } from "../document-files";

/** F§5.2's document id: 32 lower-case hexadecimal characters, and the name of the document's directory. */
const DOC_ID = "0123456789abcdef0123456789abcdef";

/** A second id, for the cases that must prove one document's files are its own. */
const OTHER_DOC_ID = "fedcba9876543210fedcba9876543210";

/** A gzipped model, as the client uploads it (F§7.2): the two bytes of gzip's own magic number and a body. */
const MODEL_BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02, 0x03, 0x04]);

/** A replacement model, distinguishable from the first by its last byte. */
const OTHER_MODEL_BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x09, 0x09, 0x09, 0x0a]);

/** An original file: the first bytes of a PDF, with the mime type a client would have sent beside it. */
const ORIGINAL_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const ORIGINAL_MIME = "application/pdf";

/** One library: F§8.4's document files over a temporary data directory. */
interface Scratch {
  files: DocumentFiles;
  dir: string;
}

/** The data directories this file has made, so every case's is removed however the case ends. */
const directories: string[] = [];

async function scratch(): Promise<Scratch> {
  const dir = await mkdtemp(join(tmpdir(), "lectern-hub-files-"));
  directories.push(dir);
  return { files: createDocumentFiles(dir), dir };
}

afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A file's bytes as a plain array, so the `Buffer` a read answers with compares with what a case wrote. */
function bytesOf(value: Uint8Array | null | undefined): number[] {
  return value === null || value === undefined ? [] : Array.from(value);
}

test("a model and an original round-trip through the document's own directory", async () => {
  const { files, dir } = await scratch();

  expect(await files.hasModel(DOC_ID)).toBe(false);
  expect(await files.getModel(DOC_ID)).toBeNull();
  expect(await files.getOriginal(DOC_ID)).toBeNull();

  await files.putModel(DOC_ID, MODEL_BYTES);
  await files.putOriginal(DOC_ID, ORIGINAL_BYTES, ORIGINAL_MIME);

  expect(await files.hasModel(DOC_ID)).toBe(true);
  expect(bytesOf(await files.getModel(DOC_ID))).toEqual(bytesOf(MODEL_BYTES));

  const original = await files.getOriginal(DOC_ID);
  expect(original?.mime).toBe(ORIGINAL_MIME);
  expect(bytesOf(original?.bytes)).toEqual(bytesOf(ORIGINAL_BYTES));

  // F§8.4's layout: the bytes are files under `{DATA_DIR}/library/{docId}/`, not rows in the database.
  const directory = join(dir, "library", DOC_ID);
  expect((await stat(join(directory, "model.json.gz"))).isFile()).toBe(true);
  expect((await stat(join(directory, "original"))).isFile()).toBe(true);
  expect((await stat(join(directory, "original.json"))).isFile()).toBe(true);
  expect((await readdir(directory)).sort()).toEqual(["model.json.gz", "original", "original.json"]);
});

test("a second write replaces the first, for the model and for the original alike", async () => {
  const { files } = await scratch();
  await files.putModel(DOC_ID, MODEL_BYTES);
  await files.putOriginal(DOC_ID, ORIGINAL_BYTES, ORIGINAL_MIME);

  await files.putModel(DOC_ID, OTHER_MODEL_BYTES);
  await files.putOriginal(DOC_ID, OTHER_MODEL_BYTES, "text/plain");

  expect(bytesOf(await files.getModel(DOC_ID))).toEqual(bytesOf(OTHER_MODEL_BYTES));
  const original = await files.getOriginal(DOC_ID);
  expect(original?.mime).toBe("text/plain");
  expect(bytesOf(original?.bytes)).toEqual(bytesOf(OTHER_MODEL_BYTES));

  // The replacement went through a temporary file and left nothing of it behind.
  const { files: other, dir } = await scratch();
  await other.putModel(DOC_ID, MODEL_BYTES);
  expect(await readdir(join(dir, "library", DOC_ID))).toEqual(["model.json.gz"]);
});

test("removeDocument forgets the model and the original and leaves other documents alone", async () => {
  const { files, dir } = await scratch();
  await files.putModel(DOC_ID, MODEL_BYTES);
  await files.putOriginal(DOC_ID, ORIGINAL_BYTES, ORIGINAL_MIME);
  await files.putModel(OTHER_DOC_ID, MODEL_BYTES);

  await files.removeDocument(DOC_ID);
  expect(await files.hasModel(DOC_ID)).toBe(false);
  expect(await files.getModel(DOC_ID)).toBeNull();
  expect(await files.getOriginal(DOC_ID)).toBeNull();
  expect(existsSync(join(dir, "library", DOC_ID))).toBe(false);

  // Removing it again is not an error: a client may delete a document it has already deleted.
  await files.removeDocument(DOC_ID);

  expect(await files.hasModel(OTHER_DOC_ID)).toBe(true);
});

test("a docId that is not 32 lower-case hex characters is refused before any path is built", async () => {
  const { files, dir } = await scratch();
  const refused = ["", "abc", DOC_ID.toUpperCase(), `${DOC_ID}0`, DOC_ID.slice(1), "0123456789abcdef0123456789abcdeg", "../../etc/passwd"];

  for (const docId of refused) {
    const calls: [string, () => Promise<unknown>][] = [
      ["putModel", () => files.putModel(docId, MODEL_BYTES)],
      ["getModel", () => files.getModel(docId)],
      ["putOriginal", () => files.putOriginal(docId, ORIGINAL_BYTES, ORIGINAL_MIME)],
      ["getOriginal", () => files.getOriginal(docId)],
      ["hasModel", () => files.hasModel(docId)],
      ["removeDocument", () => files.removeDocument(docId)],
    ];
    for (const [name, call] of calls) {
      await expect(call(), `${name}(${JSON.stringify(docId)})`).rejects.toThrow("32 lower-case hexadecimal characters");
    }
  }

  // Nothing was created on the way: no document directory and no `library` directory at all.
  expect(existsSync(join(dir, "library"))).toBe(false);
});
