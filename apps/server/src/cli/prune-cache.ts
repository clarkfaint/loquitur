/**
 * F§7.3's cache pruning command: `node dist/prune-cache.mjs --days <n> [--dry-run]`.
 *
 * F§7.3's cache never evicts itself — every entry is a synthesized chunk under
 * `{DATA_DIR}/tts-cache/{chunkId[0..2]}/{chunkId}.{mp3|wav}` with a sibling `{chunkId}.json` — so this command
 * is the one thing that takes disk back, and it deletes as little as it can:
 *
 * - **An entry is a chunk id, not a file.** The audio file and its metadata sidecar are grouped by the id they
 *   share and are removed together, so the cache can never be left with a sidecar describing bytes that are
 *   gone or with bytes no sidecar describes.
 * - **An entry is old when its *newest* file is old.** That is the reading under which the pair is the unit of
 *   age: an entry is removed only when both of its files are older than the cutoff, so the two never disagree.
 * - **The cutoff is a parameter, not a clock read.** `pruneCache` takes `now`, so a caller — and every test —
 *   decides the instant the age is measured at, and `--days 0` prunes everything the caller considers past.
 * - **Shard directories are left where they are.** Removing one would mean proving it holds nothing else first,
 *   and an empty two-character directory costs nothing F§7.3 forbids.
 *
 * `--dry-run` computes and prints the same three numbers and removes nothing, which is what makes it usable
 * before an operator runs the command for real.
 */

/** The command's own usage line, printed whenever it cannot do what it was asked. */
const USAGE = "Usage: node dist/prune-cache.mjs --days <n> [--dry-run]";

/** One day in milliseconds: the unit `--days` counts in. */
const DAY_MS = 86_400_000;

/** F§7.3's cache directory under the data directory, and how many chunk-id characters name a shard. */
const CACHE_DIRECTORY = "tts-cache";

/** F§7.1's default data directory, which is what the command uses when the environment names none. */
const DEFAULT_DATA_DIR = "./data";

/** A refusal a caller can read: what was wrong with the arguments or the data directory. */
export class PruneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PruneError";
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
  readdir(path: string, options: { withFileTypes: true }): Promise<HostDirent[]>;
  rm(path: string, options: { force: true }): Promise<void>;
  stat(path: string): Promise<{ size: number; mtimeMs: number }>;
}

/** One directory entry, as much of it as the walk needs. */
interface HostDirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

/** The process globals this command needs, declared here: no declaration file for a Node global is installed. */
declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode: number | undefined;
};

declare const console: {
  error(message: string): void;
  log(message: string): void;
};

/** The host's file API, reached by specifier when it is first needed. */
async function hostFiles(): Promise<HostFiles> {
  const specifier: string = "node:fs/promises";
  return (await import(specifier)) as HostFiles;
}

/** One path from segments, with any trailing separator removed so no segment doubles it. */
function joinPath(...segments: string[]): string {
  return segments.map((segment) => segment.replace(/\/+$/, "")).join("/");
}

/** The chunk id a cache file belongs to: its name with the one extension F§7.3 appends removed. */
function chunkIdOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  const id = dot === -1 ? name : name.slice(0, dot);
  return id === "" || id === "." || id === ".." ? null : id;
}

/** The directory entries under a path, or an empty list when there is no such directory. */
async function entriesAt(files: HostFiles, path: string): Promise<HostDirent[]> {
  try {
    return await files.readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** One cache file as the walk found it: where it is, how big it is, and when it was last written. */
interface CacheFile {
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * F§7.3's cache, grouped by chunk id: every file under every shard, read through the two levels the layout
 * defines, so a file the walk cannot name a chunk id for is left alone rather than guessed at.
 */
async function cacheEntries(files: HostFiles, dataDir: string): Promise<Map<string, CacheFile[]>> {
  const cacheDir = joinPath(dataDir, CACHE_DIRECTORY);
  const grouped = new Map<string, CacheFile[]>();
  for (const shard of await entriesAt(files, cacheDir)) {
    if (!shard.isDirectory()) continue;
    const shardPath = joinPath(cacheDir, shard.name);
    for (const entry of await entriesAt(files, shardPath)) {
      if (!entry.isFile()) continue;
      const chunkId = chunkIdOf(entry.name);
      if (chunkId === null) continue;
      const path = joinPath(shardPath, entry.name);
      const info = await files.stat(path);
      grouped.set(chunkId, [...(grouped.get(chunkId) ?? []), { path, size: info.size, mtimeMs: info.mtimeMs }]);
    }
  }
  return grouped;
}

/** What a prune did, or would do: the entries it looked at, the ones it took, and the bytes those held. */
export interface PruneReport {
  /** How many cache entries the cache held. */
  entries: number;
  /** How many of them were older than the cutoff, and so were removed (or, in a dry run, would be). */
  removed: number;
  /** The bytes of the files those entries held, audio and metadata together. */
  bytes: number;
  /** Whether anything was actually deleted. */
  dryRun: boolean;
  /** The data directory the cache was read from. */
  dataDir: string;
}

/** What a prune is asked for: which data directory, how old is old, and whether to only report. */
export interface PruneOptions {
  dataDir: string;
  /** An entry is removed when its newest file has not been modified for this many days. */
  days: number;
  dryRun?: boolean;
  /** The instant the age is measured at. Defaults to the host clock; a test passes its own. */
  now?: number;
}

/**
 * `pruneCache({ dataDir, days, dryRun, now })` — F§7.3's cache, cut back to the entries that are still fresh.
 *
 * Every file of an old entry is removed, and none of a fresh one, so the audio and its metadata stay paired
 * whichever side of the cutoff they fall on.
 */
export async function pruneCache(options: PruneOptions): Promise<PruneReport> {
  const { dataDir, days, dryRun = false, now = Date.now() } = options;
  if (!Number.isInteger(days) || days < 0) throw new PruneError(`--days must be a whole number of days, received ${days}`);
  const files = await hostFiles();
  const cutoff = now - days * DAY_MS;
  const grouped = await cacheEntries(files, dataDir);
  let removed = 0;
  let bytes = 0;
  for (const held of grouped.values()) {
    const newest = held.reduce((latest, file) => Math.max(latest, file.mtimeMs), 0);
    if (newest >= cutoff) continue;
    removed += 1;
    for (const file of held) {
      bytes += file.size;
      if (!dryRun) await files.rm(file.path, { force: true });
    }
  }
  return { entries: grouped.size, removed, bytes, dryRun, dataDir };
}

/** One line an operator can read: what was removed, out of how much, and how many bytes that was. */
function reportLine(report: PruneReport): string {
  const noun = report.entries === 1 ? "entry" : "entries";
  const verb = report.dryRun ? "would prune" : "pruned";
  return `${verb} ${report.removed} of ${report.entries} cache ${noun} (${report.bytes} bytes) under ${report.dataDir}`;
}

/** What the command line asked for: the age cutoff, and whether to delete. */
export interface PruneArguments {
  days: number;
  dryRun: boolean;
}

/**
 * `parsePruneArguments(argv)` — the two arguments the command takes, and a refusal for anything else.
 *
 * `--days` is required: a prune with no age is a prune of the whole cache, which is not something a mistyped
 * command line should be able to do. A day count is digits only, so `-1`, `1.5` and an empty value are refused
 * here rather than read as a bound nobody wrote.
 */
export function parsePruneArguments(argv: readonly string[]): PruneArguments {
  let days: number | null = null;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--days") {
      const value = argv[index + 1];
      if (value === undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new PruneError(`--days needs a whole number of days, received ${value === undefined ? "nothing" : JSON.stringify(value)}`);
      }
      days = Number(value);
      index += 1;
      continue;
    }
    throw new PruneError(`unknown argument ${JSON.stringify(argument)}`);
  }
  if (days === null) throw new PruneError("--days is required");
  return { days, dryRun };
}

/**
 * `runPruneCli(argv, env)` — the command line, as a number a caller can branch on. F§7.1's `LECTERN_DATA_DIR`
 * is read the way the hub's own configuration reads it, default included, and no token is needed to prune a
 * cache: an operator who can reach the data directory is already the operator.
 */
export async function runPruneCli(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  io: CommandIo = TERMINAL_IO,
): Promise<number> {
  let asked: PruneArguments;
  try {
    asked = parsePruneArguments(argv);
  } catch (cause) {
    io.err(cause instanceof PruneError ? cause.message : String(cause));
    io.err(USAGE);
    return 1;
  }
  const configured = env.LECTERN_DATA_DIR;
  const dataDir = configured === undefined || configured === "" ? DEFAULT_DATA_DIR : configured;
  try {
    const report = await pruneCache({ dataDir, days: asked.days, dryRun: asked.dryRun });
    io.out(reportLine(report));
    return 0;
  } catch (cause) {
    io.err(cause instanceof PruneError ? cause.message : `the prune failed — ${cause instanceof Error ? cause.message : String(cause)}`);
    return 1;
  }
}

/** Whether Node was asked to run this module, rather than a test importing it. */
async function invokedDirectly(): Promise<boolean> {
  const specifier: string = "node:url";
  const { fileURLToPath } = (await import(specifier)) as { fileURLToPath(url: string): string };
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === entry;
}

if (await invokedDirectly()) process.exitCode = await runPruneCli(process.argv.slice(2), process.env);
