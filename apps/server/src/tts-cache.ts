/**
 * The hub's shared TTS cache (F§7.3): one audio file per synthesized chunk under the data directory, and a
 * sibling `.json` holding the metadata a client needs before the bytes arrive.
 *
 * Two readers asking for the same chunk at the same time share one synthesis — the promise is held under the
 * chunk id until it settles — so ten tabs opening one document call an engine once. The cache is never the
 * truth: every entry can be synthesized again, so a sidecar that is missing, unreadable, or left without its
 * audio beside it is a miss and nothing more.
 */

import { TimingSourceSchema, WordTimingSchema } from "@lectern/api-contract";
import type { AudioMime, SynthesizedChunk } from "@lectern/core-tts";
import { z } from "zod";

/** The metadata sidecar of F§7.3: the record a client is answered with, without the audio itself. */
const CacheMetaSchema = z.strictObject({
  chunkId: z.string().min(1),
  mime: z.enum(["audio/mpeg", "audio/wav"]),
  durationMs: z.int().nonnegative(),
  timings: z.array(WordTimingSchema),
  timingSource: TimingSourceSchema,
});
export type CacheMeta = z.infer<typeof CacheMetaSchema>;

/** A cached chunk (F§7.3): its metadata and the bytes that metadata describes. */
export interface CachedChunk extends CacheMeta {
  bytes: Uint8Array;
}

/** What a route asks of the cache (F§7.3). */
export interface HubTtsCache {
  /** The chunk F§7.3 already holds, or nothing when it holds no complete entry under that id. */
  read(chunkId: string): Promise<CachedChunk | null>;
  /** The chunk under `chunkId`, synthesized by `produce` when the cache does not hold it yet. */
  getOrCreate(chunkId: string, produce: () => Promise<SynthesizedChunk>): Promise<CachedChunk>;
}

/**
 * The subset of the host's file API this cache uses. It is described here rather than imported, because no
 * declaration file for a Node built-in is installed on this host: `@types/node` is absent and the rules forbid
 * adding one, so a `node:` specifier is an unresolved name in the type program.
 */
interface HostFiles {
  mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  rename(from: string, to: string): Promise<void>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
}

/**
 * The host's file API, reached by specifier when it is first needed. The specifier is held in a `string`-typed
 * variable so the compiler does not try to resolve the built-in it names; at run time the same module is the
 * one Node, `tsx` and vitest all load, so the shipped behaviour is the behaviour the tests exercise.
 */
async function hostFiles(): Promise<HostFiles> {
  const specifier: string = "node:fs/promises";
  return (await import(specifier)) as HostFiles;
}

/** The directory F§7.3 keeps chunks in, under the configured data directory. */
const CACHE_DIRECTORY = "tts-cache";

/** How many characters of a chunk id name its shard directory (F§7.3). */
const SHARD_LENGTH = 2;

/** The one extension F§7.3 writes a container under, derived from the mime so the two cannot disagree. */
const EXTENSION: Record<AudioMime, "mp3" | "wav"> = { "audio/mpeg": "mp3", "audio/wav": "wav" };

/** A serial that makes each temporary file name unique, so two writers never rename each other's file. */
let temporarySerial = 0;

/** One path from segments, with any trailing separator removed so no segment doubles it. */
function joinPath(...segments: string[]): string {
  return segments.map((segment) => segment.replace(/\/+$/, "")).join("/");
}

/** The directory one chunk's files live in (F§7.3): the first two characters of its id, under the cache root. */
function shardDirectory(dataDir: string, chunkId: string): string {
  return joinPath(dataDir, CACHE_DIRECTORY, chunkId.slice(0, SHARD_LENGTH));
}

/** The audio file F§7.3 stores for a chunk, and the sidecar beside it. */
function audioPath(dataDir: string, chunkId: string, mime: AudioMime): string {
  return joinPath(shardDirectory(dataDir, chunkId), `${chunkId}.${EXTENSION[mime]}`);
}

function metaPath(dataDir: string, chunkId: string): string {
  return joinPath(shardDirectory(dataDir, chunkId), `${chunkId}.json`);
}

/** The metadata of a chunk, without its bytes: what the sidecar holds. */
function metaOf(chunk: CachedChunk): CacheMeta {
  return {
    chunkId: chunk.chunkId,
    mime: chunk.mime,
    durationMs: chunk.durationMs,
    timings: chunk.timings,
    timingSource: chunk.timingSource,
  };
}

/**
 * `createTtsCache(dataDir)` — F§7.3's cache over the configured data directory.
 *
 * The shard directory is created on the first write, so a hub whose data directory does not exist yet starts
 * anyway and refuses only when it cannot write a chunk. A chunk is written as F§7.3 prescribes: through a
 * temporary file, renamed into place, audio first and sidecar second, so a write that is interrupted leaves a
 * file no reader treats as complete.
 */
export function createTtsCache(dataDir: string): HubTtsCache {
  const inFlight = new Map<string, Promise<CachedChunk>>();

  /** The next unused temporary file name for a write of this chunk. */
  function nextTemporary(chunkId: string): string {
    temporarySerial += 1;
    return `${chunkId}.${temporarySerial}.tmp`;
  }

  /** The sidecar's metadata, read and validated, or nothing when it is absent or unreadable. */
  async function readMeta(files: HostFiles, chunkId: string): Promise<CacheMeta | null> {
    let text: string;
    try {
      text = await files.readFile(metaPath(dataDir, chunkId), "utf8");
    } catch {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      const meta = CacheMetaSchema.safeParse(parsed);
      return meta.success ? meta.data : null;
    } catch {
      return null;
    }
  }

  async function read(chunkId: string): Promise<CachedChunk | null> {
    const files = await hostFiles();
    const meta = await readMeta(files, chunkId);
    if (meta === null) return null;
    try {
      const bytes = await files.readFile(audioPath(dataDir, chunkId, meta.mime));
      return { ...meta, bytes };
    } catch {
      return null;
    }
  }

  async function write(files: HostFiles, chunk: CachedChunk): Promise<void> {
    const directory = shardDirectory(dataDir, chunk.chunkId);
    await files.mkdir(directory, { recursive: true });
    const audioTemporary = joinPath(directory, nextTemporary(chunk.chunkId));
    await files.writeFile(audioTemporary, chunk.bytes);
    await files.rename(audioTemporary, audioPath(dataDir, chunk.chunkId, chunk.mime));
    const metaTemporary = joinPath(directory, nextTemporary(chunk.chunkId));
    await files.writeFile(metaTemporary, JSON.stringify(metaOf(chunk)));
    await files.rename(metaTemporary, metaPath(dataDir, chunk.chunkId));
  }

  /** Synthesize, store and answer one chunk, releasing its place in the in-flight map however it ends. */
  async function synthesize(chunkId: string, produce: () => Promise<SynthesizedChunk>): Promise<CachedChunk> {
    try {
      const files = await hostFiles();
      const produced = await produce();
      const chunk: CachedChunk = {
        chunkId: produced.chunkId,
        mime: produced.mime,
        durationMs: produced.durationMs,
        timings: produced.timings,
        timingSource: produced.timingSource,
        bytes: produced.audio,
      };
      await write(files, chunk);
      return chunk;
    } finally {
      inFlight.delete(chunkId);
    }
  }

  return {
    read,

    getOrCreate: async (chunkId: string, produce: () => Promise<SynthesizedChunk>): Promise<CachedChunk> => {
      const stored = await read(chunkId);
      if (stored !== null) return stored;
      const shared = inFlight.get(chunkId);
      if (shared !== undefined) return await shared;
      const task = synthesize(chunkId, produce);
      inFlight.set(chunkId, task);
      return await task;
    },
  };
}
