/**
 * The diagnostics registry (AGENTS.md §5, F§10.4).
 *
 * The diagnostics screen runs what is registered here and knows nothing about any particular check, so a
 * later unit adds its own by appending one entry — the same registry shape the web app's settings sections and
 * the desktop shell's features use. This unit registers two: the core goldens, which need no hub, and the
 * hub's own health, which needs the connection saved in Settings or handed over by a `lectern://setup` link.
 *
 * A check never throws: a refusal (no hub configured, a hub that is not answering, a token the hub rejects) is
 * returned as `ok: false` with a sentence the reader can act on.
 */

import { audioChecks } from "../audio/diagnostics";
import { createClient, getConnection } from "../connection";
import { runCoreSelfTest } from "../selftest";
import { storeChecks } from "../stores/diagnostics";

/** What one check reports: whether it held, and one line saying what it saw. */
export interface DiagnosticResult {
  ok: boolean;
  detail: string;
}

/** One registered check: a stable id, a title for the row, and the run itself. */
export interface DiagnosticCheck {
  id: string;
  title: string;
  run(): Promise<DiagnosticResult>;
}

/** F§5.2, F§5.3 and F§5.6's goldens, run on this device's own engine. */
const coreSelfTest: DiagnosticCheck = {
  id: "core-selftest",
  title: "Core self-test",
  async run() {
    const cases = runCoreSelfTest();
    const failed = cases.filter((testCase) => !testCase.ok);
    if (failed.length > 0) {
      return {
        ok: false,
        detail: `${failed.length} of ${cases.length} goldens differ: ${failed.map((testCase) => testCase.name).join(", ")}`,
      };
    }
    return { ok: true, detail: `${cases.length} goldens reproduce on this engine` };
  },
};

/**
 * F§7.2's probe and one authenticated route. `/healthz` answers without a token (F§7.2 exempts it), so a
 * wrong token would still read as a healthy hub; asking for the voice list as well is what makes this check
 * say whether the reader can actually read with this connection.
 */
const hubHealth: DiagnosticCheck = {
  id: "hub-health",
  title: "Hub health",
  async run() {
    const connection = await getConnection();
    if (connection === null) {
      return { ok: false, detail: "no hub is configured yet — save one in Settings or open a lectern://setup link" };
    }
    try {
      const client = await createClient();
      const health = await client.health();
      const voices = await client.voices();
      return {
        ok: health.ok,
        detail: `${connection.hubUrl} · version ${health.version} · engines ${health.engines.join(", ") || "none"} · ${voices.length} voices`,
      };
    } catch (cause) {
      return { ok: false, detail: cause instanceof Error ? cause.message : String(cause) };
    }
  },
};

/** Every registered check, in the order the diagnostics screen runs them. */
export const checks: DiagnosticCheck[] = [coreSelfTest, hubHealth, ...storeChecks, ...audioChecks];
