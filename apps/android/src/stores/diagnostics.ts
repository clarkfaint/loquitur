/**
 * The two store checks the diagnostics screen runs on the device (F§5.9, F§10.4).
 *
 * A conformance suite is the measure of a store, and the device is the one place it can be run against the
 * device's *own* SQLite and file system — the Node suite covers the SQL, but not `expo-sqlite`'s asynchronous
 * API, not `expo-file-system`'s document directory, and not the platform's own transaction handling. So these
 * two checks run the same suites every other platform's store runs, and report how many cases held.
 *
 * **A check never touches the reader's library.** Every case gets a scratch database of its own
 * (`lectern-u046-check-<n>.db`), and the cache a scratch directory of its own (`blobs-check-<n>/`), and both
 * are deleted in a `finally`, whatever the run did — the reader's own `lectern.db` and `blobs/` are not
 * opened at all. A case also gets a *fresh* database and directory rather than a fresh store over a shared
 * one, because a suite case expects a store that holds nothing: one shared database would let an earlier
 * case's document appear in a later case's unfiltered list (the shape U-026's store test records).
 *
 * Nothing platform-specific is loaded until a check runs — the drivers and the file system are built inside
 * `run()` — so importing the registry that lists these checks is safe in a Node environment, which is where
 * `apps/android`'s own test program imports it.
 */

import {
  type BlobCacheFactory,
  type LibraryStoreFactory,
  runBlobCacheConformance,
  runLibraryStoreConformance,
} from "@lectern/core/testing";
import { createFsBlobCache, createSqlLibraryStore, migrate } from "@lectern/store-sql";
import type { DiagnosticCheck, DiagnosticResult } from "../diagnostics/checks";
import { createExpoBlobFs, removeExpoDirectory } from "./expo-blob-fs";
import { deleteExpoSqliteDatabase, type ExpoSqliteDriver, openExpoSqliteDriver } from "./expo-sqlite-driver";

/** The name of a case's scratch database, numbered so two cases cannot share one. */
function scratchDatabase(index: number): string {
  return `lectern-u046-check-${index}.db`;
}

/** The name of a case's scratch directory, numbered the same way. */
function scratchDirectory(index: number): string {
  return `blobs-check-${index}`;
}

/** What a failure is worth saying: the reason, or the value that was thrown. */
function sentence(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Run a cleanup step, ignoring a failure: the check's own answer has already been decided by then. */
async function ignoring(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch {
    return;
  }
}

/** A suite's results as the diagnostics screen's one line, naming every case that did not hold. */
function report(results: readonly { name: string; ok: boolean; error?: string }[]): DiagnosticResult {
  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    const names = failed.map((result) => `${result.name} (${result.error ?? "failed"})`).join("; ");
    return { ok: false, detail: `${failed.length} of ${results.length} cases failed: ${names}` };
  }
  return { ok: true, detail: `${results.length} conformance cases pass on this device` };
}

/** F§5.9's library-store suite, run against the device's own SQLite. */
const libraryStoreCheck: DiagnosticCheck = {
  id: "library-store",
  title: "Library store (SQLite)",
  async run() {
    const opened: ExpoSqliteDriver[] = [];
    const databases: string[] = [];
    try {
      let cases = 0;
      const factory: LibraryStoreFactory = async (options) => {
        cases += 1;
        const name = scratchDatabase(cases);
        databases.push(name);
        const driver = await openExpoSqliteDriver(name);
        opened.push(driver);
        await migrate(driver);
        return createSqlLibraryStore({ driver, ...options });
      };
      return report(await runLibraryStoreConformance(factory));
    } catch (cause) {
      return { ok: false, detail: sentence(cause) };
    } finally {
      for (const driver of opened) await ignoring(() => driver.close());
      for (const name of databases) await ignoring(() => deleteExpoSqliteDatabase(name));
    }
  },
};

/** F§5.9's blob-cache suite, run against the device's own file system and SQLite. */
const blobCacheCheck: DiagnosticCheck = {
  id: "blob-cache",
  title: "Blob cache (files)",
  async run() {
    const opened: ExpoSqliteDriver[] = [];
    const databases: string[] = [];
    const directories: string[] = [];
    try {
      let cases = 0;
      const factory: BlobCacheFactory = async () => {
        cases += 1;
        const name = scratchDatabase(cases);
        const directory = scratchDirectory(cases);
        databases.push(name);
        directories.push(directory);
        const driver = await openExpoSqliteDriver(name);
        opened.push(driver);
        await migrate(driver);
        return createFsBlobCache({ fs: await createExpoBlobFs(directory), driver, now: () => Date.now() });
      };
      return report(await runBlobCacheConformance(factory));
    } catch (cause) {
      return { ok: false, detail: sentence(cause) };
    } finally {
      for (const driver of opened) await ignoring(() => driver.close());
      for (const name of databases) await ignoring(() => deleteExpoSqliteDatabase(name));
      for (const directory of directories) await ignoring(() => removeExpoDirectory(directory));
    }
  },
};

/** Every check this unit registers, in the order the diagnostics screen runs them. */
export const storeChecks: DiagnosticCheck[] = [libraryStoreCheck, blobCacheCheck];
