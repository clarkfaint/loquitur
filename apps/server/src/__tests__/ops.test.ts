/**
 * U-066's operations, end to end: F§7.2's backup route, F§12's restore command and F§7.3's cache pruning.
 *
 * Every case drives the real hub — U-055's SQLite database, U-055's document files and U-019's TTS cache under a
 * temporary data directory, reached through the route registry as `buildApp` builds it — and the archives are
 * real `tar.gz` files that the repository's own `tar` both writes (for the two cases that need an archive a
 * restore must refuse) and reads (to see what the route actually streamed). The hostile archives are built
 * rather than mocked, and each case asserts the hostile entry really is in the archive before asserting that the
 * restore refuses it, so no refusal case can pass by accident.
 *
 * Reading and writing files needs `node:fs`, so this file stays outside the package's type-check program (its
 * test directories are excluded): vitest erases types instead of checking them and runs it as written.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { PullResponseSchema } from "@lectern/api-contract";
import { buildDocument, type DocumentMeta, type DocumentModel, DocumentModelSchema, type Op } from "@lectern/core";
import type { FastifyInstance, InjectOptions } from "fastify";
import { create, extract, list } from "tar";
import { expect, test } from "vitest";
import { buildApp } from "../app";
import { pruneCache, runPruneCli } from "../cli/prune-cache";
import { isSafeEntryPath, restoreArchive, runRestoreCli } from "../cli/restore";
import { loadConfig } from "../config";
import { openDatabase } from "../db/database";
import { SCHEMA_VERSION } from "../db/migrations";
import { type BackupManifest, BackupManifestSchema } from "../routes/admin";

/** F§7.1's token floor is 32 characters; this one clears it and appears in no other file. */
const TOKEN = "lectern-ops-test-token-0123456789";

const AUTHORIZATION = { authorization: `Bearer ${TOKEN}` };
const JSON_HEADERS = { ...AUTHORIZATION, "content-type": "application/json" };

/** The device identity the push cases use (F§8.2). */
const DEVICE = "device-ops-test";

/** One day in milliseconds, for the cache entries the prune cases stamp by hand. */
const DAY_MS = 86_400_000;

/** One open hub: its app, and the data directory both it and this file read. */
interface Hub {
  app: FastifyInstance;
  dataDir: string;
}

/** A document built the way F§5.1–F§5.4 build one, so its own `docId` is the one F§5.2 computes. */
function builtDocument(text: string): DocumentModel {
  return buildDocument([{ kind: "paragraph", text }], { source: { kind: "txt" } });
}

/** A model as F§7.2's upload carries it: the `DocumentModel` JSON, gzipped. */
function gzipped(model: DocumentModel): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(model)));
}

/** F§5.9's document metadata for one id — the record a push carries, without its model. */
function documentRecord(docId: string, ts: number): DocumentMeta {
  return {
    docId,
    title: "A backed-up document",
    sourceKind: "txt",
    folderId: null,
    addedAt: ts,
    wordCount: 5,
    sentenceCount: 1,
    updatedAt: ts,
    deleted: false,
  };
}

/** One op that writes a document's metadata, stamped by the device that made it (F§5.9). */
function documentPut(opId: string, docId: string, ts: number): Op {
  return { opId, deviceId: DEVICE, entity: "document", entityId: docId, kind: "put", ts, record: documentRecord(docId, ts) };
}

/** A request that uploads one document's gzipped model (F§7.2). */
function putModel(docId: string, payload: Uint8Array): InjectOptions {
  return {
    method: "PUT",
    url: `/v1/library/documents/${docId}/model`,
    headers: { ...AUTHORIZATION, "content-type": "application/gzip" },
    payload,
  };
}

/** A request that reads one document's gzipped model back (F§7.2). */
function getModel(docId: string): InjectOptions {
  return { method: "GET", url: `/v1/library/documents/${docId}/model`, headers: AUTHORIZATION };
}

/** One hub over a data directory of its own, built the way `main.ts` builds one. */
async function openHub(dataDir: string, env: Readonly<Record<string, string>> = {}): Promise<FastifyInstance> {
  return await buildApp(loadConfig({ LECTERN_TOKEN: TOKEN, LECTERN_DATA_DIR: dataDir, ...env }));
}

/** A hub over its own temporary data directory, closed and removed however the case ends. */
async function withHub(run: (hub: Hub) => Promise<void>, env: Readonly<Record<string, string>> = {}): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "lectern-ops-hub-"));
  const app = await openHub(dataDir, env);
  try {
    await run({ app, dataDir });
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** A scratch directory of its own, removed however the case ends. */
async function withScratch(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "lectern-ops-scratch-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The archive `GET /v1/admin/backup` streams, written to a file so `tar` can read what the route produced. */
async function fetchArchive(app: FastifyInstance, path: string, query = ""): Promise<Buffer> {
  const response = await app.inject({ method: "GET", url: `/v1/admin/backup${query}`, headers: AUTHORIZATION });
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toContain("application/gzip");
  await writeFile(path, response.rawPayload);
  return response.rawPayload;
}

/** Every entry name an archive holds, in the order tar reports them. */
async function entriesOf(archive: string): Promise<string[]> {
  const entries: string[] = [];
  await list({
    file: archive,
    onReadEntry: (entry) => {
      entries.push(entry.path);
    },
  });
  return entries;
}

/** The manifest an archive carries, read out of a directory of its own (F§7.2). */
async function manifestOf(archive: string, dir: string): Promise<BackupManifest> {
  await mkdir(dir, { recursive: true });
  await extract({ file: archive, cwd: dir, portable: true, filter: (path) => path === "manifest.json" });
  return BackupManifestSchema.parse(JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as unknown);
}

/** Every file under a directory, as paths relative to it, in name order. */
async function filesBelow(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await filesBelow(join(root, entry.name), path)));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

/** One synthesis with the mock engine, so F§7.3's cache holds something a backup can be asked about. */
async function synthesizeOnce(app: FastifyInstance): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/tts",
    headers: JSON_HEADERS,
    payload: { text: "The lamp burned driftwood on the shore.", voiceId: "mock:mock-a" },
  });
  expect(response.statusCode).toBe(200);
}

/**
 * One F§7.3 cache entry — an audio file and its sidecar under the chunk id's shard — stamped at an instant by
 * hand, so a case's cutoff arithmetic is the case's own rather than a wall clock's.
 */
async function cacheEntry(dataDir: string, chunkId: string, mtimeMs: number): Promise<{ bytes: number; files: string[] }> {
  const shard = chunkId.slice(0, 2);
  const directory = join(dataDir, "tts-cache", shard);
  await mkdir(directory, { recursive: true });
  const audio = `${chunkId}.wav`;
  const metadata = `${chunkId}.json`;
  await writeFile(join(directory, audio), "a".repeat(1000));
  await writeFile(
    join(directory, metadata),
    JSON.stringify({ chunkId, mime: "audio/wav", durationMs: 1000, timings: [], timingSource: "estimated" }),
  );
  for (const name of [audio, metadata]) await utimes(join(directory, name), new Date(mtimeMs), new Date(mtimeMs));
  const size = (await stat(join(directory, metadata))).size;
  return { bytes: 1000 + size, files: [`${shard}/${audio}`, `${shard}/${metadata}`].sort() };
}

/** An archive with a hand-written manifest, so a case can ask what a restore does with one it did not write. */
async function stagedArchive(dir: string, manifest: unknown, payload: Readonly<Record<string, string>>): Promise<string> {
  const staging = join(dir, "staged");
  await mkdir(staging, { recursive: true });
  for (const [name, text] of Object.entries(payload)) await writeFile(join(staging, name), text);
  await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest));
  const archive = join(dir, "staged.tar.gz");
  await create({ gzip: true, file: archive, cwd: staging, portable: true }, [...Object.keys(payload), "manifest.json"]);
  return archive;
}

test("a backup carries the database, the library and a manifest, and neither the cache nor a secret", async () => {
  const model = builtDocument("The map stayed folded in the drawer all winter.");
  await withHub(
    async ({ app, dataDir }) => {
      expect((await app.inject(putModel(model.docId, gzipped(model)))).statusCode).toBe(204);
      const pushed = await app.inject({
        method: "POST",
        url: "/v1/sync/push",
        headers: JSON_HEADERS,
        payload: { deviceId: DEVICE, ops: [documentPut("op-1", model.docId, 1)] },
      });
      expect(pushed.statusCode).toBe(200);
      await synthesizeOnce(app);
      expect(await filesBelow(join(dataDir, "tts-cache"))).not.toHaveLength(0);

      await withScratch(async (dir) => {
        const archive = join(dir, "backup.tar.gz");
        const payload = await fetchArchive(app, archive);
        const entries = await entriesOf(archive);
        const manifest = await manifestOf(archive, join(dir, "manifest"));

        expect(entries).toContain("lectern.db");
        expect(entries).toContain(`library/${model.docId}/model.json.gz`);
        expect(entries).toContain("manifest.json");
        // The snapshot is the archive's database, and the live file's write-ahead siblings are not in it.
        expect(entries).not.toContain("lectern.db-wal");
        expect(entries).not.toContain("lectern.db-shm");
        // F§7.3's cache was written and left out, so its absence is an exclusion rather than an accident.
        expect(entries.filter((entry) => entry.startsWith("tts-cache/"))).toHaveLength(0);
        expect(entries.filter((entry) => entry.includes(".env"))).toHaveLength(0);
        expect(manifest.files).toContain("lectern.db");
        expect(manifest.files).toContain(`library/${model.docId}/model.json.gz`);
        expect(manifest.schemaVersion).toBe(SCHEMA_VERSION);
        // The manifest's own table of contents and the archive's describe one another.
        expect([...manifest.files].sort()).toEqual(entries.filter((entry) => entry !== "manifest.json" && !entry.endsWith("/")).sort());
        // No secret travels: the hub's token is in none of the archive's bytes.
        expect(gunzipSync(payload).includes(TOKEN)).toBe(false);
        // Nothing staged is left behind: the snapshot and the manifest belong to the stream, not to the hub.
        expect((await readdir(dataDir)).filter((name) => name.startsWith(".backup-"))).toEqual([]);

        // The archived database is a usable snapshot of the hub that took it, not just a member named like one.
        const restored = join(dir, "snapshot");
        expect((await restoreArchive({ archive, dataDir: restored })).schemaVersion).toBe(SCHEMA_VERSION);
        const db = await openDatabase(restored);
        try {
          const rows = db.prepare("SELECT entity_id FROM records").all() as { entity_id: string }[];
          expect(rows.map((row) => row.entity_id)).toEqual([model.docId]);
        } finally {
          db.close();
        }
      });
    },
    { LECTERN_ENABLE_MOCK: "1" },
  );
});

test("?includeAudio=1 is what adds F§7.3's cache to a backup", async () => {
  await withHub(
    async ({ app, dataDir }) => {
      await synthesizeOnce(app);
      const cached = await filesBelow(join(dataDir, "tts-cache"));
      expect(cached).not.toHaveLength(0);

      await withScratch(async (dir) => {
        const quiet = join(dir, "quiet.tar.gz");
        await fetchArchive(app, quiet);
        expect((await entriesOf(quiet)).filter((entry) => entry.startsWith("tts-cache/"))).toHaveLength(0);

        const loud = join(dir, "audio.tar.gz");
        await fetchArchive(app, loud, "?includeAudio=1");
        const entries = await entriesOf(loud);
        const manifest = await manifestOf(loud, join(dir, "manifest"));
        for (const name of cached) {
          expect(entries).toContain(`tts-cache/${name}`);
          expect(manifest.files).toContain(`tts-cache/${name}`);
        }
        // Both archive forms clean up after themselves.
        expect((await readdir(dataDir)).filter((name) => name.startsWith(".backup-"))).toEqual([]);
      });
    },
    { LECTERN_ENABLE_MOCK: "1" },
  );
});

test("a restored backup gives a new hub the same pull result and the same model bytes", async () => {
  const source = await mkdtemp(join(tmpdir(), "lectern-ops-source-"));
  const target = await mkdtemp(join(tmpdir(), "lectern-ops-target-"));
  const scratch = await mkdtemp(join(tmpdir(), "lectern-ops-archive-"));
  try {
    const model = builtDocument("A kettle sang on the iron stove until the water boiled.");
    const body = gzipped(model);
    const archive = join(scratch, "backup.tar.gz");
    let before: unknown;
    let bytes = Buffer.from("");

    const hub = await openHub(source);
    try {
      expect((await hub.inject(putModel(model.docId, body))).statusCode).toBe(204);
      const pushed = await hub.inject({
        method: "POST",
        url: "/v1/sync/push",
        headers: JSON_HEADERS,
        payload: { deviceId: DEVICE, ops: [documentPut("op-1", model.docId, 7)] },
      });
      expect(pushed.statusCode).toBe(200);
      const pulled = await hub.inject({ method: "GET", url: "/v1/sync/pull?since=0", headers: AUTHORIZATION });
      expect(pulled.statusCode).toBe(200);
      before = PullResponseSchema.parse(pulled.json() as unknown);
      const fetched = await hub.inject(getModel(model.docId));
      expect(fetched.statusCode).toBe(200);
      bytes = fetched.rawPayload;
      await fetchArchive(hub, archive);
    } finally {
      await hub.close();
    }

    const report = await restoreArchive({ archive, dataDir: target });
    expect(report.schemaVersion).toBe(SCHEMA_VERSION);
    expect(report.files).toBe(2);

    const restored = await openHub(target);
    try {
      const pulled = await restored.inject({ method: "GET", url: "/v1/sync/pull?since=0", headers: AUTHORIZATION });
      expect(pulled.statusCode).toBe(200);
      expect(PullResponseSchema.parse(pulled.json() as unknown)).toEqual(before);
      const fetched = await restored.inject(getModel(model.docId));
      expect(fetched.statusCode).toBe(200);
      expect(Buffer.compare(fetched.rawPayload, bytes)).toBe(0);
      expect(DocumentModelSchema.parse(JSON.parse(gunzipSync(fetched.rawPayload).toString("utf8")) as unknown)).toEqual(model);
    } finally {
      await restored.close();
    }
  } finally {
    for (const dir of [source, target, scratch]) await rm(dir, { recursive: true, force: true });
  }
});

test("a restore refuses a target that is not empty, and leaves it exactly as it was", async () => {
  await withHub(async ({ app }) => {
    await withScratch(async (dir) => {
      const archive = join(dir, "backup.tar.gz");
      await fetchArchive(app, archive);
      const target = join(dir, "target");
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "lectern.db"), "the hub that is already here");

      await expect(restoreArchive({ archive, dataDir: target })).rejects.toThrow(/not empty/);
      expect(await readdir(target)).toEqual(["lectern.db"]);
      expect(await readFile(join(target, "lectern.db"), "utf8")).toBe("the hub that is already here");
    });
  });
});

test("a restore refuses an archive whose entry would leave the target, and writes nothing", async () => {
  await withScratch(async (dir) => {
    const staging = join(dir, "staging");
    await mkdir(staging, { recursive: true });
    await writeFile(join(dir, "escape.txt"), "outside the archive's own tree");
    const archive = join(dir, "escape.tar.gz");
    // `tar` writes a `..` entry only when `preservePaths` is asked for, which is how a hostile archive is made.
    await create({ gzip: true, file: archive, cwd: staging, preservePaths: true }, ["../escape.txt"]);
    expect(await entriesOf(archive)).toContain("../escape.txt");

    const target = join(dir, "target");
    await expect(restoreArchive({ archive, dataDir: target })).rejects.toThrow(/leave the target directory/);
    expect(await readdir(target)).toEqual([]);
    expect(await readFile(join(dir, "escape.txt"), "utf8")).toBe("outside the archive's own tree");
  });
});

test("a restore refuses an archive whose manifest names a schema version this build cannot read", async () => {
  await withScratch(async (dir) => {
    const later = await stagedArchive(
      join(dir, "later"),
      { createdAt: "2026-01-01T00:00:00.000Z", schemaVersion: SCHEMA_VERSION + 1, files: ["lectern.db"] },
      { "lectern.db": "a database from a later build" },
    );
    const refused = join(dir, "refused");
    await expect(restoreArchive({ archive: later, dataDir: refused })).rejects.toThrow(/schema version/);
    expect(await readdir(refused)).toEqual([]);

    // The same archive at this build's version restores, so the refusal is about the version and nothing else.
    const readable = await stagedArchive(
      join(dir, "again"),
      { createdAt: "2026-01-01T00:00:00.000Z", schemaVersion: SCHEMA_VERSION, files: ["lectern.db"] },
      { "lectern.db": "a database from this build" },
    );
    const accepted = join(dir, "accepted");
    expect((await restoreArchive({ archive: readable, dataDir: accepted })).files).toBe(1);
    expect(await readFile(join(accepted, "lectern.db"), "utf8")).toBe("a database from this build");
  });
});

test("a restore refuses an archive that holds no manifest, and one whose manifest does not describe its files", async () => {
  await withScratch(async (dir) => {
    const bare = join(dir, "bare");
    await mkdir(bare, { recursive: true });
    await writeFile(join(bare, "lectern.db"), "no manifest travels with me");
    const noManifest = join(dir, "no-manifest.tar.gz");
    await create({ gzip: true, file: noManifest, cwd: bare, portable: true }, ["lectern.db"]);
    await expect(restoreArchive({ archive: noManifest, dataDir: join(dir, "first") })).rejects.toThrow(/holds no manifest\.json/);

    const disagreeing = await stagedArchive(
      join(dir, "disagree"),
      { createdAt: "2026-01-01T00:00:00.000Z", schemaVersion: SCHEMA_VERSION, files: ["lectern.db", "library/abc/model.json.gz"] },
      { "lectern.db": "here it is" },
    );
    await expect(restoreArchive({ archive: disagreeing, dataDir: join(dir, "second") })).rejects.toThrow(
      /does not hold what its manifest describes/,
    );
    expect(await readdir(join(dir, "second"))).toEqual([]);
  });
});

test("no archive entry may name a path outside the target directory", () => {
  for (const safe of ["lectern.db", "manifest.json", "library/abc/model.json.gz", "library/abc/", "tts-cache/ab/abcd.wav"]) {
    expect(isSafeEntryPath(safe)).toBe(true);
  }
  for (const unsafe of [
    "",
    "/etc/passwd",
    "../escape.txt",
    "library/../../escape.txt",
    "library/./model.json.gz",
    "library//model.json.gz",
    "a\\b",
    "C:\\data\\lectern.db",
  ]) {
    expect(isSafeEntryPath(unsafe)).toBe(false);
  }
});

test("a prune removes only the entries older than the cutoff, and keeps each entry's audio and metadata together", async () => {
  await withScratch(async (dir) => {
    const now = Date.UTC(2026, 10, 18, 12, 0, 0);
    const old = await cacheEntry(dir, "aa11", now - 10 * DAY_MS);
    const fresh = await cacheEntry(dir, "bb22", now - 1 * DAY_MS);

    const report = await pruneCache({ dataDir: dir, days: 5, now });
    expect(report).toEqual({ entries: 2, removed: 1, bytes: old.bytes, dryRun: false, dataDir: dir });
    expect(await filesBelow(join(dir, "tts-cache"))).toEqual(fresh.files);
    // The whole old entry went — audio and metadata together — and nothing of the fresh one did.
    for (const name of old.files) await expect(readFile(join(dir, "tts-cache", name))).rejects.toThrow();
    for (const name of fresh.files) await expect(readFile(join(dir, "tts-cache", name))).resolves.toBeDefined();
  });
});

test("a dry run reports what it would remove and removes nothing", async () => {
  await withScratch(async (dir) => {
    const now = Date.UTC(2026, 10, 18, 12, 0, 0);
    const old = await cacheEntry(dir, "cc33", now - 30 * DAY_MS);
    const fresh = await cacheEntry(dir, "dd44", now - 2 * DAY_MS);

    const reported = await pruneCache({ dataDir: dir, days: 7, now, dryRun: true });
    expect(reported.removed).toBe(1);
    expect(reported.bytes).toBe(old.bytes);
    expect(reported.dryRun).toBe(true);
    expect(await filesBelow(join(dir, "tts-cache"))).toEqual([...old.files, ...fresh.files].sort());

    // The same cache, the same cutoff, without the dry run: exactly that entry goes.
    expect((await pruneCache({ dataDir: dir, days: 7, now })).removed).toBe(1);
    expect(await filesBelow(join(dir, "tts-cache"))).toEqual(fresh.files);
  });
});

test("the commands read their arguments, report what they did, and refuse what they cannot do", async () => {
  await withScratch(async (dir) => {
    const lines: string[] = [];
    const errors: string[] = [];
    const io = {
      out: (message: string) => lines.push(message),
      err: (message: string) => errors.push(message),
    };

    await withHub(async ({ app }) => {
      const archive = join(dir, "backup.tar.gz");
      await fetchArchive(app, archive);
      const target = join(dir, "cli-target");
      expect(await runRestoreCli([archive, target], io)).toBe(0);
      // The hub has no documents, so its archive holds the database alone and the manifest says so.
      expect(lines.join("\n")).toMatch(/^restored 1 file\(s\) at schema version \d+ from a backup taken .+ into /);
      expect(await readdir(target)).toContain("lectern.db");
    });
    // Half a command line is a usage line, and restoring over what the first run wrote is the other refusal.
    expect(await runRestoreCli([join(dir, "backup.tar.gz")], io)).toBe(1);
    expect(await runRestoreCli([join(dir, "backup.tar.gz"), join(dir, "cli-target")], io)).toBe(1);
    expect(errors.some((line) => line.includes("Usage: node dist/restore.mjs"))).toBe(true);
    expect(errors.some((line) => line.includes("not empty"))).toBe(true);

    const cache = join(dir, "cache");
    await mkdir(cache, { recursive: true });
    await cacheEntry(cache, "ee55", Date.now() - 40 * DAY_MS);
    lines.length = 0;
    expect(await runPruneCli(["--days", "30", "--dry-run"], { LECTERN_DATA_DIR: cache }, io)).toBe(0);
    expect(lines[0]).toMatch(/^would prune 1 of 1 cache entry \(\d+ bytes\) under /);
    lines.length = 0;
    expect(await runPruneCli(["--days", "30"], { LECTERN_DATA_DIR: cache }, io)).toBe(0);
    expect(lines[0]).toMatch(/^pruned 1 of 1 cache entry \(\d+ bytes\) under /);
    expect(await filesBelow(join(cache, "tts-cache"))).toEqual([]);

    // No age at all, an age that is not a number, and an argument the command does not take are each refused.
    errors.length = 0;
    expect(await runPruneCli([], {}, io)).toBe(1);
    expect(await runPruneCli(["--days", "soon"], {}, io)).toBe(1);
    expect(await runPruneCli(["--days"], {}, io)).toBe(1);
    expect(await runPruneCli(["--days", "1", "--weeks", "2"], {}, io)).toBe(1);
    expect(await runPruneCli(["--days", "-1"], {}, io)).toBe(1);
    expect(errors.filter((line) => line === "Usage: node dist/prune-cache.mjs --days <n> [--dry-run]")).toHaveLength(5);
  });
});

test("the backup route is behind F§11's token like every other route", async () => {
  await withHub(async ({ app }) => {
    const refused = await app.inject({ method: "GET", url: "/v1/admin/backup" });
    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toEqual({ error: { code: "UNAUTHORIZED", message: expect.any(String) } });
  });
});
