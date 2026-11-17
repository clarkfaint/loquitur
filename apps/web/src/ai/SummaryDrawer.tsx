/**
 * The summary drawer (F§10.1, F§9): the reader's way into F§9's summaries.
 *
 * The drawer owns the state the panel does not — which mode the reader has chosen, what the hub last said about
 * it, and the one job that may be in flight. Three behaviours are worth naming.
 *
 * - **Opening the drawer asks nothing.** It reads the hub's own state (`getSummary`) and draws what is there: a
 *   summary made earlier, or nothing at all. F§9's job is only ever started by the reader pressing the control,
 *   which is what keeps a reader from spending a model call by looking.
 * - **The mode is part of the question.** Switching it reads the hub's state for that mode, so a document with a
 *   cached brief summary shows it at once while the other mode shows whatever it has.
 * - **A job is waited for on F§9's schedule, and abandoned when the drawer goes.** `waitForSummary` polls with
 *   the page's clock until the job is done or has failed; closing the drawer, or switching mode, aborts the wait,
 *   so a drawer that is gone cannot write a stale result into a screen that is no longer there.
 */

import { AiClientError } from "@lectern/api-client";
import { AiErrorCodeSchema, type AnySummaryResult, type SummaryError, type SummaryMode, type SummaryStatus } from "@lectern/api-contract";
import type { Clock } from "@lectern/core";
import { SummaryPanel, type SummaryState } from "@lectern/ui-web";
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import { aiClient, generate, listen } from "./summary-service";

/** The page's clock: the one place this screen reads the time or schedules against it (F§5.7). */
const PAGE_CLOCK: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (handle) => window.clearTimeout(handle),
};

/** What the panel draws: the hub's state, its result and its failure, as one value. */
interface Phase {
  status: SummaryState;
  result: AnySummaryResult | null;
  error: SummaryError | null;
}

/** The state a drawer opens in, and the one a document with no summary is in. */
const NOTHING: Phase = { status: "none", result: null, error: null };

/** The hub's own state as this screen's. */
function phaseOf(status: SummaryStatus): Phase {
  return { status: status.status, result: status.result ?? null, error: status.error ?? null };
}

/**
 * A failure as F§9's error object: the hub's own code when it is one of F§9's, and the client's reading of "the
 * endpoint could not be reached" otherwise.
 */
function problemOf(cause: unknown): SummaryError {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (cause instanceof AiClientError) {
    const code = AiErrorCodeSchema.safeParse(cause.code);
    if (code.success) return { code: code.data, message };
  }
  return { code: "LLM_UNAVAILABLE", message };
}

export interface SummaryDrawerProps {
  /** The document the reader is on. */
  docId: string;
  /** Close the drawer. */
  onClose: () => void;
}

export function SummaryDrawer({ docId, onClose }: SummaryDrawerProps): ReactElement {
  const [mode, setMode] = useState<SummaryMode>("brief");
  const [phase, setPhase] = useState<Phase>(NOTHING);
  const waitingRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);

  /**
   * Read what the hub already holds for this document and mode, and draw it.
   *
   * A reader who presses the control while this read is in flight must not have the running state replaced by
   * the `none` this read was about to find, so every answer is dropped once another question has been asked.
   */
  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    let live = true;
    void aiClient()
      .getSummary(docId, mode)
      .then(
        (status) => {
          if (live && generationRef.current === generation) setPhase(phaseOf(status));
        },
        () => {
          if (live && generationRef.current === generation) setPhase(NOTHING);
        },
      );
    return () => {
      live = false;
      // A wait belongs to the question that started it: a new mode, or a closed drawer, abandons it.
      waitingRef.current?.abort();
    };
  }, [docId, mode]);

  /** Ask for a summary and follow the job to its end (F§9's schedule, F§9's ten minutes). */
  const ask = useCallback(async (): Promise<void> => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    waitingRef.current?.abort();
    const controller = new AbortController();
    waitingRef.current = controller;
    setPhase({ status: "running", result: null, error: null });

    /** Everything this job says, for as long as it is still the question on screen. */
    const current = (status: SummaryStatus): void => {
      if (generationRef.current === generation) setPhase(phaseOf(status));
    };

    try {
      current(await generate(docId, mode));
      current(await aiClient().waitForSummary(docId, mode, { clock: PAGE_CLOCK, onStatus: current, signal: controller.signal }));
    } catch (cause) {
      if (generationRef.current !== generation || controller.signal.aborted) return;
      setPhase({ status: "error", result: null, error: problemOf(cause) });
    } finally {
      if (waitingRef.current === controller) waitingRef.current = null;
    }
  }, [docId, mode]);

  /** File the finished summary and open it: `listen` navigates, so this screen is about to go. */
  const onListen = useCallback((): void => {
    void listen(docId, mode).catch((cause: unknown) => {
      setPhase({ status: "error", result: null, error: problemOf(cause) });
    });
  }, [docId, mode]);

  return (
    <aside aria-label="Summary" className="lectern-summary-drawer">
      <button aria-label="Close summary" className="lectern-summary-drawer__close" onClick={onClose} type="button">
        Close
      </button>
      <SummaryPanel
        error={phase.error}
        mode={mode}
        onGenerate={() => void ask()}
        onListen={onListen}
        onModeChange={setMode}
        result={phase.result}
        status={phase.status}
      />
    </aside>
  );
}
