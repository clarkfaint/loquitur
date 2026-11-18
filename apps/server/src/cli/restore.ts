/**
 * F§12's restore command: `node dist/restore.mjs <archive> <dataDir>`.
 *
 * A restore is the one operation that writes a whole data directory from a file somebody else may have made, so
 * it refuses far more than it accepts, and it writes nothing until it has read everything:
 *
 * 1. **The target must be empty.** A directory that does not exist is created; one that already holds anything
 *    is refused, because restoring over a hub's live data is the one thing the contract forbids outright and
 *    nothing here is ever automatic.
 * 2. **Every entry must be safe.** `tar.list` enumerates the archive without writing — an absolute path, a
 *    backslash, a `.`/`..` segment, or any entry type other than a file or a directory is a refusal, so a
 *    symbolic link (which could redirect a later write through itself) never survives to an extraction. This is
 *    the pass that makes the extraction's own filter an allow-list rather than a hope.
 * 3. **The manifest must be this format and this schema version.** The manifest is extracted *alone* into an
 *    operating-system temporary directory and read there, so nothing is written into the target to find out
 *    whether the archive is one this build can read.
 * 4. **The payload must be what the manifest describes.** The manifest's `files` and the archive's own file
 *    entries are compared both ways, so an archive with a file its manifest does not name — or one missing a
 *    file the manifest promises — is refused rather than half-restored.
 *
 * Only then is `tar.extract` run, with `strict: true` so that an entry that cannot be written fails the command
 * instead of warning into a log and leaving a partial directory behind, and with a filter that admits exactly
 * the paths the second pass vetted.
 */

import { extract, list, type ReadEntry } from "tar";
import { SCHEMA_VERSION } from "../db/migrations";
import { describeIssues, messageOf } from "../errors";
import { type BackupManifest, BackupManifestSchema, MANIFEST_ENTRY } from "../routes/admin";

/** The command's own usage line, printed whenever it cannot do what it was asked. */
const USAGE = "Usage: node dist/restore.mjs <archive> <dataDir>";

/** A refusal a caller can read: what was wrong with the archive, or with the target directory. */
export class RestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreError";
  }
}

/** Where a command writes its output, so a caller — or a test — can read it rather than the terminal. */
export interface CommandIo {
  out(message: string): void;
  err(message: string): void;
}

/** What a command that has not been handed an `io` writes to. */
const TERMINAL_IO: CommandIo = {
  out: (message) => console.log(message),
  err: (message) => console.error(message),
};

/** The subset of the host's file API this command uses. */
interface HostFiles {
  mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
  readdir(path: string): Promise<string[]>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
}

/** The one member of the host's operating-system module this command uses. */
interface HostOs {
  tmpdir(): string;
}

/** The one member of the host's URL module the direct-invocation guard uses. */
interface HostUrl {
  fileURLToPath(url: string): string;
}

/** The process globals this command needs, declared here: no declaration file for a Node global is installed. */
declare const process: {
  argv: string[];
  exitCode: number | undefined;
};

declare const console: {
  error(message: string): void;
  log(message: string): void;
};

/** F§5.2's document id, the shape every path this command writes must keep. */
const SAFE_SEGMENT = /^[^/\\]+$/;

/** The entry types a Lectern archive holds. Anything else — a link above all — is refused. */
const ALLOWED_ENTRY_TYPES = new Set(["File", "Directory"]);

/** The host's file API, reached by specifier when it is first needed. */
async function hostFiles(): Promise<HostFiles> {
  const specifier: string = "node:fs/promises";
  return (await import(specifier)) as HostFiles;
}

/** The host's operating-system module, reached the same way. */
async function hostOs(): Promise<HostOs> {
  const specifier: string = "node:os";
  return (await import(specifier)) as HostOs;
}

/** One path from segments, with any trailing separator removed so no segment doubles it. */
function joinPath(...segments: string[]): string {
  return segments.map((segment) => segment.replace(/\/+$/, "")).join("/");
}

/**
 * Whether an archive entry may be written under the target directory.
 *
 * An entry directory is written with a trailing separator, so it is trimmed first; what remains must be one or
 * more non-empty segments, none of which is `.` or `..`, and no segment may contain a separator of its own — so
 * an absolute path, a Windows-style path, a doubled separator and any traversal are all refused here rather than
 * left to tar's own protection.
 */
export function isSafeEntryPath(path: string): boolean {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  if (trimmed === "") return false;
  return trimmed.split("/").every((segment) => segment !== "." && segment !== ".." && SAFE_SEGMENT.test(segment));
}

/** One entry as the archive reports it: the path, and the type that decides whether it may be written. */
interface ArchiveEntry {
  path: string;
  type: string;
}

/**
 * The target directory, ready to be written into: created when it is missing, refused when it holds anything.
 * An empty directory is what a restore into a fresh volume looks like, and a refill of a stopped hub's volume
 * starts by moving the old one aside — which is the operator's decision, not this command's.
 */
async function prepareTarget(files: HostFiles, dataDir: string): Promise<void> {
  let existing: string[];
  try {
    existing = await files.readdir(dataDir);
  } catch {
    await files.mkdir(dataDir, { recursive: true });
    return;
  }
  if (existing.length > 0) {
    throw new RestoreError(
      `the target directory is not empty: ${dataDir} holds ${existing.length} entry(ies), and a restore never writes over a hub`,
    );
  }
}

/** Every entry of the archive, read without writing, with any unsafe entry refused as it is met. */
async function readEntries(archive: string): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  const warnings: string[] = [];
  await list({
    file: archive,
    onReadEntry: (entry: ReadEntry) => {
      entries.push({ path: entry.path, type: entry.type });
    },
    onwarn: (code: string, message: string) => {
      warnings.push(`${code}: ${message}`);
    },
  });
  if (warnings.length > 0) throw new RestoreError(`the archive could not be read: ${warnings.join("; ")}`);
  if (entries.length === 0) throw new RestoreError(`the archive holds no entries: ${archive}`);
  for (const entry of entries) {
    if (!ALLOWED_ENTRY_TYPES.has(entry.type)) {
      throw new RestoreError(`the archive holds a ${entry.type} entry (${entry.path}), and a restore writes files and directories only`);
    }
    if (!isSafeEntryPath(entry.path)) {
      throw new RestoreError(`the archive holds an entry that would leave the target directory: ${entry.path}`);
    }
  }
  return entries;
}

/** The archive's manifest, read out of a temporary directory so the target stays untouched until it is trusted. */
async function readManifest(archive: string): Promise<BackupManifest> {
  const files = await hostFiles();
  const os = await hostOs();
  const staging = await files.mkdtemp(joinPath(os.tmpdir(), "lectern-restore-"));
  try {
    await extract({ file: archive, cwd: staging, portable: true, strict: true, filter: (path: string) => path === MANIFEST_ENTRY });
    let text: string;
    try {
      text = await files.readFile(joinPath(staging, MANIFEST_ENTRY), "utf8");
    } catch {
      throw new RestoreError(`the archive holds no ${MANIFEST_ENTRY}: ${archive}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch (cause) {
      throw new RestoreError(`the archive's ${MANIFEST_ENTRY} is not JSON — ${messageOf(cause)}`);
    }
    const parsed = BackupManifestSchema.safeParse(value);
    if (!parsed.success)
      throw new RestoreError(`the archive's ${MANIFEST_ENTRY} is not a backup manifest — ${describeIssues(parsed.error)}`);
    return parsed.data;
  } finally {
    await files.rm(staging, { recursive: true, force: true });
  }
}

/** Two path lists holding the same paths, whatever order they were read in. */
function samePaths(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((path, index) => path === right[index]);
}

/** What a finished restore put where, as the command reports it. */
export interface RestoreReport {
  /** How many payload files the archive held, the manifest itself excluded. */
  files: number;
  /** When the archived hub took the backup, as the manifest stamped it. */
  createdAt: string;
  /** The schema version the archive was written at, which is this build's. */
  schemaVersion: number;
}

/** What a restore is asked for: the archive to read, and the empty directory to write it into. */
export interface RestoreOptions {
  archive: string;
  dataDir: string;
}

/**
 * `restoreArchive({ archive, dataDir })` — the archive written into the directory, or the refusal that says why
 * not. Nothing is written until every check above has passed, so a refusal leaves the target as it was.
 */
export async function restoreArchive(options: RestoreOptions): Promise<RestoreReport> {
  const files = await hostFiles();
  await prepareTarget(files, options.dataDir);
  const entries = await readEntries(options.archive);
  const manifest = await readManifest(options.archive);
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    throw new RestoreError(
      `the archive was written at schema version ${manifest.schemaVersion} and this hub builds version ${SCHEMA_VERSION}`,
    );
  }
  const promised = [...manifest.files].sort();
  const carried = entries
    .filter((entry) => entry.type === "File" && entry.path !== MANIFEST_ENTRY)
    .map((entry) => entry.path)
    .sort();
  if (!samePaths(promised, carried)) {
    throw new RestoreError(
      `the archive does not hold what its manifest describes: promised ${promised.length} file(s), carried ${carried.length} — ${carried.join(", ")}`,
    );
  }
  const allowed = new Set(entries.map((entry) => entry.path));
  await extract({
    file: options.archive,
    cwd: options.dataDir,
    portable: true,
    strict: true,
    filter: (path: string) => allowed.has(path),
  });
  return { files: promised.length, createdAt: manifest.createdAt, schemaVersion: manifest.schemaVersion };
}

/**
 * `runRestoreCli(argv)` — the command line, as a number a caller can branch on. Usage and every refusal go to
 * standard error with exit code 1, and a finished restore says what it read and where it put it.
 */
export async function runRestoreCli(argv: readonly string[], io: CommandIo = TERMINAL_IO): Promise<number> {
  const [archive, dataDir] = argv;
  if (archive === undefined || dataDir === undefined) {
    io.err(USAGE);
    return 1;
  }
  try {
    const report = await restoreArchive({ archive, dataDir });
    io.out(
      `restored ${report.files} file(s) at schema version ${report.schemaVersion} from a backup taken ${report.createdAt} into ${dataDir}`,
    );
    return 0;
  } catch (cause) {
    io.err(cause instanceof RestoreError ? cause.message : `the restore failed — ${messageOf(cause)}`);
    return 1;
  }
}

/** Whether Node was asked to run this module, rather than a test importing it. */
async function invokedDirectly(): Promise<boolean> {
  const specifier: string = "node:url";
  const { fileURLToPath } = (await import(specifier)) as HostUrl;
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === entry;
}

if (await invokedDirectly()) process.exitCode = await runRestoreCli(process.argv.slice(2));
