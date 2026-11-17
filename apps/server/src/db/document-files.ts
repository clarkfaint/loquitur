/**
 * The hub's document files (F§8.4): a document's model and, when the client had one, its original file —
 * both under `{DATA_DIR}/library/{docId}/`.
 *
 * A document's body is never a row: F§8.4 keeps records in SQLite and the bytes beside them, so a model
 * travels gzipped exactly as the client uploaded it (F§7.2) and the hub never parses or re-encodes it. The
 * original is stored with its mime type in a small sidecar, because the route that serves it has to answer
 * with the content type the file really had.
 *
 * Two properties the contract asks for and this module is built around:
 *
 * - **Every write is atomic.** The bytes go to a temporary file in the document's own directory and are
 *   renamed into place, so a reader either finds the previous file or the complete new one — never a half
 *   written model, whatever a crash or a full disk leaves behind. The original's sidecar is written last,
 *   so a sidecar that is present always describes bytes that are already there.
 * - **The document id is checked before a path is built.** F§5.2's id is 32 lower-case hexadecimal
 *   characters, and the id names a directory; validating it first is what keeps a caller from reaching a
 *   path this hub never intended to write, and it is the only input these functions refuse.
 *
 * The host's file API is reached through a `string`-typed specifier and described below, because no
 * declaration file for a Node built-in belongs in this package's type program — `./database` writes down the
 * measurement behind that boundary. A dynamic import of a non-literal specifier type-checks without Node's
 * ambient types and still loads the real module under `vitest`.
 */

import { z } from "zod";
import { HubError } from "../errors";

/** The subset of the host's file API this module uses. */
interface HostFiles {
  mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
  stat(path: string): Promise<{ isFile(): boolean }>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
}

/** F§5.2's document id: 32 lower-case hexadecimal characters, and the name of every file below. */
const DOC_ID = /^[0-9a-f]{32}$/;

/** F§8.4's directory for the documents' bytes, under the data directory F§7.1 configures. */
const LIBRARY_DIRECTORY = "library";

/** The three files one document may have: its gzipped model, its original, and the original's sidecar. */
const MODEL_FILE = "model.json.gz";
const ORIGINAL_FILE = "original";
const ORIGINAL_META_FILE = "original.json";

/** The sidecar of an original: the content type the route that serves it must answer with. */
const OriginalMetaSchema = z.strictObject({ mime: z.string().min(1) });

/** A document's original file, as a caller receives it (F§7.2). */
export interface StoredOriginal {
  bytes: Uint8Array;
  mime: string;
}

/** What the library routes are given (F§7.2, F§8.4): a document's model and its original. */
export interface DocumentFiles {
  /** Store the gzipped model of a document, replacing any model it already had. */
  putModel(docId: string, gzipBytes: Uint8Array): Promise<void>;
  /** The gzipped model of a document, or nothing when the hub does not hold one. */
  getModel(docId: string): Promise<Uint8Array | null>;
  /** Store a document's original file with the content type it arrived with. */
  putOriginal(docId: string, bytes: Uint8Array, mime: string): Promise<void>;
  /** A document's original and its content type, or nothing when the hub holds neither. */
  getOriginal(docId: string): Promise<StoredOriginal | null>;
  /** Whether the hub holds a model for a document, without reading it. */
  hasModel(docId: string): Promise<boolean>;
  /** Forget a document entirely: its model, its original and the directory that held them. */
  removeDocument(docId: string): Promise<void>;
}

/** A serial that makes each temporary file name unique, so two writers never rename each other's file. */
let temporarySerial = 0;

/** The host's file API, reached by specifier when it is first needed. */
async function hostFiles(): Promise<HostFiles> {
  const specifier: string = "node:fs/promises";
  return (await import(specifier)) as HostFiles;
}

/** One path from segments, with any trailing separator removed so no segment doubles it. */
function joinPath(...segments: string[]): string {
  return segments.map((segment) => segment.replace(/\/+$/, "")).join("/");
}

/** The file read as bytes, or nothing when it is absent or unreadable. */
async function readBytesOrNull(path: string): Promise<Uint8Array | null> {
  try {
    const files = await hostFiles();
    return await files.readFile(path);
  } catch {
    return null;
  }
}

/** The file read as UTF-8 text, or nothing when it is absent or unreadable. */
async function readTextOrNull(path: string): Promise<string | null> {
  try {
    const files = await hostFiles();
    return await files.readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * `createDocumentFiles(dataDir)` — F§8.4's document files over the configured data directory.
 *
 * The data directory is taken once, so no caller passes a path of its own and no two callers can disagree
 * about where a document lives. Nothing is created until something is written: a hub that holds no
 * documents has no `library` directory at all.
 */
export function createDocumentFiles(dataDir: string): DocumentFiles {
  /**
   * The directory one document's files live in (F§8.4). The id is checked here, before any path exists,
   * because it is what names the directory — an id that is not F§5.2's shape is refused rather than
   * turned into a path. Every method below calls this before it reaches for the file system.
   */
  function documentDirectory(docId: string): string {
    if (!DOC_ID.test(docId)) throw new HubError("BAD_REQUEST", "a document id must be 32 lower-case hexadecimal characters (F§5.2)");
    return joinPath(dataDir, LIBRARY_DIRECTORY, docId);
  }

  /** One file written whole: to a temporary file in its own directory, then renamed into place. */
  async function writeAtomically(directory: string, path: string, data: Uint8Array | string): Promise<void> {
    temporarySerial += 1;
    const temporary = joinPath(directory, `.write-${temporarySerial}.tmp`);
    const files = await hostFiles();
    await files.writeFile(temporary, data);
    await files.rename(temporary, path);
  }

  return {
    putModel: async (docId: string, gzipBytes: Uint8Array): Promise<void> => {
      const directory = documentDirectory(docId);
      const files = await hostFiles();
      await files.mkdir(directory, { recursive: true });
      await writeAtomically(directory, joinPath(directory, MODEL_FILE), gzipBytes);
    },

    getModel: async (docId: string): Promise<Uint8Array | null> => await readBytesOrNull(joinPath(documentDirectory(docId), MODEL_FILE)),

    putOriginal: async (docId: string, bytes: Uint8Array, mime: string): Promise<void> => {
      const directory = documentDirectory(docId);
      const files = await hostFiles();
      await files.mkdir(directory, { recursive: true });
      await writeAtomically(directory, joinPath(directory, ORIGINAL_FILE), bytes);
      await writeAtomically(directory, joinPath(directory, ORIGINAL_META_FILE), JSON.stringify({ mime }));
    },

    getOriginal: async (docId: string): Promise<StoredOriginal | null> => {
      const directory = documentDirectory(docId);
      const text = await readTextOrNull(joinPath(directory, ORIGINAL_META_FILE));
      if (text === null) return null;
      const bytes = await readBytesOrNull(joinPath(directory, ORIGINAL_FILE));
      if (bytes === null) return null;
      try {
        const meta = OriginalMetaSchema.safeParse(JSON.parse(text) as unknown);
        return meta.success ? { bytes, mime: meta.data.mime } : null;
      } catch {
        return null;
      }
    },

    hasModel: async (docId: string): Promise<boolean> => {
      // The id is checked before the attempt, so a refusal is a refusal and not a "no" (the lookup below
      // reads any failure as an absent model).
      const path = joinPath(documentDirectory(docId), MODEL_FILE);
      try {
        const files = await hostFiles();
        const found = await files.stat(path);
        return found.isFile();
      } catch {
        return false;
      }
    },

    removeDocument: async (docId: string): Promise<void> => {
      const directory = documentDirectory(docId);
      const files = await hostFiles();
      await files.rm(directory, { recursive: true, force: true });
    },
  };
}
