/**
 * The sync check the diagnostics screen runs on the device (F§8, F§10.4).
 *
 * A round trip is the only thing that proves F§8 end to end on a device: the app's own store, the app's own
 * connection, the real hub over `adb reverse`, and the app's own engine. So this check writes one F§5.9
 * `setting` record — a write that queues an op in the real outbox — asks U-061's service for a round, and
 * then reads the two facts F§8.2 moves: the outbox the hub acknowledged, and the cursor the pull left.
 *
 * Three things it deliberately does not do:
 *
 * - **it does not use a scratch store.** A scratch store would round-trip a document of its own against the
 *   same hub, which proves the hub works and nothing about this app. The outbox and the cursor that matter
 *   are the reader's, so the record written here is the reader's too — one `setting` under the key below,
 *   holding the moment it was written, which is exactly the shape F§8.2 carries to another device.
 * - **it does not push a document.** F§8.2's first round step is uploading a model, and the document bodies
 *   are the one part of F§8 a setting's op does not touch; the document half is what the device harness's own
 *   `push-document.mjs` and `verify-sync.sh` measure, from the other side.
 * - **it never throws.** No hub configured, the switch off, a hub that will not answer: each is a sentence
 *   the reader can act on, which is what the diagnostics screen draws under the row.
 *
 * Nothing platform-specific is loaded when this module is imported — the store, the service and the platform
 * modules behind them are reached inside `run()` — so the registry that lists this check stays importable by
 * the package's Node test program, the rule U-046 and U-047 set for their own checks.
 */

import { MAX_PUSH_OPS } from "@lectern/api-contract";
import type { DiagnosticCheck, DiagnosticResult } from "../diagnostics/checks";

/** The `setting` key this check writes: F§8.2's round has to carry something to be a round. */
export const SYNC_CHECK_SETTING = "sync-roundtrip";

/** How many rounds the check waits through for the outbox to drain and the cursor to move. */
const DRAIN_ATTEMPTS = 10;

/** How long the check waits between those rounds. */
const DRAIN_PAUSE_MS = 500;

/** What a failure is worth saying: the reason, or the value that was thrown. */
function sentence(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** One pause between two rounds. A device check may read the clock; a unit test may not. */
async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** F§8.2's round trip, against the hub the reader has configured. */
const syncRoundTripCheck: DiagnosticCheck = {
  id: "sync-roundtrip",
  title: "Sync round trip",
  async run(): Promise<DiagnosticResult> {
    try {
      const [stores, sync] = await Promise.all([import("../stores"), import("./sync-service")]);
      const { store } = await stores.getStores();
      const service = sync.syncService;
      // The root layout has already started the service with this same store; this makes the check honest on
      // its own, which is what lets it be run from a diagnostics screen opened by a deep link.
      await service.start({ store });
      if (!service.running()) {
        return {
          ok: false,
          detail: "sync is not running — no hub is configured, or this device's switch is off",
        };
      }

      const before = await store.getCursor();
      await store.setSetting(SYNC_CHECK_SETTING, Date.now());

      let pending = await store.pendingOps(MAX_PUSH_OPS);
      let cursor = before;
      let rounds = 0;
      while (rounds < DRAIN_ATTEMPTS) {
        rounds += 1;
        await service.syncNow();
        pending = await store.pendingOps(MAX_PUSH_OPS);
        cursor = await store.getCursor();
        if (pending.length === 0 && cursor > before) break;
        await pause(DRAIN_PAUSE_MS);
      }

      if (pending.length > 0) {
        return { ok: false, detail: `the outbox still holds ${pending.length} op(s) after ${rounds} round(s)` };
      }
      if (cursor <= before) {
        return { ok: false, detail: `the cursor did not move past ${before} in ${rounds} round(s)` };
      }
      return {
        ok: true,
        detail: `a setting was written and carried: the outbox is empty and the cursor moved ${before} → ${cursor}`,
      };
    } catch (cause) {
      return { ok: false, detail: sentence(cause) };
    }
  },
};

/** Every check this unit registers, in the order the diagnostics screen runs them. */
export const syncChecks: DiagnosticCheck[] = [syncRoundTripCheck];
