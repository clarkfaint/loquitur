/**
 * The audio check the diagnostics screen runs on the device (F§5.8, F§10.4).
 *
 * A conformance suite is the measure of a sink, and the device is the one place F§5.8's suite can be run
 * against the *real* queue — a native playlist, the platform's own audio stack, and the platform's own timing.
 * The Node suite cannot stand in for that: it has no player, and the two things this sink is judged on (that
 * the queue advances by itself and that a rate really halves the wall time) only exist on a device.
 *
 * **A check never touches the reader's own data.** The probe audio is written to a scratch blob cache with a
 * scratch database of its own (`lectern-u047-check.db`, `blobs-u047-check/`), and both are deleted in a
 * `finally`, whatever the run did. The reader's `lectern.db`, its `blobs/` directory and its library are not
 * opened at all — the same rule U-046's store checks follow, for the same reason.
 *
 * **The probe chunks are real chunks.** Each one is synthesized by F§6's mock engine, sized by the engine's own
 * duration law (60 ms per letter and digit, floored at 200 ms) so a case gets a chunk about as long as it asked
 * for, and named by F§6's own `chunkIdFor`. The duration reported back is the WAV's own, which is what makes
 * the suite's measurements comparable across a device and a laptop.
 *
 * Nothing platform-specific is loaded until the check runs: the driver, the file system, the audio session and
 * the sink are all built inside `run()`, so importing the registry that lists this check is safe in a Node
 * environment — which is where the package's own test program imports it.
 */

import { runAudioQueueSinkConformance } from "@lectern/core/testing";
import { chunkIdFor, createMockEngine } from "@lectern/core-tts";
import { createFsBlobCache, createSqlLibraryStore, migrate } from "@lectern/store-sql";
import type { DiagnosticCheck, DiagnosticResult } from "../diagnostics/checks";
import { createExpoBlobFs, removeExpoDirectory } from "../stores/expo-blob-fs";
import { deleteExpoSqliteDatabase, type ExpoSqliteDriver, openExpoSqliteDriver } from "../stores/expo-sqlite-driver";
import { configureAudioSession } from "./audio-session";
import { createExpoQueueSink, readSinkMaxRate, SINK_MAX_RATE_SETTING } from "./expo-queue-sink";

/** The scratch database and directory this check owns. Neither is the reader's. */
const SCRATCH_DATABASE = "lectern-u047-check.db";
const SCRATCH_DIRECTORY = "blobs-u047-check";

/** The identity a scratch store is stamped with. It never writes a record, so it never stamps one. */
const SCRATCH_DEVICE_ID = "u047-check";

/** The mock engine's own duration law (F§6): 60 ms per letter or digit, floored at 200 ms. */
const MS_PER_LETTER = 60;

/** The two letters a probe word is made of, so a chunk's length is the engine's decision and nothing else. */
const PROBE_WORD = "ta";

/** The mock voice the probe chunks are synthesized with (F§6). */
const PROBE_VOICE_ID = "mock-a";

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

/**
 * The text a probe chunk of about `durationMs` is made of: enough letters for F§6's law to reach that long,
 * grouped into two-letter words so the engine's own tokenizer has words to time.
 */
function probeText(durationMs: number): string {
  const letters = Math.max(PROBE_WORD.length, Math.round(durationMs / MS_PER_LETTER));
  const words = Math.ceil(letters / PROBE_WORD.length);
  return Array.from({ length: words }, () => PROBE_WORD).join(" ");
}

/** F§5.8's sink suite, run against the device's own audio queue. */
const audioSinkCheck: DiagnosticCheck = {
  id: "audio-sink",
  title: "Audio queue sink (playlist)",
  async run(): Promise<DiagnosticResult> {
    const opened: ExpoSqliteDriver[] = [];
    try {
      // F§10.4's mode first: the suite plays, and the app plays under this mode.
      await configureAudioSession();

      const driver = await openExpoSqliteDriver(SCRATCH_DATABASE);
      opened.push(driver);
      await migrate(driver);
      const cache = createFsBlobCache({ fs: await createExpoBlobFs(SCRATCH_DIRECTORY), driver, now: () => Date.now() });
      const store = createSqlLibraryStore({
        driver,
        deviceId: SCRATCH_DEVICE_ID,
        now: () => Date.now(),
        newId: () => SCRATCH_DEVICE_ID,
      });

      // The ceiling the settings ask for — 2× until the reader lowers `sinkMaxRate`, which is the value F§5.8
      // gives this platform. Every sink the suite builds gets it, and the last one's own reading is reported.
      const maxRate = await readSinkMaxRate(store);
      const engine = createMockEngine();
      let acceptedRate = 0;

      const results = await runAudioQueueSinkConformance(
        async () => {
          const sink = await createExpoQueueSink({ maxRate });
          acceptedRate = sink.maxRate;
          return sink;
        },
        {
          wait: (ms) =>
            new Promise((resolve) => {
              setTimeout(resolve, ms);
            }),
          makeChunk: async (durationMs) => {
            const text = probeText(durationMs);
            const synthesized = await engine.synthesize({ text, engineVoiceId: PROBE_VOICE_ID, synthSpeed: 1 });
            const chunkId = chunkIdFor(engine.id, PROBE_VOICE_ID, 1, text);
            const uri = await cache.put(`probe/${chunkId}`, synthesized.audio, synthesized.mime);
            return { chunkId, uri, durationMs: synthesized.durationMs };
          },
        },
      );

      const failed = results.filter((result) => !result.ok);
      if (failed.length > 0) {
        const names = failed.map((result) => `${result.name} (${result.error ?? "failed"})`).join("; ");
        return { ok: false, detail: `${failed.length} of ${results.length} cases failed: ${names}` };
      }
      return {
        ok: true,
        detail: `${results.length} conformance cases pass on this device · the sink accepts ${acceptedRate}× (F§5.8's ${SINK_MAX_RATE_SETTING})`,
      };
    } catch (cause) {
      return { ok: false, detail: sentence(cause) };
    } finally {
      for (const driver of opened) await ignoring(() => driver.close());
      await ignoring(() => deleteExpoSqliteDatabase(SCRATCH_DATABASE));
      await ignoring(() => removeExpoDirectory(SCRATCH_DIRECTORY));
    }
  },
};

/** Every check this unit registers, in the order the diagnostics screen runs them. */
export const audioChecks: DiagnosticCheck[] = [audioSinkCheck];
