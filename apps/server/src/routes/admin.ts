/**
 * F§7.2's backup route and the archive format it writes (F§12).
 *
 * `GET /v1/admin/backup` answers one `tar.gz` of the hub's data directory: F§8.4's database as a consistent
 * snapshot taken through SQLite's online backup API, F§8.4's `library/` beside it, F§7.3's `tts-cache/` when the
 * caller asks for it, and a `manifest.json` describing what the archive holds. Nothing else is ever a member,
 * because nothing else is ever named: the token, `infra/.env` and F§5.5's OCR language data are not paths this
 * module knows, so no backup can carry them (F§11, the contract's *Forbidden Actions*). The live database file
 * is never a member either — only the snapshot is — which is why a backup taken while the hub is serving is a
 * consistent one.
 *
 * The archive is built from the data directory itself rather than from a staging copy. `tar.create` reads one
 * `cwd`, so the snapshot is written *inside* the data directory under a serial name and `manifest.json` beside
 * it, and the archive's own `onWriteEntry` hook renames exactly those two entries into `lectern.db` and
 * `manifest.json` — the hook's documented purpose ("if any fields on this entry are changed, then these changes
 * will be reflected in the entry that is written"). The library is therefore streamed from where it already is,
 * and the two staged files are removed when the stream ends, fails, or is destroyed.
 *
 * The manifest's schema lives here because the writer owns the format: `./cli/restore` validates an archive
 * against this same object, so the producer and the consumer of the format cannot drift.
 */

import type { FastifyInstance } from "fastify";
import { create, type Pack, type WriteEntry } from "tar";
import { z } from "zod";
import type { HubContext } from "../context";
import { SCHEMA_VERSION } from "../db/migrations";
import { messageOf } from "../errors";

/** What F§7.2's backup route answers with: one gzip container. */
const ARCHIVE_MIME = "application/gzip";

/** The database's name inside the archive, which is the name F§8.4 gives the file in the data directory. */
export const DATABASE_ENTRY = "lectern.db";

/** The manifest's name inside the archive: the file a restore reads before it writes anything. */
export const MANIFEST_ENTRY = "manifest.json";

/** F§8.4's directory of document files, and F§7.3's cache directory: the two directories an archive may hold. */
const LIBRARY_ENTRY = "library";
const CACHE_ENTRY = "tts-cache";

/**
 * F§7.2's manifest: when the archive was taken, which schema wrote it, and every payload path it holds.
 *
 * `files` is the archive's own table of contents — the database's entry first, then each directory's files in
 * order — so a restore can prove that the payload and the manifest describe one another.
 */
export const BackupManifestSchema = z.strictObject({
  createdAt: z.string().min(1),
  schemaVersion: z.int().nonnegative(),
  files: z.array(z.string().min(1)),
});
export type BackupManifest = z.infer<typeof BackupManifestSchema>;

/**
 * The subset of the host's file API this module uses. It is described here rather than imported, because no
 * declaration file for a Node built-in is installed on this host: `@types/node` is absent and the rules forbid
 * adding one, so a literal `node:` specifier is an unresolved name in this package's type program.
 */
interface HostFiles {
  mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
  readdir(path: string, options: { withFileTypes: true }): Promise<HostDirent[]>;
  rm(path: string, options: { force: true }): Promise<void>;
  writeFile(path: string, data: string): Promise<void>;
}

/** One directory entry, as much of it as a walk needs. */
interface HostDirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

/**
 * The one member of the stream `tar.create` answers with that this module needs beyond its own declarations: the
 * notice that the stream is done, whichever way it ended, which is where the staged files stop being needed.
 *
 * It is declared here because tar's stream base is `minipass`, whose own declaration extends `EventEmitter` from
 * `node:events` — a specifier no program on this host can resolve, since `@types/node` is absent and the rules
 * forbid adding one. `skipLibCheck` keeps that unresolvable base from failing the program, and the price is that
 * `Pack`'s type shows no listener members at all, so the listener is reached through the one cast below. This is
 * the same boundary `./db/database.ts` writes down for `better-sqlite3` and `./app.ts` for `@fastify/websocket`.
 */
interface ClosingStream {
  once(event: "close" | "error", listener: () => void): unknown;
}

/**
 * The one member of F§8.4's database handle a consistent snapshot needs, beyond what U-055's `HubDatabase`
 * interface declares — quoted from the installed `@types/better-sqlite3@9.6.0/index.d.ts:87`,
 * `backup(destinationFile: string, options?: Database.BackupOptions): Promise<Database.BackupMetadata>`.
 * `./db/database.ts` is frozen and not in this unit's *Patch scope*, so the handle is reached through the one
 * cast at the bottom of this file rather than by widening that interface; the evidence files the repair.
 */
interface SnapshotCapableDatabase {
  backup(destination: string): Promise<{ totalPages: number; remainingPages: number }>;
}

/**
 * The host's file API, reached by specifier when it is first needed. The specifier is held in a `string`-typed
 * variable so the compiler does not try to resolve the built-in it names; at run time the same module is the one
 * Node, `tsx` and vitest all load, so the shipped behaviour is the behaviour the tests exercise.
 */
async function hostFiles(): Promise<HostFiles> {
  const specifier: string = "node:fs/promises";
  return (await import(specifier)) as HostFiles;
}

/** One path from segments, with any trailing separator removed so no segment doubles it. */
function joinPath(...segments: string[]): string {
  return segments.map((segment) => segment.replace(/\/+$/, "")).join("/");
}

/** A serial that makes each backup's staged file names unique, so two backups never rename each other's file. */
let backupSerial = 0;

/**
 * Every file under one directory of the data directory, as paths relative to the data directory, in name order —
 * `null` when the directory is not there at all, and an empty list when it is there and empty.
 *
 * Only regular files are collected: a symbolic link under the data directory is not a file this hub wrote, and
 * following one could carry a path from outside it into an archive.
 */
async function filesUnder(files: HostFiles, dataDir: string, name: string): Promise<string[] | null> {
  let entries: HostDirent[];
  try {
    entries = await files.readdir(joinPath(dataDir, name), { withFileTypes: true });
  } catch {
    return null;
  }
  const found: string[] = [];
  for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
    const path = `${name}/${entry.name}`;
    if (entry.isDirectory()) {
      const nested = await filesUnder(files, dataDir, path);
      if (nested !== null) found.push(...nested);
    } else if (entry.isFile()) {
      found.push(path);
    }
  }
  return found;
}

/**
 * An archive ready to stream, and the cleanup that goes with it.
 *
 * `discard` is separate from the stream on purpose: `tar` answers a stream whose `close`/`error` notices are
 * enough for the case where a response is destroyed mid-read, but they are not the notice a finished response
 * gives (measured: a real `curl` download and a `Fastify.inject` answer both left the staged files behind with
 * only those listeners attached). The route therefore discards after the reply it awaited has resolved, and
 * keeps the listeners as the belt for an aborted one.
 */
interface BackupArchive {
  stream: Pack;
  discard(): Promise<void>;
}

/**
 * `createBackupArchive(ctx, includeAudio)` — the archive F§7.2's route streams, ready to be piped.
 *
 * The snapshot is taken first, so a failure to read the database is a refusal before any byte of a response; the
 * manifest is written from the file lists the walk just read, so it describes exactly what the archive will
 * hold; and the archive itself is a stream, so nothing but the snapshot and a short manifest is ever on disk.
 */
async function createBackupArchive(ctx: HubContext, includeAudio: boolean): Promise<BackupArchive> {
  const files = await hostFiles();
  const dataDir = ctx.config.dataDir;
  backupSerial += 1;
  const snapshotName = `.backup-${backupSerial}.db`;
  const manifestName = `.backup-${backupSerial}.json`;
  const snapshotPath = joinPath(dataDir, snapshotName);
  const manifestPath = joinPath(dataDir, manifestName);
  const discard = async (): Promise<void> => {
    await files.rm(snapshotPath, { force: true });
    await files.rm(manifestPath, { force: true });
  };

  try {
    const database = ctx.db as unknown as SnapshotCapableDatabase;
    await database.backup(snapshotPath);

    const payload = [DATABASE_ENTRY];
    const library = await filesUnder(files, dataDir, LIBRARY_ENTRY);
    if (library !== null) payload.push(...library);
    const cache = includeAudio ? await filesUnder(files, dataDir, CACHE_ENTRY) : null;
    if (cache !== null) payload.push(...cache);

    const manifest: BackupManifest = { createdAt: new Date().toISOString(), schemaVersion: SCHEMA_VERSION, files: payload };
    await files.writeFile(manifestPath, JSON.stringify(manifest));

    const names = [snapshotName, manifestName];
    if (library !== null) names.push(LIBRARY_ENTRY);
    if (cache !== null) names.push(CACHE_ENTRY);
    const renamed = new Map([
      [snapshotName, DATABASE_ENTRY],
      [manifestName, MANIFEST_ENTRY],
    ]);
    const archive = create(
      {
        gzip: true,
        cwd: dataDir,
        portable: true,
        onWriteEntry: (entry: WriteEntry) => {
          const name = renamed.get(entry.path);
          if (name !== undefined) entry.path = name;
        },
      },
      names,
    );
    // The staged files belong to the stream's lifetime, however that lifetime ends — a completed response, a
    // client that hung up, or a read that failed.
    const ending = archive as unknown as ClosingStream;
    ending.once("close", () => {
      void discard();
    });
    ending.once("error", () => {
      void discard();
    });
    return { stream: archive, discard };
  } catch (cause) {
    await discard();
    throw new Error(`the hub could not take a backup — ${messageOf(cause)}`);
  }
}

/**
 * `adminRoutes(app, ctx)` — F§7.2's backup route.
 *
 * Only `includeAudio=1` adds F§7.3's cache to the archive: F§7.1's flags are `0` and `1`, so every other value
 * — a missing one included — leaves the cache out, and a mistyped query can never widen what a backup carries.
 */
export function adminRoutes(app: FastifyInstance, ctx: HubContext): void {
  app.get<{ Querystring: { includeAudio?: string } }>("/v1/admin/backup", async (request, reply): Promise<void> => {
    const archive = await createBackupArchive(ctx, request.query.includeAudio === "1");
    try {
      // The reply is awaited, and that is load-bearing rather than tidy: an async handler whose promise resolves
      // with nothing finalizes the reply the moment it returns, which destroys the response stream before `tar`
      // has written a byte of it — measured as a `200`, the right content type, an empty body and
      // `Error: Cannot call write after a stream was destroyed` on the archive itself. `FastifyReply` is thenable
      // (`types/reply.d.ts:95`), so awaiting it is what waits for the stream to finish — and the `finally` is
      // what removes the snapshot and the manifest once nothing is reading them any more.
      await reply.header("content-type", ARCHIVE_MIME).send(archive.stream);
    } finally {
      await archive.discard();
    }
  });
}
